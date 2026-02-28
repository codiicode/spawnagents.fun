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

    // Cost basis from DB
    const costRow = await db.prepare(
      "SELECT SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as total_bought, SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as total_sold FROM trades WHERE agent_id = ? AND token_address = ?"
    ).bind(agent.id, token.mint).first();

    const costBasis = (costRow?.total_bought || 0) - (costRow?.total_sold || 0);
    if (costBasis <= 0) continue;

    const sellQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
    if (!sellQuote) continue;

    const outSol = parseInt(sellQuote.outAmount) / 1e9;
    const pnlPct = ((outSol - costBasis) / costBasis) * 100;

    // Take profit — patient agents hold longer
    if (pnlPct >= dna.sell_profit_pct * (1 + dna.patience * 0.5)) {
      return await executeSell(sellQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol, reason: 'take profit',
        pnlPct, outSol, tokenAmount: token.amount,
      });
    }

    // Stop loss — risk tolerant agents endure more pain
    if (pnlPct <= -(dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5))) {
      return await executeSell(sellQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol, reason: 'stop loss',
        pnlPct, outSol, tokenAmount: token.amount,
      });
    }
  }

  // --- BUY SIGNALS ---
  // Always keep 0.1 SOL reserve for fees + rent
  const SOL_RESERVE = 0.1;
  const availableSol = solBalance - SOL_RESERVE;
  if (availableSol < 0.01) return { action: 'hold', reason: `insufficient balance (${solBalance.toFixed(3)} SOL, need >${SOL_RESERVE})` };
  if (!candidates || candidates.length === 0) return { action: 'idle', reason: 'no candidates' };

  const tradeAmountSol = Math.min(availableSol, availableSol * (dna.max_position_pct / 100));
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

      // Volume filter
      if (t.volume_24h < (dna.buy_threshold_volume || 500)) return false;

      // Activity filter (txns as proxy for holders)
      if (t.txns_24h < (dna.buy_threshold_holders || 100)) return false;

      // Liquidity minimum: conservative agents need more liquidity
      const minLiq = 5000 + (1 - dna.risk_tolerance) * 45000; // 5k-50k
      if (t.liquidity_usd < minLiq) return false;

      // Age filter: low-risk agents avoid very new pairs
      const minAge = (1 - dna.risk_tolerance) * 24; // 0-24 hours
      if (t.pair_age_hours < minAge) return false;

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

  // Patient agents prefer proven tokens (older pairs)
  if (dna.patience > 0.7 && token.pair_age_hours > 48) {
    score += 1.5;
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
