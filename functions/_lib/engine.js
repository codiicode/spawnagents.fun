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

// Sell slippage: starts at 2%, increases by 2% per failed attempt (max 12%)
async function getSellSlippage(kv, agentId, mint) {
  if (!kv) return 2;
  const key = `sell-fail:${agentId}:${mint}`;
  const fails = parseInt(await kv.get(key) || '0');
  return Math.min(2 + fails * 2, 12);
}
async function trackSellFail(kv, agentId, mint) {
  if (!kv) return;
  const key = `sell-fail:${agentId}:${mint}`;
  const fails = parseInt(await kv.get(key) || '0');
  await kv.put(key, (fails + 1).toString(), { expirationTtl: 86400 });
}
async function clearSellFails(kv, agentId, mint) {
  if (!kv) return;
  await kv.delete(`sell-fail:${agentId}:${mint}`);
}

// candidates = pre-fetched token list from discoverTokens() (shared across agents)
// kv = AGENT_KEYS KV namespace (used for trailing stop peak tracking)
export async function processAgent(agent, db, rpcUrl, agentSecret, agentPubkey, candidates, kv) {
  const dna = JSON.parse(agent.dna);

  const solBalance = await getBalance(agentPubkey, rpcUrl);
  const tokenBalances = await getTokenBalances(agentPubkey, rpcUrl);

  const isDegen = !!dna.degen;

  // --- SELL SIGNALS: check ALL positions, collect results ---
  const sellResults = [];

  for (const token of tokenBalances) {
    const tokenData = await getTokenData(token.mint);
    if (!tokenData) continue;

    // === MINIMUM HOLD TIME ===
    const minHoldMinutes = dna.check_interval_min || 10;
    const holdCheckRow = await db.prepare(
      "SELECT created_at FROM trades WHERE agent_id = ? AND token_address = ? AND action = 'buy' ORDER BY created_at DESC LIMIT 1"
    ).bind(agent.id, token.mint).first();
    if (holdCheckRow) {
      const minutesHeld = (Date.now() - new Date(holdCheckRow.created_at + 'Z').getTime()) / 60000;
      if (minutesHeld < minHoldMinutes) continue;
    }

    // Auto-sell dust: any position worth less than $10
    const posValueUsd = (tokenData.price_usd || 0) * token.amount;
    if (posValueUsd > 0 && posValueUsd < 10) {
      let result;
      if (isDegen) {
        result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
          symbol: tokenData.symbol, reason: `dust sell ($${posValueUsd.toFixed(2)})`,
          pnlPct: 0, tokenAmount: token.amount,
          estimatedSol: (tokenData.price_native || 0) * token.amount,
        }, kv, agent.id);
      } else {
        const dustQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
        if (dustQuote) {
          const dustOutSol = parseInt(dustQuote.outAmount) / 1e9;
          result = await executeSell(dustQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol, reason: `dust sell ($${posValueUsd.toFixed(2)})`,
            pnlPct: 0, outSol: dustOutSol, tokenAmount: token.amount,
          });
        }
      }
      if (result && result.action === 'sell') sellResults.push(result);
      continue;
    }

    // Cost basis — position-aware (handles re-entry after full close)
    const allTrades = await db.prepare(
      "SELECT action, amount_sol, token_amount FROM trades WHERE agent_id = ? AND token_address = ? ORDER BY created_at ASC"
    ).bind(agent.id, token.mint).all();

    // Walk through trades to find the start of the current position
    // When running token balance hits 0 = position was fully closed, reset cost tracking
    let runningTokens = 0;
    let positionStartIdx = 0;
    for (let i = 0; i < allTrades.results.length; i++) {
      const t = allTrades.results[i];
      if (t.action === 'buy') runningTokens += t.token_amount || 0;
      else if (t.action === 'sell') {
        runningTokens -= t.token_amount || 0;
        if (runningTokens <= 0) { runningTokens = 0; positionStartIdx = i + 1; }
      }
    }

    // Sum only trades from current position onward
    let totalBought = 0, totalSold = 0, sellCount = 0;
    for (let i = positionStartIdx; i < allTrades.results.length; i++) {
      const t = allTrades.results[i];
      if (t.action === 'buy') totalBought += t.amount_sol || 0;
      else if (t.action === 'sell') { totalSold += t.amount_sol || 0; sellCount++; }
    }

    if (totalBought <= 0) continue;

    let fullOutSol, fullQuote;
    if (!isDegen) {
      fullQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
      if (!fullQuote) continue;
      fullOutSol = parseInt(fullQuote.outAmount) / 1e9;
    } else {
      fullOutSol = (tokenData.price_native || 0) * token.amount;
      if (fullOutSol <= 0) fullOutSol = totalBought;
    }

    // costRecovered: have we gotten back >= 90% of what we spent?
    // Legacy fallback: old degen sells had amount_sol=0
    const costRecovered = totalSold > 0
      ? totalSold >= totalBought * 0.9
      : (isDegen && sellCount > 0);

    // Adjusted cost: subtract what we already got back from sells
    const adjustedCost = Math.max(0, totalBought - totalSold);
    const costFullyRecovered = adjustedCost <= 0;
    const pnlBasis = costFullyRecovered ? totalBought : adjustedCost;
    const pnlPct = pnlBasis > 0
      ? ((fullOutSol / pnlBasis) - 1) * 100
      : 0;

    // === FIX CRITICAL #2: Cap degen TP at 80% ===
    const tpThreshold = isDegen
      ? Math.min(dna.sell_profit_pct, 80)
      : dna.sell_profit_pct * (1 + dna.patience * 0.5);

    // === PEAK TRACKING ===
    const peakKey = kv ? `peak:${agent.id}:${token.mint}` : null;
    let currentPeak = 0;
    if (kv) {
      const storedPeak = parseFloat(await kv.get(peakKey) || '0');
      currentPeak = Math.max(storedPeak, pnlPct);
      if (pnlPct > storedPeak) {
        await kv.put(peakKey, pnlPct.toString(), { expirationTtl: 86400 * 7 });
      }
    }

    const trailPct = Math.min(20 + dna.patience * 30, 35);

    // Phase 1: Take profit — recover cost basis
    if (!costRecovered && pnlPct >= tpThreshold) {
      const currentValue = fullOutSol;
      const costRemaining = totalBought - totalSold;
      const sellPct = Math.min(0.9, Math.max(0.2, costRemaining / currentValue));
      const partialAmount = token.amount * sellPct;

      let result;
      if (isDegen) {
        result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, `${Math.round(sellPct * 100)}%`, {
          symbol: tokenData.symbol, reason: `take profit (recover cost ${Math.round(sellPct * 100)}%)`,
          pnlPct, tokenAmount: partialAmount,
          estimatedSol: fullOutSol * sellPct,
        }, kv, agent.id);
      } else {
        const partialRaw = Math.floor(parseInt(token.rawAmount) * sellPct).toString();
        const partialQuote = await getJupiterQuote(token.mint, SOL_MINT, partialRaw);
        if (partialQuote) {
          const partialOutSol = parseInt(partialQuote.outAmount) / 1e9;
          result = await executeSell(partialQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol,
            reason: `take profit (recover cost ${Math.round(sellPct * 100)}%)`,
            pnlPct, outSol: partialOutSol, tokenAmount: partialAmount,
          });
        } else {
          result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol, reason: 'take profit (full, no partial quote)',
            pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
          });
        }
      }
      if (result && result.action === 'sell') {
        sellResults.push(result);
        // Store breakeven SL: entry value of remaining tokens
        // If token drops back to this value → sell (never go negative after TP1)
        if (kv) {
          const breakevenVal = totalBought * (1 - sellPct);
          await kv.put(`breakeven:${agent.id}:${token.mint}`, breakevenVal.toString(), { expirationTtl: 86400 * 7 });
        }
      }
      continue;
    }

    // Phase 2: House money — breakeven SL + trailing stop
    if (costRecovered && kv) {
      // === BREAKEVEN SL: if price drops back to entry, sell everything ===
      const breakevenKey = `breakeven:${agent.id}:${token.mint}`;
      const breakevenVal = parseFloat(await kv.get(breakevenKey) || '0');
      if (breakevenVal > 0 && fullOutSol <= breakevenVal) {
        await kv.delete(breakevenKey);
        await kv.delete(peakKey);
        const beReason = `breakeven SL (entry ${breakevenVal.toFixed(4)} SOL, now ${fullOutSol.toFixed(4)} SOL)`;
        let result;
        if (isDegen) {
          result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol, reason: beReason,
            pnlPct, tokenAmount: token.amount,
            estimatedSol: fullOutSol,
          }, kv, agent.id);
        } else {
          result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol, reason: beReason,
            pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
          });
        }
        if (result && result.action === 'sell') sellResults.push(result);
        continue;
      }

      // Track SOL value peak for house money positions
      const valuePeakKey = `vpeak:${agent.id}:${token.mint}`;
      const storedValuePeak = parseFloat(await kv.get(valuePeakKey) || '0');
      const valuePeak = Math.max(storedValuePeak, fullOutSol);
      if (fullOutSol > storedValuePeak) {
        await kv.put(valuePeakKey, fullOutSol.toString(), { expirationTtl: 86400 * 7 });
      }

      const dropFromPeak = valuePeak > 0 ? (1 - fullOutSol / valuePeak) * 100 : 0;

      if (dropFromPeak >= trailPct && valuePeak > 0.01) {
        await kv.delete(peakKey);
        await kv.delete(valuePeakKey);
        await kv.delete(breakevenKey);
        const trailReason = `house money trail (peak ${valuePeak.toFixed(4)} SOL, now ${fullOutSol.toFixed(4)} SOL, drop ${dropFromPeak.toFixed(0)}% >= ${trailPct.toFixed(0)}%)`;
        let result;
        if (isDegen) {
          result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol, reason: trailReason,
            pnlPct, tokenAmount: token.amount,
            estimatedSol: fullOutSol,
          }, kv, agent.id);
        } else {
          result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol, reason: trailReason,
            pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
          });
        }
        if (result && result.action === 'sell') sellResults.push(result);
        continue;
      }
    }

    // === DYNAMIC STOP LOSS (skip for cost-recovered — trailing stop handles those) ===
    if (costRecovered) {
      // House money: no stop loss needed, Phase 2 trailing stop protects value
      continue;
    }
    const rawSL = -(dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5));
    const baseSL = Math.min(rawSL, -12); // ensure at least -12% wide
    let effectiveSL = baseSL;
    if (kv && currentPeak > 30) {
      const protectedPnl = currentPeak * (1 - trailPct / 100);
      if (protectedPnl > effectiveSL) effectiveSL = protectedPnl;
    }

    if (pnlPct <= effectiveSL) {
      if (kv) await kv.delete(peakKey);
      const slReason = effectiveSL > baseSL
        ? `profit-protected SL (peak +${currentPeak.toFixed(0)}%, floor +${effectiveSL.toFixed(0)}%, now +${pnlPct.toFixed(0)}%)`
        : `stop loss (${pnlPct.toFixed(1)}% <= ${effectiveSL.toFixed(1)}%)`;
      let result;
      if (isDegen) {
        result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
          symbol: tokenData.symbol, reason: slReason,
          pnlPct, tokenAmount: token.amount,
          estimatedSol: fullOutSol,
        }, kv, agent.id);
      } else {
        result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
          token: token.mint, symbol: tokenData.symbol, reason: slReason,
          pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
        });
      }
      if (result && result.action === 'sell') sellResults.push(result);
      continue;
    }

    // Stale position — FIX: skip if cost already recovered (house money = let it ride)
    if (holdCheckRow && !costRecovered) {
      const minHeld = (Date.now() - new Date(holdCheckRow.created_at + 'Z').getTime()) / 60000;
      const staleMinutes = 60 + dna.patience * 30;
      if (minHeld >= staleMinutes && Math.abs(pnlPct) < 3) {
        if (kv) await kv.delete(`peak:${agent.id}:${token.mint}`);
        let result;
        if (isDegen) {
          result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol,
            reason: `stale ${Math.round(minHeld)}m, ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
            pnlPct, tokenAmount: token.amount,
            estimatedSol: fullOutSol,
          }, kv, agent.id);
        } else {
          result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol,
            reason: `stale ${Math.round(minHeld)}m, ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
            pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
          });
        }
        if (result && result.action === 'sell') sellResults.push(result);
        continue;
      }
    }
  }

  // --- BUY SIGNALS ---

  // FIX: Scale buy cooldown with aggression (aggressive: 20min, conservative: 60min)
  const buyCooldown = Math.round(20 + (1 - dna.aggression) * 40);
  const lastBuy = await db.prepare(
    "SELECT created_at FROM trades WHERE agent_id = ? AND action = 'buy' ORDER BY created_at DESC LIMIT 1"
  ).bind(agent.id).first();
  if (lastBuy) {
    const minsSinceBuy = (Date.now() - new Date(lastBuy.created_at + 'Z').getTime()) / 60000;
    if (minsSinceBuy < buyCooldown) return { sells: sellResults, action: 'hold', reason: `buy cooldown (${Math.round(buyCooldown - minsSinceBuy)}m left)` };
  }

  const SOL_RESERVE = 0.1;
  const availableSol = solBalance - SOL_RESERVE;

  // FIX: Use availableSol for min trade, lower floor to 10%
  const MIN_TRADE_SOL = Math.max(0.05, availableSol * 0.10);

  // Don't trade if balance is too low — fees will eat everything
  if (availableSol < 0.15) return { sells: sellResults, action: 'hold', reason: `balance too low to trade (${availableSol.toFixed(3)} SOL)` };

  const maxPositions = Math.round(2 + (1 - dna.aggression) * 2);
  const openPositions = tokenBalances.length;

  if (openPositions >= maxPositions) return { sells: sellResults, action: 'hold', reason: `max positions reached (${openPositions}/${maxPositions})` };
  if (availableSol < MIN_TRADE_SOL) return { sells: sellResults, action: 'hold', reason: `insufficient balance (${availableSol.toFixed(3)} SOL)` };
  if (!candidates || candidates.length === 0) return { sells: sellResults, action: 'idle', reason: 'no candidates' };

  // FIX: Distribute capital across remaining slots
  const remainingSlots = maxPositions - openPositions;
  const maxPct = Math.min(dna.max_position_pct, 40) / 100;
  const perSlotAmount = availableSol / remainingSlots;
  const tradeAmountSol = Math.max(MIN_TRADE_SOL, Math.min(perSlotAmount, availableSol * maxPct));
  const tradeAmountLamports = Math.round(tradeAmountSol * 1e9);

  const heldMints = new Set(tokenBalances.map(t => t.mint));

  const recentSells = await db.prepare(
    "SELECT token_address FROM trades WHERE agent_id = ? AND action = 'sell' AND created_at > datetime('now', '-2 hours')"
  ).bind(agent.id).all();
  const recentlySold = new Set(recentSells.results.map(r => r.token_address));

  // FIX: Max 2 buys per token in last 7 days, not all-time
  const buyCountRows = await db.prepare(
    "SELECT token_address, COUNT(*) as cnt FROM trades WHERE agent_id = ? AND action = 'buy' AND created_at > datetime('now', '-7 days') GROUP BY token_address HAVING cnt >= 2"
  ).bind(agent.id).all();
  const maxedTokens = new Set(buyCountRows.results.map(r => r.token_address));

  const filterStats = { total: candidates.length, held: 0, recentSold: 0, maxed: 0, sol: 0, mcap: 0, volume24h: 0, volume1h: 0, momentum: 0, txns: 0, liquidity: 0, tooNew: 0, tooOld: 0, passed: 0 };
  const scored = candidates
    .filter(t => {
      if (heldMints.has(t.address)) { filterStats.held++; return false; }
      if (recentlySold.has(t.address)) { filterStats.recentSold++; return false; }
      if (maxedTokens.has(t.address)) { filterStats.maxed++; return false; }
      if (t.address === SOL_MINT) { filterStats.sol++; return false; }

      const volFloor = isDegen ? 15000 : 50000;
      const vol1hFloor = isDegen ? 3000 : 2000;
      const liqBase = isDegen ? 1000 : 3000;
      const liqScale = isDegen ? 4000 : 22000;
      const minAgeBase = isDegen ? 0.25 : 0.5;
      const minAgeScale = isDegen ? 0.5 : 1.5;
      const maxAge = isDegen ? 12 : 168;

      const minMcap = isDegen ? 10000 : 50000;
      const maxMcap = isDegen ? 150000 : Infinity;
      if ((t.market_cap || 0) < minMcap) { filterStats.mcap++; return false; }
      if ((t.market_cap || 0) > maxMcap) { filterStats.mcap++; return false; }

      if (t.volume_24h < volFloor) { filterStats.volume24h++; return false; }
      if ((t.volume_1h || 0) < vol1hFloor) { filterStats.volume1h++; return false; }

      // Require positive momentum
      const minMomentum = isDegen ? -5 : 0;
      if ((t.price_change_1h || 0) < minMomentum) { filterStats.momentum++; return false; }

      const minTxns = isDegen
        ? Math.max(5, Math.round((dna.buy_threshold_holders || 50) * 0.1))
        : Math.max(30, Math.round((dna.buy_threshold_holders || 100) * 0.3));
      if (t.txns_24h < minTxns) { filterStats.txns++; return false; }

      const minLiq = liqBase + (1 - dna.risk_tolerance) * liqScale;
      if (t.liquidity_usd < minLiq) { filterStats.liquidity++; return false; }

      const minAge = minAgeBase + (1 - dna.risk_tolerance) * minAgeScale;
      if (t.pair_age_hours < minAge) { filterStats.tooNew++; return false; }
      if (t.pair_age_hours > maxAge) { filterStats.tooOld++; return false; }

      filterStats.passed++;
      return true;
    })
    .map(t => ({ ...t, score: scoreToken(t, dna) }))
    .sort((a, b) => b.score - a.score);

  console.log(`Agent ${agent.id} filter: ${JSON.stringify(filterStats)}`);

  const minScore = isDegen ? 4 : 5;
  const strongCandidates = scored.filter(t => t.score >= minScore);
  const skipped = [];
  if (strongCandidates.length === 0 && scored.length > 0) {
    return { sells: sellResults, action: 'hold', reason: `no strong signals (best score ${scored[0]?.score.toFixed(1)}, need ${minScore})` };
  }

  for (const t of strongCandidates.slice(0, 3)) {
    const safety = await checkTokenSafety(t.address, t);
    if (!isDegen && !safety.safe) {
      skipped.push({ token: t.symbol, reason: safety.reasons.join(', ') });
      continue;
    }
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
      const minSafetyScore = Math.round(50 + (1 - dna.risk_tolerance) * 150);
      if (safety.score >= 10 && safety.score < minSafetyScore) {
        skipped.push({ token: t.symbol, reason: `rugcheck ${safety.score} < ${minSafetyScore}` });
        continue;
      }
    }

    // === DEGEN: buy via PumpPortal ===
    if (isDegen) {
      try {
        const ppTx = await getPumpPortalTx(agentPubkey, 'buy', t.address, tradeAmountSol, {
          denominatedInSol: true,
          slippage: 2,
          pool: 'auto',
        });
        if (!ppTx) { skipped.push({ token: t.symbol, reason: 'pumpportal tx failed' }); continue; }

        const txSig = await signAndSendSwapTx(ppTx, agentSecret, rpcUrl);

        // Query on-chain balance to record actual token_amount
        let tokenAmount = 0;
        try {
          const postBuyBalances = await getTokenBalances(agentPubkey, rpcUrl);
          const bought = postBuyBalances.find(b => b.mint === t.address);
          if (bought) tokenAmount = bought.amount;
        } catch {}

        return {
          sells: sellResults,
          action: 'buy',
          token: t.address,
          symbol: t.symbol,
          reason: `DEGEN | score ${t.score.toFixed(1)} | vol $${(t.volume_24h / 1000).toFixed(0)}k`,
          amount_sol: tradeAmountSol,
          token_amount: tokenAmount,
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

      // FIX: Query on-chain balance for actual token_amount (avoids decimal mismatch)
      let tokenAmount = 0;
      try {
        const postBuyBalances = await getTokenBalances(agentPubkey, rpcUrl);
        const bought = postBuyBalances.find(b => b.mint === t.address);
        if (bought) tokenAmount = bought.amount;
      } catch {
        tokenAmount = 0; // fallback — will be corrected on next balance check
      }

      return {
        sells: sellResults,
        action: 'buy',
        token: t.address,
        symbol: t.symbol,
        reason: `score ${t.score.toFixed(1)} | safety ${safety.score} | vol $${(t.volume_24h / 1000).toFixed(0)}k`,
        amount_sol: tradeAmountSol,
        token_amount: tokenAmount,
        tx_signature: txSig,
      };
    } catch (e) {
      skipped.push({ token: t.symbol, reason: `swap error: ${e.message}` });
      continue;
    }
  }

  return { sells: sellResults, action: 'hold', reason: `no signals (${scored.length} candidates filtered)`, skipped };
}

