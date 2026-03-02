import { getTokenData, checkTokenSafety } from './market-data.js';
import {
  SOL_MINT,
  getBalance,
  getTokenBalances,
  getJupiterQuote,
  getJupiterSwapTx,
  signAndSendSwapTx,
  getPumpPortalTx,
} from './solana.js';

// candidates = pre-fetched token list from discoverTokens() (shared across agents)
// kv = AGENT_KEYS KV namespace (used for trailing stop peak tracking)
export async function processAgent(agent, db, rpcUrl, agentSecret, agentPubkey, candidates, kv) {
  const dna = JSON.parse(agent.dna);

  const solBalance = await getBalance(agentPubkey, rpcUrl);
  const tokenBalances = await getTokenBalances(agentPubkey, rpcUrl);

  const isDegen = !!dna.degen;

  // --- PORTFOLIO VALUE: track total value for live PnL ---
  let totalTokenValueSol = 0;

  // --- SELL SIGNALS: check existing positions ---
  for (const token of tokenBalances) {
    const tokenData = await getTokenData(token.mint);
    if (!tokenData) continue;

    // Auto-sell dust: any position worth less than $10
    const posValueUsd = (tokenData.price_usd || 0) * token.amount;
    if (posValueUsd > 0 && posValueUsd < 10) {
      if (isDegen) {
        return await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
          symbol: tokenData.symbol, reason: `dust sell ($${posValueUsd.toFixed(2)})`,
          pnlPct: 0, tokenAmount: token.amount,
        });
      }
      const dustQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
      if (dustQuote) {
        const dustOutSol = parseInt(dustQuote.outAmount) / 1e9;
        return await executeSell(dustQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol, reason: `dust sell ($${posValueUsd.toFixed(2)})`,
          pnlPct: 0, outSol: dustOutSol, tokenAmount: token.amount,
        });
      }
    }

    // Cost basis from DB — use average entry price for stable PnL%
    const costRow = await db.prepare(
      "SELECT SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as total_bought, SUM(CASE WHEN action='buy' THEN token_amount ELSE 0 END) as total_tokens_bought FROM trades WHERE agent_id = ? AND token_address = ?"
    ).bind(agent.id, token.mint).first();

    const totalBought = costRow?.total_bought || 0;
    let totalTokensBought = costRow?.total_tokens_bought || 0;
    if (totalBought <= 0) continue;

    // Degen buys don't record token_amount — use on-chain balance as fallback
    if (totalTokensBought <= 0) totalTokensBought = token.amount;

    // Average entry price per token (in SOL)
    const avgEntryPrice = totalBought / totalTokensBought;

    let fullOutSol, fullQuote;
    if (!isDegen) {
      fullQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
      if (!fullQuote) continue;
      fullOutSol = parseInt(fullQuote.outAmount) / 1e9;
    } else {
      // Degen: use DexScreener native price (SOL) for accurate PnL
      fullOutSol = (tokenData.price_native || 0) * token.amount;
      if (fullOutSol <= 0) fullOutSol = totalBought; // fallback: assume breakeven
    }

    // Track token value for portfolio PnL
    totalTokenValueSol += fullOutSol;

    // PnL% based on SOL in vs SOL out (same unit for both degen and normal)
    const pnlPct = totalBought > 0 ? ((fullOutSol / totalBought) - 1) * 100 : 0;

    // === TAKE PROFIT + TRAILING STOP ===
    // Phase 1: First TP hit → sell enough to recover cost basis (insatsen)
    // Phase 2: Rest is "house money" → trailing stop from peak PnL
    const tpThreshold = dna.sell_profit_pct * (1 + dna.patience * 0.5);

    // Check if cost basis already recovered (previous sells >= totalBought)
    const sellRow = await db.prepare(
      "SELECT SUM(amount_sol) as total_sold, COUNT(*) as sell_count FROM trades WHERE agent_id = ? AND token_address = ? AND action = 'sell'"
    ).bind(agent.id, token.mint).first();
    const totalSold = sellRow?.total_sold || 0;
    const sellCount = sellRow?.sell_count || 0;
    // For degens: amount_sol is 0 on sells, so check sell_count > 0 as proxy
    const costRecovered = isDegen ? sellCount > 0 : totalSold >= totalBought * 0.9;

    // === PEAK TRACKING (always active) ===
    // Track peak PnL for all positions so trailing stop can protect profits
    const peakKey = kv ? `peak:${agent.id}:${token.mint}` : null;
    let currentPeak = 0;
    if (kv) {
      const storedPeak = parseFloat(await kv.get(peakKey) || '0');
      currentPeak = Math.max(storedPeak, pnlPct);
      if (pnlPct > storedPeak) {
        await kv.put(peakKey, pnlPct.toString(), { expirationTtl: 86400 * 7 });
      }
    }

    // Trailing stop width: patient agents trail wider (40-50%), aggressive tighter (20-30%)
    const trailPct = 20 + dna.patience * 30;

    if (!costRecovered && pnlPct >= tpThreshold) {
      // Phase 1: Sell enough to recover cost basis
      const currentValue = fullOutSol;
      const costRemaining = totalBought - totalSold;
      const sellPct = Math.min(0.9, Math.max(0.2, costRemaining / currentValue));
      const partialAmount = token.amount * sellPct;

      if (isDegen) {
        return await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, `${Math.round(sellPct * 100)}%`, {
          symbol: tokenData.symbol, reason: `take profit (recover cost ${Math.round(sellPct * 100)}%)`,
          pnlPct, tokenAmount: partialAmount,
        });
      }

      const partialRaw = Math.floor(parseInt(token.rawAmount) * sellPct).toString();
      const partialQuote = await getJupiterQuote(token.mint, SOL_MINT, partialRaw);
      if (!partialQuote) {
        return await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol, reason: 'take profit (full, no partial quote)',
          pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
        });
      }

      const partialOutSol = parseInt(partialQuote.outAmount) / 1e9;
      return await executeSell(partialQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol,
        reason: `take profit (recover cost ${Math.round(sellPct * 100)}%)`,
        pnlPct, outSol: partialOutSol, tokenAmount: partialAmount,
      });
    }

    // Phase 2: Cost recovered — trailing stop on house money
    if (costRecovered && kv && currentPeak > tpThreshold) {
      const trailThreshold = currentPeak * (1 - trailPct / 100);

      if (pnlPct < trailThreshold && pnlPct > 0) {
        await kv.delete(peakKey);

        if (isDegen) {
          return await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol,
            reason: `trailing stop (peak +${currentPeak.toFixed(0)}%, now +${pnlPct.toFixed(0)}%, trail ${trailPct.toFixed(0)}%)`,
            pnlPct, tokenAmount: token.amount,
          });
        }
        return await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol,
          reason: `trailing stop (peak +${currentPeak.toFixed(0)}%, now +${pnlPct.toFixed(0)}%, trail ${trailPct.toFixed(0)}%)`,
          pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
        });
      }
    }

    // === DYNAMIC STOP LOSS ===
    // Original SL from DNA
    const baseSL = -(dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5));
    // If position has been significantly profitable, raise SL to protect gains
    // Kicks in when peak > 30%, locks in (peak - trailWidth) as minimum SL
    let effectiveSL = baseSL;
    if (kv && currentPeak > 30) {
      const protectedPnl = currentPeak * (1 - trailPct / 100);
      // Only raise SL, never lower it below the DNA SL
      if (protectedPnl > effectiveSL) {
        effectiveSL = protectedPnl;
      }
    }

    // Stop loss — using dynamic SL (raised if position was profitable)
    if (pnlPct <= effectiveSL) {
      if (kv) await kv.delete(peakKey);
      const slReason = effectiveSL > baseSL
        ? `profit-protected SL (peak +${currentPeak.toFixed(0)}%, floor +${effectiveSL.toFixed(0)}%, now +${pnlPct.toFixed(0)}%)`
        : 'stop loss';
      if (isDegen) {
        return await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
          symbol: tokenData.symbol, reason: slReason,
          pnlPct, tokenAmount: token.amount,
        });
      }
      return await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol, reason: slReason,
        pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
      });
    }

    // Stale position — coin going nowhere, sell and find something better
    const lastBuyRow = await db.prepare(
      "SELECT created_at FROM trades WHERE agent_id = ? AND token_address = ? AND action = 'buy' ORDER BY created_at DESC LIMIT 1"
    ).bind(agent.id, token.mint).first();
    if (lastBuyRow) {
      const minHeld = (Date.now() - new Date(lastBuyRow.created_at + 'Z').getTime()) / 60000;
      const staleMinutes = 30 + dna.patience * 30; // 30-60 min based on patience
      if (minHeld >= staleMinutes && Math.abs(pnlPct) < 5) {
        if (kv) await kv.delete(`peak:${agent.id}:${token.mint}`);
        if (isDegen) {
          return await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol,
            reason: `stale ${Math.round(minHeld)}m, ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
            pnlPct, tokenAmount: token.amount,
          });
        }
        return await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol,
          reason: `stale ${Math.round(minHeld)}m, ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
          pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
        });
      }
    }
  }

  // --- BUY SIGNALS ---

  // Buy cooldown: 20 min since last BUY (sells are always allowed above)
  const lastBuy = await db.prepare(
    "SELECT created_at FROM trades WHERE agent_id = ? AND action = 'buy' ORDER BY created_at DESC LIMIT 1"
  ).bind(agent.id).first();
  if (lastBuy) {
    const minsSinceBuy = (Date.now() - new Date(lastBuy.created_at + 'Z').getTime()) / 60000;
    if (minsSinceBuy < 20) return { action: 'hold', reason: `buy cooldown (${Math.round(20 - minsSinceBuy)}m left)` };
  }

  const SOL_RESERVE = 0.1;
  const availableSol = solBalance - SOL_RESERVE;
  const initialCap = agent.initial_capital || 1;

  // Minimum trade = 15% of current balance (scales down as agent loses, up as it wins)
  const MIN_TRADE_SOL = Math.max(0.07, solBalance * 0.15);

  // Max open positions: aggressive agents concentrate (2-3), conservative spread (3-4)
  const maxPositions = Math.round(2 + (1 - dna.aggression) * 2); // 2-4
  const openPositions = tokenBalances.length;

  if (openPositions >= maxPositions) return { action: 'hold', reason: `max positions reached (${openPositions}/${maxPositions})` };
  if (availableSol < MIN_TRADE_SOL) return { action: 'hold', reason: `insufficient balance (${availableSol.toFixed(3)} SOL, min trade ${MIN_TRADE_SOL.toFixed(2)})` };
  if (!candidates || candidates.length === 0) return { action: 'idle', reason: 'no candidates' };

  // Cap position size: max 40% of balance (prevents surgeon-style 85% overbets)
  const maxPct = Math.min(dna.max_position_pct, 40) / 100;
  const tradeAmountSol = Math.max(MIN_TRADE_SOL, Math.min(availableSol, availableSol * maxPct));
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
  const filterStats = { total: candidates.length, held: 0, recentSold: 0, maxed: 0, sol: 0, mcap: 0, volume24h: 0, volume1h: 0, txns: 0, liquidity: 0, tooNew: 0, tooOld: 0, passed: 0 };
  const scored = candidates
    .filter(t => {
      if (heldMints.has(t.address)) { filterStats.held++; return false; }
      if (recentlySold.has(t.address)) { filterStats.recentSold++; return false; }
      if (maxedTokens.has(t.address)) { filterStats.maxed++; return false; }
      if (t.address === SOL_MINT) { filterStats.sol++; return false; }

      // Degen agents: DNA-driven filters with low floors for pump.fun
      // Normal agents: higher hardcoded floors
      const volFloor = isDegen ? 15000 : 50000;
      const vol1hFloor = isDegen ? 3000 : 2000;
      const liqBase = isDegen ? 1000 : 3000;
      const liqScale = isDegen ? 4000 : 22000;
      const minAgeBase = isDegen ? 0.05 : 0.5; // degen: ~3 min minimum
      const minAgeScale = isDegen ? 0.2 : 1.5;
      const maxAge = isDegen ? 12 : 168; // degen: 12h max

      // Market cap filter
      const minMcap = isDegen ? 10000 : 50000;
      const maxMcap = isDegen ? 150000 : Infinity;
      if ((t.market_cap || 0) < minMcap) { filterStats.mcap++; return false; }
      if ((t.market_cap || 0) > maxMcap) { filterStats.mcap++; return false; }

      // Volume filter
      if (t.volume_24h < volFloor) { filterStats.volume24h++; return false; }

      // Recent volume — must be actively trading NOW
      if ((t.volume_1h || 0) < vol1hFloor) { filterStats.volume1h++; return false; }

      // Activity filter (txns as proxy for holders)
      const minTxns = isDegen
        ? Math.max(5, Math.round((dna.buy_threshold_holders || 50) * 0.1))
        : Math.max(30, Math.round((dna.buy_threshold_holders || 100) * 0.3));
      if (t.txns_24h < minTxns) { filterStats.txns++; return false; }

      // Liquidity minimum: conservative agents need more liquidity
      const minLiq = liqBase + (1 - dna.risk_tolerance) * liqScale;
      if (t.liquidity_usd < minLiq) { filterStats.liquidity++; return false; }

      // Age filter
      const minAge = minAgeBase + (1 - dna.risk_tolerance) * minAgeScale;
      if (t.pair_age_hours < minAge) { filterStats.tooNew++; return false; }

      // Max age
      if (t.pair_age_hours > maxAge) { filterStats.tooOld++; return false; }

      filterStats.passed++;
      return true;
    })
    .map(t => ({ ...t, score: scoreToken(t, dna) }))
    .sort((a, b) => b.score - a.score);

  console.log(`Agent ${agent.id} filter: ${JSON.stringify(filterStats)}`);

  // Try top 3 scored candidates — require minimum score to avoid weak entries
  const minScore = isDegen ? 4 : 5;
  const strongCandidates = scored.filter(t => t.score >= minScore);
  const skipped = [];
  if (strongCandidates.length === 0 && scored.length > 0) {
    return { action: 'hold', reason: `no strong signals (best score ${scored[0]?.score.toFixed(1)}, need ${minScore})` };
  }
  for (const t of strongCandidates.slice(0, 3)) {
    // Buy probability — be selective, not trigger-happy
    const buyChance = isDegen ? 0.6 : (0.3 + dna.aggression * 0.3); // degen: 60%, normal: 30-60%
    if (Math.random() > buyChance) { skipped.push({ token: t.symbol, reason: 'rng skip' }); continue; }

    // Safety check
    const safety = await checkTokenSafety(t.address, t);
    if (!isDegen && !safety.safe) {
      skipped.push({ token: t.symbol, reason: safety.reasons.join(', ') });
      continue;
    }
    // Degen agents: skip on critical rug signals (not just "flagged as rugged")
    if (isDegen) {
      const criticalReasons = safety.reasons.filter(r =>
        r.includes('rugged') ||
        r.includes('mint authority') ||
        r.includes('freeze authority') ||
        r.includes('top 10 holders') ||
        r.includes('transfer fee')
      );
      if (criticalReasons.length > 0) {
        skipped.push({ token: t.symbol, reason: criticalReasons.join(', ') });
        continue;
      }
    }

    if (!isDegen) {
      // Risk-tolerant agents accept lower RugCheck scores
      const minScore = Math.round(50 + (1 - dna.risk_tolerance) * 150); // 50-200
      if (safety.score >= 10 && safety.score < minScore) {
        skipped.push({ token: t.symbol, reason: `rugcheck ${safety.score} < ${minScore}` });
        continue;
      }
    }

    // === DEGEN: buy via PumpPortal ===
    if (isDegen) {
      try {
        const ppTx = await getPumpPortalTx(agentPubkey, 'buy', t.address, tradeAmountSol, {
          denominatedInSol: true,
          slippage: 20,
          pool: 'auto',
        });
        if (!ppTx) { skipped.push({ token: t.symbol, reason: 'pumpportal tx failed' }); continue; }

        const txSig = await signAndSendSwapTx(ppTx, agentSecret, rpcUrl);
        return {
          action: 'buy',
          token: t.address,
          symbol: t.symbol,
          reason: `DEGEN | score ${t.score.toFixed(1)} | vol $${(t.volume_24h / 1000).toFixed(0)}k`,
          amount_sol: tradeAmountSol,
          token_amount: 0, // PumpPortal doesn't return outAmount in the tx
          tx_signature: txSig,
        };
      } catch (e) {
        skipped.push({ token: t.symbol, reason: `pumpportal error: ${e.message}` });
        continue;
      }
    }

    // === NORMAL: buy via Jupiter ===
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

// Degen sell via PumpPortal (pool: auto covers both pump.fun and raydium)
async function executeDegenSell(pubkey, secret, rpcUrl, mint, _label, info) {
  try {
    const ppTx = await getPumpPortalTx(pubkey, 'sell', mint, info.tokenAmount, {
      denominatedInSol: false,
      slippage: 20,
      pool: 'auto',
    });
    if (!ppTx) return { action: 'hold', reason: 'pumpportal sell tx failed' };

    const txSig = await signAndSendSwapTx(ppTx, secret, rpcUrl);
    return {
      action: 'sell',
      token: mint,
      symbol: info.symbol,
      reason: `DEGEN | ${info.reason}`,
      pnl_pct: info.pnlPct,
      amount_sol: 0, // exact amount unknown from PumpPortal
      token_amount: info.tokenAmount,
      tx_signature: txSig,
    };
  } catch (e) {
    console.error(`Degen sell failed for ${info.symbol}:`, e.message);
    return { action: 'hold', reason: `degen sell failed: ${e.message}` };
  }
}
