import { getTokenData, checkTokenSafety } from './market-data.js';
import {
  SOL_MINT,
  getBalance,
  getTokenBalances,
  getJupiterQuote,
  getJupiterSwapTx,
  signAndSendSwapTx,
} from './solana.js';

// candidates = pre-fetched token list from discoverTokens() (shared across agents)
export async function processAgent(agent, db, rpcUrl, agentSecret, agentPubkey, candidates) {
  const dna = JSON.parse(agent.dna);

  const solBalance = await getBalance(agentPubkey, rpcUrl);
  const tokenBalances = await getTokenBalances(agentPubkey, rpcUrl);

  // --- SELL SIGNALS: check existing positions ---
  for (const token of tokenBalances) {
    const tokenData = await getTokenData(token.mint);
    if (!tokenData) continue;

    // Auto-sell dust: any position worth less than $10
    const posValueUsd = (tokenData.price_usd || 0) * token.amount;
    if (posValueUsd > 0 && posValueUsd < 10) {
      const dustQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
      if (dustQuote) {
        const dustOutSol = parseInt(dustQuote.outAmount) / 1e9;
        return await executeSell(dustQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol, reason: `dust sell ($${posValueUsd.toFixed(2)})`,
          pnlPct: 0, outSol: dustOutSol, tokenAmount: token.amount,
        });
      }
    }

    // Cost basis from DB
    const costRow = await db.prepare(
      "SELECT SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as total_bought, SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as total_sold FROM trades WHERE agent_id = ? AND token_address = ?"
    ).bind(agent.id, token.mint).first();

    const costBasis = (costRow?.total_bought || 0) - (costRow?.total_sold || 0);
    if (costBasis <= 0) continue;

    // Quote full position to calculate PnL
    const fullQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
    if (!fullQuote) continue;

    const fullOutSol = parseInt(fullQuote.outAmount) / 1e9;
    const pnlPct = ((fullOutSol - costBasis) / costBasis) * 100;

    // Take profit — patient agents hold longer, sell PARTIAL
    if (pnlPct >= dna.sell_profit_pct * (1 + dna.patience * 0.5)) {
      // Aggressive agents sell less (let profits ride), conservative sell more
      const sellPct = 0.7 - (dna.aggression * 0.4); // 30-70%
      const partialRaw = Math.floor(parseInt(token.rawAmount) * sellPct).toString();
      const partialAmount = token.amount * sellPct;

      // Get quote for partial amount
      const partialQuote = await getJupiterQuote(token.mint, SOL_MINT, partialRaw);
      if (!partialQuote) {
        // Fallback: sell full position if partial quote fails
        return await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol, reason: 'take profit (full)',
          pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
        });
      }

      const partialOutSol = parseInt(partialQuote.outAmount) / 1e9;
      return await executeSell(partialQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol,
        reason: `take profit ${Math.round(sellPct * 100)}%`,
        pnlPct, outSol: partialOutSol, tokenAmount: partialAmount,
      });
    }

    // Stop loss — risk tolerant agents endure more pain, sell 100%
    if (pnlPct <= -(dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5))) {
      return await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol, reason: 'stop loss',
        pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
      });
    }
  }

  // --- BUY SIGNALS ---
  // Always keep 0.1 SOL reserve for fees + rent
  const SOL_RESERVE = 0.1;
  const availableSol = solBalance - SOL_RESERVE;
  const MIN_TRADE_SOL = 0.1;
  if (availableSol < MIN_TRADE_SOL) return { action: 'hold', reason: `insufficient balance (${solBalance.toFixed(3)} SOL, need >${SOL_RESERVE + MIN_TRADE_SOL})` };
  if (!candidates || candidates.length === 0) return { action: 'idle', reason: 'no candidates' };

  const tradeAmountSol = Math.max(MIN_TRADE_SOL, Math.min(availableSol, availableSol * (dna.max_position_pct / 100)));
  const tradeAmountLamports = Math.round(tradeAmountSol * 1e9);

  const heldMints = new Set(tokenBalances.map(t => t.mint));

  // Avoid re-buying tokens recently sold
  const recentSells = await db.prepare(
    "SELECT token_address FROM trades WHERE agent_id = ? AND action = 'sell' AND created_at > datetime('now', '-2 hours')"
  ).bind(agent.id).all();
  const recentlySold = new Set(recentSells.results.map(r => r.token_address));

  // Max 2 buys per token
  const buyCountRows = await db.prepare(
    "SELECT token_address, COUNT(*) as cnt FROM trades WHERE agent_id = ? AND action = 'buy' GROUP BY token_address HAVING cnt >= 2"
  ).bind(agent.id).all();
  const maxedTokens = new Set(buyCountRows.results.map(r => r.token_address));

  // Filter and score candidates based on DNA
  const scored = candidates
    .filter(t => {
      if (heldMints.has(t.address)) return false;
      if (recentlySold.has(t.address)) return false;
      if (maxedTokens.has(t.address)) return false;
      if (t.address === SOL_MINT) return false;

      // Volume filter — minimum $10k/24h
      if (t.volume_24h < Math.max(10000, dna.buy_threshold_volume || 500)) return false;

      // Activity filter (txns as proxy for holders)
      if (t.txns_24h < (dna.buy_threshold_holders || 100)) return false;

      // Liquidity minimum: conservative agents need more liquidity
      const minLiq = 5000 + (1 - dna.risk_tolerance) * 45000; // 5k-50k
      if (t.liquidity_usd < minLiq) return false;

      // Age filter: low-risk agents avoid very new pairs
      const minAge = (1 - dna.risk_tolerance) * 6; // 0-6 hours
      if (t.pair_age_hours < minAge) return false;

      // Max age: 7 days — older coins have little upside
      if (t.pair_age_hours > 168) return false;

      return true;
    })
    .map(t => ({ ...t, score: scoreToken(t, dna) }))
    .sort((a, b) => b.score - a.score);

  // Try top 5 scored candidates, safety check before buying
  const skipped = [];
  for (const t of scored.slice(0, 5)) {
    // Aggressive agents buy more readily
    const buyChance = 0.5 + dna.aggression * 0.4; // 50-90%
    if (Math.random() > buyChance) { skipped.push({ token: t.symbol, reason: 'rng skip' }); continue; }

    // Safety check via RugCheck + heuristics
    const safety = await checkTokenSafety(t.address, t);
    if (!safety.safe) {
      skipped.push({ token: t.symbol, reason: safety.reasons.join(', ') });
      continue;
    }

    // Risk-tolerant agents accept lower RugCheck scores
    // Scores < 10 = unranked token, skip this check
    const minScore = Math.round(50 + (1 - dna.risk_tolerance) * 150); // 50-200
    if (safety.score >= 10 && safety.score < minScore) {
      skipped.push({ token: t.symbol, reason: `rugcheck ${safety.score} < ${minScore}` });
      continue;
    }

    const buyQuote = await getJupiterQuote(SOL_MINT, t.address, tradeAmountLamports);
    if (!buyQuote) { skipped.push({ token: t.symbol, reason: 'quote failed' }); continue; }

    const swapTx = await getJupiterSwapTx(buyQuote, agentPubkey);
    if (!swapTx) { skipped.push({ token: t.symbol, reason: 'swap tx failed' }); continue; }

    try {
      const txSig = await signAndSendSwapTx(swapTx, agentSecret, rpcUrl);
      return {
        action: 'buy',
        token: t.address,
        symbol: t.symbol,
        reason: `score ${t.score.toFixed(1)} | safety ${safety.score} | vol $${(t.volume_24h / 1000).toFixed(0)}k`,
        amount_sol: tradeAmountSol,
        token_amount: parseInt(buyQuote.outAmount) / 1e6,
        tx_signature: txSig,
      };
    } catch (e) {
      skipped.push({ token: t.symbol, reason: `swap error: ${e.message}` });
      continue;
    }
  }

  return { action: 'hold', reason: `no signals (${scored.length} candidates filtered)`, skipped };
}