// ============================================================
// SCORING — improved with caps and penalties
// ============================================================

function scoreToken(token, dna) {
  let score = 0;

  // Volume relative to market cap (healthy ratio = 0.5-2x, wash trading > 10x)
  const volMcapRatio = token.market_cap > 0 ? token.volume_24h / token.market_cap : 0;
  score += Math.min(volMcapRatio * 2, 3);
  if (volMcapRatio > 10) score -= 2; // wash trading signal

  // Raw volume bonus (max 3 pts)
  score += Math.min(token.volume_24h / 200000, 3);

  // Momentum — capped to prevent chasing extreme pumps
  if (dna.aggression > 0.6) {
    score += Math.min(Math.max(0, token.price_change_1h), 50) * 0.08; // max +4
    score += Math.min(Math.max(0, token.price_change_5m), 20) * 0.1;  // max +2
  } else {
    score += Math.min(Math.max(0, token.price_change_24h), 50) * 0.03;
    if (Math.abs(token.price_change_1h) > 30) score -= 2;
  }

  // Penalize overextended pumps (likely to dump)
  if ((token.price_change_1h || 0) > 100) score -= 3;

  // Penalize negative momentum
  if ((token.price_change_1h || 0) < -10) score -= 3;
  if ((token.price_change_1h || 0) < -5) score -= 1;

  // Buy pressure
  if (token.buy_sell_ratio_1h > 1.2) score += 2;
  if (token.buy_sell_ratio_1h > 2.0) score += 1;
  if (token.buy_sell_ratio_1h < 0.8) score -= 2;

  // Volume velocity — is volume accelerating?
  const avgHourlyVol = token.volume_24h / 24;
  if (avgHourlyVol > 0) {
    const velRatio = (token.volume_1h || 0) / avgHourlyVol;
    if (velRatio > 3) score += 2;  // volume accelerating
    if (velRatio < 0.3) score -= 2; // volume dying
  }

  // Activity (max 3 pts)
  score += Math.min(token.txns_1h / 50, 3);

  // Liquidity bonus (max 2 pts)
  score += Math.min(token.liquidity_usd / 50000, 2);

  // Risk-tolerant agents get bonus for newer tokens
  if (dna.risk_tolerance > 0.7 && token.pair_age_hours < 12) score += 2;

  // Patient agents prefer tokens that survived the first few hours
  if (dna.patience > 0.7 && token.pair_age_hours > 6) score += 1;

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

// Degen sell via PumpPortal
async function executeDegenSell(pubkey, secret, rpcUrl, mint, _label, info, kv, agentId) {
  const slippage = await getSellSlippage(kv, agentId, mint);
  try {
    const ppTx = await getPumpPortalTx(pubkey, 'sell', mint, info.tokenAmount, {
      denominatedInSol: false,
      slippage,
      pool: 'auto',
    });
    if (!ppTx) {
      await trackSellFail(kv, agentId, mint);
      return { action: 'hold', reason: `pumpportal sell tx failed (slippage ${slippage}%)` };
    }

    const txSig = await signAndSendSwapTx(ppTx, secret, rpcUrl);
    await clearSellFails(kv, agentId, mint);
    return {
      action: 'sell',
      token: mint,
      symbol: info.symbol,
      reason: `DEGEN | ${info.reason}`,
      pnl_pct: info.pnlPct,
      amount_sol: info.estimatedSol || 0,
      token_amount: info.tokenAmount,
      tx_signature: txSig,
    };
  } catch (e) {
    console.error(`Degen sell failed for ${info.symbol} (slippage ${slippage}%):`, e.message);
    await trackSellFail(kv, agentId, mint);
    return { action: 'hold', reason: `degen sell failed (slippage ${slippage}%): ${e.message}` };
  }
}