// ============================================================
// SCORING — each agent's DNA produces a different ranking
// ============================================================

function scoreToken(token, dna) {
  let score = 0;

  // Volume score (normalized, max 5 pts)
  score += Math.min(token.volume_24h / 100000, 5);

  // Momentum — aggressive agents love pumps, patient agents prefer stability
  if (dna.aggression > 0.6) {
    // Short-term pump chasers
    score += Math.max(0, token.price_change_1h) * 0.1;
    score += Math.max(0, token.price_change_5m) * 0.2;
  } else {
    // Steady growers, penalize extreme volatility
    score += Math.max(0, token.price_change_24h) * 0.03;
    if (Math.abs(token.price_change_1h) > 30) score -= 2;
  }

  // Buy pressure (more buys than sells = bullish)
  if (token.buy_sell_ratio_1h > 1.2) score += 2;
  if (token.buy_sell_ratio_1h > 2.0) score += 1;

  // Activity (txns as engagement proxy, max 3 pts)
  score += Math.min(token.txns_1h / 50, 3);

  // Liquidity bonus (max 3 pts)
  score += Math.min(token.liquidity_usd / 50000, 3);

  // Risk-tolerant agents get bonus for newer, riskier tokens
  if (dna.risk_tolerance > 0.7 && token.pair_age_hours < 12) {
    score += 2;
  }

  // Patient agents prefer tokens that survived the first few hours
  if (dna.patience > 0.7 && token.pair_age_hours > 6) {
    score += 1;
  }

  return score;
}

// ============================================================
// SELL EXECUTION
// ============================================================

async function executeSell(quote, pubkey, secret, rpcUrl, info) {
  const swapTx = await getJupiterSwapTx(quote, pubkey);
  if (!swapTx) return { action: 'hold', reason: 'swap tx failed' };

  try {
    const txSig = await signAndSendSwapTx(swapTx, secret, rpcUrl);
    return {
      action: 'sell',
      token: info.token,
      symbol: info.symbol,
      reason: info.reason,
      pnl_pct: info.pnlPct,
      amount_sol: info.outSol,
      token_amount: info.tokenAmount,
      tx_signature: txSig,
    };
  } catch (e) {
    console.error(`Sell failed for ${info.symbol}:`, e.message);
    return { action: 'hold', reason: 'sell tx failed' };
  }
}
