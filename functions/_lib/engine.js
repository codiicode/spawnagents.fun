import { getTokenData, checkTokenSafety } from './market-data.js';
import {
  SOL_MINT,
  getBalance,
  getTokenBalances,
  getJupiterQuote,
  getJupiterSwapTx,
  signAndSendSwapTx,
  getPumpPortalTx,
  getUniqueTraders,
  getHolderConcentration,
} from './solana.js';

// Sell slippage: starts at 2%, increases by 2% per failed attempt (max 12%)
async function getSellSlippage(kv, agentId, mint, emergency = false) {
  if (!kv) return emergency ? 40 : 5;
  const key = `sell-fail:${agentId}:${mint}`;
  const fails = parseInt(await kv.get(key) || '0');
  const maxSlip = emergency ? 50 : 20;
  const baseSlip = emergency ? 40 : 5;
  return Math.min(baseSlip + fails * 5, maxSlip);
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
export async function processAgent(agent, db, rpcUrl, agentSecret, agentPubkey, candidates, kv, marketRegime = null) {
  const dna = JSON.parse(agent.dna);
  const meta = agent.meta ? JSON.parse(agent.meta) : {};
  const sellStrategy = meta.sell_strategy || 'phased'; // phased | full | trail

  _currentKv = kv;
  _currentAgentId = agent.id;

  const solBalance = await getBalance(agentPubkey, rpcUrl);
  const tokenBalances = await getTokenBalances(agentPubkey, rpcUrl);
  const _debug = { tokens: tokenBalances.length, mints: tokenBalances.map(t => t.mint.substring(0,12)), sellSkips: [] };

  const isDegen = !!dna.degen;

  // --- SELL SIGNALS: check ALL positions, collect results ---
  const sellResults = [];

  for (const token of tokenBalances) {
    const tokenData = await getTokenData(token.mint);
    if (!tokenData) {
      // No DexScreener data = dead/unlisted token → emergency sell
      let result;
      if (isDegen) {
        result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
          symbol: token.mint.substring(0,8), reason: 'no market data (dead/unlisted token)',
          pnlPct: -100, tokenAmount: token.amount,
          estimatedSol: 0,
        }, kv, agent.id, true);
      } else {
        // Try Jupiter, PumpPortal fallback
        const fallbackQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount).catch(() => null);
        if (fallbackQuote) {
          const outSol = parseInt(fallbackQuote.outAmount) / 1e9;
          result = await executeSell(fallbackQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: token.mint.substring(0,8), reason: 'no market data (dead/unlisted token)',
            pnlPct: -100, outSol, tokenAmount: token.amount,
          });
        }
        if (!result || result.action !== 'sell') {
          result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: token.mint.substring(0,8), reason: 'no market data (dead/unlisted token)',
            pnlPct: -100, tokenAmount: token.amount, estimatedSol: 0,
          }, kv, agent.id, true);
        }
      }
      if (result && result.action === 'sell') sellResults.push(result);
      else _debug.sellSkips.push({ mint: token.mint.substring(0,12), reason: `no-data sell failed: ${result?.reason || 'no result'}` });
      continue;
    }

    // === EMERGENCY RUG SELL — bypasses hold time ===
    const isRug = (
      (tokenData.liquidity_usd > 0 && tokenData.liquidity_usd < 1000) ||
      (tokenData.price_change_1h < -60) ||
      (tokenData.volume_1h > 0 && tokenData.liquidity_usd > 0 && tokenData.volume_1h / tokenData.liquidity_usd > 15) ||
      (tokenData.market_cap > 0 && tokenData.liquidity_usd > 0 && tokenData.market_cap / tokenData.liquidity_usd > 50)
    );
    if (isRug) {
      const rugReason = `EMERGENCY RUG SELL (liq ${Math.round(tokenData.liquidity_usd)}, 1h ${(tokenData.price_change_1h || 0).toFixed(0)}%, mc/liq ${tokenData.liquidity_usd > 0 ? (tokenData.market_cap / tokenData.liquidity_usd).toFixed(0) : '?'}x)`;
      let result;
      if (isDegen) {
        result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
          symbol: tokenData.symbol, reason: rugReason,
          pnlPct: 0, tokenAmount: token.amount,
          estimatedSol: (tokenData.price_native || 0) * token.amount,
        }, kv, agent.id, true);
      } else {
        // Try Jupiter first, PumpPortal fallback (Jupiter often rate-limited in Workers)
        const rugQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount).catch(() => null);
        if (rugQuote) {
          const rugOutSol = parseInt(rugQuote.outAmount) / 1e9;
          result = await executeSell(rugQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol, reason: rugReason,
            pnlPct: 0, outSol: rugOutSol, tokenAmount: token.amount,
          });
        }
        if (!result || result.action !== 'sell') {
          // PumpPortal fallback
          result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol, reason: rugReason,
            pnlPct: 0, tokenAmount: token.amount,
            estimatedSol: (tokenData.price_native || 0) * token.amount,
          }, kv, agent.id, true);
        }
      }
      if (result && result.action === 'sell') sellResults.push(result);
      else _debug.sellSkips.push({ mint: token.mint.substring(0,12), reason: `rug sell failed: ${result?.reason || 'no quote'}`, liq: tokenData.liquidity_usd, chg1h: tokenData.price_change_1h });
      continue;
    }

    // === MINIMUM HOLD TIME (checked later — SL bypasses this) ===
    const minHoldMinutes = Math.max(2, dna.check_interval_min || 10);
    const holdCheckRow = await db.prepare(
      "SELECT created_at FROM trades WHERE agent_id = ? AND token_address = ? AND action = 'buy' ORDER BY created_at DESC LIMIT 1"
    ).bind(agent.id, token.mint).first();
    const minutesHeld = holdCheckRow ? (Date.now() - new Date(holdCheckRow.created_at + 'Z').getTime()) / 60000 : 999;
    const holdTimeMet = minutesHeld >= minHoldMinutes;

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
    let totalBought = 0, totalSold = 0, sellCount = 0, totalBoughtTokens = 0;
    for (let i = positionStartIdx; i < allTrades.results.length; i++) {
      const t = allTrades.results[i];
      if (t.action === 'buy') { totalBought += t.amount_sol || 0; totalBoughtTokens += t.token_amount || 0; }
      else if (t.action === 'sell') { totalSold += t.amount_sol || 0; sellCount++; }
    }

    if (totalBought <= 0) { _debug.sellSkips.push({ mint: token.mint.substring(0,12), reason: 'no buy trades in DB' }); continue; }

    let fullOutSol, fullQuote;
    if (!isDegen) {
      fullQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount).catch(() => null);
      if (!fullQuote) {
        // Jupiter failed (rate-limited) — use price estimate like degen, sell via PumpPortal
        fullOutSol = (tokenData.price_native || 0) * token.amount;
        if (fullOutSol <= 0) fullOutSol = totalBought;
      } else {
        fullOutSol = parseInt(fullQuote.outAmount) / 1e9;
      }
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

    // TP: min 20%, degen capped at 80%
    const rawTP = Math.max(20, dna.sell_profit_pct);
    const tpThreshold = isDegen
      ? Math.min(rawTP, 80)
      : rawTP * (1 + dna.patience * 0.5);

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

    const trailPct = dna.trailing_stop_pct || Math.min(20 + dna.patience * 30, 35);

    // Phase 1: Take profit levels
    // tp_levels = [{pct: 30, sell_pct: 30}, {pct: 60, sell_pct: 40}, ...] — sell % of ORIGINAL position at each trigger
    const tpLevels = meta.tp_levels && meta.tp_levels.length > 0 ? meta.tp_levels : null;

    if (tpLevels && holdTimeMet && pnlPct > 0) {
      // Track which levels have been hit via KV
      const tpKey = kv ? `tphit:${agent.id}:${token.mint}` : null;
      let hitsCompleted = tpKey ? parseInt(await kv.get(tpKey) || '0') : 0;

      // Find next unhit level that's triggered
      const nextLevel = tpLevels.length > hitsCompleted ? tpLevels[hitsCompleted] : null;
      // All TP levels exhausted — auto 50% trailing stop on remaining position
      if (!nextLevel && hitsCompleted >= tpLevels.length && token.amount > 0 && kv) {
        const tpTrailKey = `tptrail:${agent.id}:${token.mint}`;
        const storedPeak = parseFloat(await kv.get(tpTrailKey) || '0');
        const peak = Math.max(storedPeak, fullOutSol);
        if (fullOutSol > storedPeak) {
          await kv.put(tpTrailKey, fullOutSol.toString(), { expirationTtl: 86400 * 7 });
        }
        const dropFromPeak = peak > 0 ? (1 - fullOutSol / peak) * 100 : 0;
        if (dropFromPeak >= 50 && peak > 0.005) {
          const reason = `TP trail (all ${tpLevels.length} TPs hit, peak ${peak.toFixed(4)} SOL, now ${fullOutSol.toFixed(4)} SOL, drop ${dropFromPeak.toFixed(0)}% >= 50%)`;
          let result;
          if (isDegen) {
            result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
              symbol: tokenData.symbol, reason, pnlPct, tokenAmount: token.amount, estimatedSol: fullOutSol,
            }, kv, agent.id);
          } else {
            result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
              token: token.mint, symbol: tokenData.symbol, reason, pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
            });
          }
          if (result && result.action === 'sell') { sellResults.push(result); await kv.delete(tpTrailKey); await kv.delete(peakKey); await kv.delete(tpKey); continue; }
        }
        continue; // skip legacy TP / other sell logic — trailing stop is managing this position
      }

      if (nextLevel && pnlPct >= nextLevel.pct) {
        // sell_pct is % of ORIGINAL bought tokens
        const sellTokens = totalBoughtTokens * (nextLevel.sell_pct / 100);
        const sellFraction = Math.min(sellTokens / token.amount, 1); // fraction of current holding

        const isLastLevel = hitsCompleted + 1 >= tpLevels.length;
        const reason = `TP${hitsCompleted + 1} (${pnlPct.toFixed(1)}% >= ${nextLevel.pct}%, sell ${nextLevel.sell_pct}% of original)`;

        let result;
        if (sellFraction >= 0.95 || isLastLevel && sellFraction > 0.8) {
          // Sell everything if close to 100% or last level
          if (isDegen) {
            result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
              symbol: tokenData.symbol, reason, pnlPct, tokenAmount: token.amount, estimatedSol: fullOutSol,
            }, kv, agent.id);
          } else {
            result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
              token: token.mint, symbol: tokenData.symbol, reason, pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
            });
          }
          if (result && result.action === 'sell') { sellResults.push(result); if (kv) { await kv.delete(peakKey); await kv.delete(tpKey); } continue; }
        } else {
          // Partial sell
          if (isDegen) {
            result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, `${Math.round(sellFraction * 100)}%`, {
              symbol: tokenData.symbol, reason, pnlPct, tokenAmount: sellTokens, estimatedSol: fullOutSol * sellFraction,
            }, kv, agent.id);
          } else {
            const partialRaw = Math.floor(parseInt(token.rawAmount) * sellFraction).toString();
            const partialQuote = await getJupiterQuote(token.mint, SOL_MINT, partialRaw);
            if (partialQuote) {
              const partialOutSol = parseInt(partialQuote.outAmount) / 1e9;
              result = await executeSell(partialQuote, agentPubkey, agentSecret, rpcUrl, {
                token: token.mint, symbol: tokenData.symbol, reason, pnlPct, outSol: partialOutSol, tokenAmount: sellTokens,
              });
            }
          }
          if (result && result.action === 'sell') {
            sellResults.push(result);
            if (tpKey) await kv.put(tpKey, (hitsCompleted + 1).toString(), { expirationTtl: 86400 * 7 });
          }
          continue;
        }
      }
    }

    // Legacy TP: single threshold (for agents without tp_levels)
    if (!tpLevels && sellStrategy !== 'trail' && !costRecovered && pnlPct >= tpThreshold && holdTimeMet) {
      if (sellStrategy === 'full') {
        let result;
        if (isDegen) {
          result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, '100%', {
            symbol: tokenData.symbol, reason: `take profit FULL (${pnlPct.toFixed(1)}% >= ${tpThreshold.toFixed(0)}%)`,
            pnlPct, tokenAmount: token.amount, estimatedSol: fullOutSol,
          }, kv, agent.id);
        } else {
          result = await executeSell(fullQuote, agentPubkey, agentSecret, rpcUrl, {
            token: token.mint, symbol: tokenData.symbol,
            reason: `take profit FULL (${pnlPct.toFixed(1)}% >= ${tpThreshold.toFixed(0)}%)`,
            pnlPct, outSol: fullOutSol, tokenAmount: token.amount,
          });
        }
        if (result && result.action === 'sell') sellResults.push(result);
        if (kv) { await kv.delete(peakKey); }
        continue;
      }

      // Phased exit: recover cost basis first
      const currentValue = fullOutSol;
      const costRemaining = totalBought - totalSold;
      const sellPct = Math.min(0.9, Math.max(0.2, costRemaining / currentValue));
      const partialAmount = token.amount * sellPct;
      let result;
      if (isDegen) {
        result = await executeDegenSell(agentPubkey, agentSecret, rpcUrl, token.mint, `${Math.round(sellPct * 100)}%`, {
          symbol: tokenData.symbol, reason: `take profit (recover cost ${Math.round(sellPct * 100)}%)`,
          pnlPct, tokenAmount: partialAmount, estimatedSol: fullOutSol * sellPct,
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
    const baseSL = -Math.max(15, dna.sell_loss_pct);
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

  // Prevent duplicate buys from retry/race conditions (KV lock for 60s)
  if (kv) {
    const buyLockKey = `buylock:${agent.id}`;
    const existingLock = await kv.get(buyLockKey);
    if (existingLock) {
      return { sells: sellResults, action: 'hold', reason: `buy lock active (retry protection)`, _debug };
    }
  }

  // Scale buy cooldown with aggression (aggressive: 30min, conservative: 45min)
  let buyCooldown = Math.round(30 + (1 - dna.aggression) * 15);
  if (marketRegime?.regime === 'trending_down') buyCooldown = Math.round(buyCooldown * 1.5);
  else if (marketRegime?.regime === 'choppy') buyCooldown = Math.round(buyCooldown * 1.2);
  const lastBuy = await db.prepare(
    "SELECT created_at FROM trades WHERE agent_id = ? AND action = 'buy' ORDER BY created_at DESC LIMIT 1"
  ).bind(agent.id).first();
  if (lastBuy) {
    const minsSinceBuy = (Date.now() - new Date(lastBuy.created_at + 'Z').getTime()) / 60000;
    if (minsSinceBuy < buyCooldown) return { sells: sellResults, action: 'hold', reason: `buy cooldown (${Math.round(buyCooldown - minsSinceBuy)}m left)`, _debug };
  }

  const SOL_RESERVE = 0.05;
  const availableSol = solBalance - SOL_RESERVE;

  // Min trade: at least 0.15 SOL (~$13) to make trades worthwhile after fees
  // But never exceed max_position_pct so user-set limits are respected
  const maxPctLimit = (Math.min(dna.max_position_pct, 90) / 100) * availableSol;
  const MIN_TRADE_SOL = Math.min(Math.max(0.15, availableSol * 0.15), Math.max(0.15, maxPctLimit));

  // Don't trade if balance is too low
  if (availableSol < 0.15) return { sells: sellResults, action: 'hold', reason: `balance too low to trade (${availableSol.toFixed(3)} SOL)`, _debug };

  const maxPositions = dna.max_positions || Math.round(2 + (1 - dna.aggression) * 2);
  const openPositions = tokenBalances.length;

  if (openPositions >= maxPositions) return { sells: sellResults, action: 'hold', reason: `max positions reached (${openPositions}/${maxPositions})`, _debug };
  if (availableSol < MIN_TRADE_SOL) return { sells: sellResults, action: 'hold', reason: `insufficient balance (${availableSol.toFixed(3)} SOL)`, _debug };
  if (!candidates || candidates.length === 0) return { sells: sellResults, action: 'idle', reason: 'no candidates' };

  // Distribute capital: go all-in on one position if balance is low
  const remainingSlots = maxPositions - openPositions;
  const maxPct = Math.min(dna.max_position_pct, 90) / 100;
  const perSlotAmount = availableSol / remainingSlots;
  let tradeAmountSol = Math.max(MIN_TRADE_SOL, Math.min(perSlotAmount, availableSol * maxPct));

  // Adaptive sizing: reduce after loss streaks
  const recentClosed = await db.prepare(
    `SELECT token_address,
      SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as bought,
      SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as sold,
      MAX(created_at) as last_trade
     FROM trades WHERE agent_id = ? AND created_at > datetime('now', '-7 days')
     GROUP BY token_address HAVING sold > 0
     ORDER BY last_trade DESC LIMIT 8`
  ).bind(agent.id).all();

  let consecutiveLosses = 0;
  for (const pos of recentClosed.results) {
    if (pos.sold < pos.bought * 0.98) consecutiveLosses++;
    else break;
  }

  if (consecutiveLosses >= 5) tradeAmountSol = Math.max(MIN_TRADE_SOL, tradeAmountSol * 0.35);
  else if (consecutiveLosses >= 3) tradeAmountSol = Math.max(MIN_TRADE_SOL, tradeAmountSol * 0.6);

  const tradeAmountLamports = Math.round(tradeAmountSol * 1e9);

  const heldMints = new Set(tokenBalances.map(t => t.mint));

  const recentSells = await db.prepare(
    "SELECT token_address FROM trades WHERE agent_id = ? AND action = 'sell' AND created_at > datetime('now', '-2 hours')"
  ).bind(agent.id).all();
  const recentlySold = new Set(recentSells.results.map(r => r.token_address));

  // Max 1 buy per token per 7 days
  const buyCountRows = await db.prepare(
    "SELECT token_address, COUNT(*) as cnt FROM trades WHERE agent_id = ? AND action = 'buy' AND created_at > datetime('now', '-7 days') GROUP BY token_address HAVING cnt >= 1"
  ).bind(agent.id).all();
  const maxedTokens = new Set(buyCountRows.results.map(r => r.token_address));

  // Global blacklist: known rugs/scams — no agent can buy these
  const GLOBAL_BLACKLIST = new Set([
    'BityzGkSmcU9SzFH26rzWQ5UX1cRBVywVcXEBxcQpump', // winston (rug)
    'Zscx6qngJieCj2mcuhUaYQ2F66EJ8vL7t6jVZh9pump',  // nakama (rug/wash)
    'EqLgaVKGPctfgi9kqTYgZJggewouDZoCC6tgSxUypump',  // OIL (rug/wash)
    '8zbUbQSt1QvGAPr7r2SQ2mH3SzYDkbGddQrKPiDbpump',  // Nodie (rug)
    '12qKJmoJj9hKs12S8kPhRMrWhsyfqaiEsDh9Z38xpump',  // MESSI (rug/wash)
    'BCjURyv9Zp2oNQfLxWe3q1PeWrFLQQ9C6vLQD7JFpump',  // SOYJAK (wash)
    '6RxB1KdzVMXrrYn7nQWvaGgh5e2EpbA1FcEFtq74pump',  // DELULU (wash)
    'HbxYCvGuCbZXzPZYVkKuPR1nNQkEg8ZFycJCtYckpump',  // CRYPTOHOUSE (rug)
    '6EEWHJBFbF4jQtXTn1NyGoA7WawF7W8fy1GQyvhqpump',  // CRYPTOHOUSE (rug)
    '53bYXw3o1TDkLLN2Q71im3HxETGDa3PTR4LpQVKKpump',  // TRUMPKIM (rug)
    '7wCX9qadjWgPWW6gp2SGQ3EKzV3W6zEMmzuUL8rdpump',  // baNana (rug)
  ]);

  // Symbol blacklist: repeated rug names that get relaunched with new mints
  const SYMBOL_BLACKLIST = new Set(['BOI', 'ONO', 'OIL', 'CRYPTOHOUSE', 'TRUMPKIM', 'baNana']);

  // Cross-agent limit: max 2 agents can hold the same token
  const crowdedRows = await db.prepare(
    `SELECT token_address FROM (
       SELECT agent_id, token_address,
         SUM(CASE WHEN action='buy' THEN token_amount ELSE 0 END) - SUM(CASE WHEN action='sell' THEN token_amount ELSE 0 END) as net
       FROM trades
       WHERE agent_id IN (SELECT id FROM agents WHERE status = 'alive') AND agent_id != ?
       GROUP BY agent_id, token_address HAVING net > 0
     ) GROUP BY token_address HAVING COUNT(DISTINCT agent_id) >= 2`
  ).bind(agent.id).all();
  const crowdedTokens = new Set(crowdedRows.results.map(r => r.token_address));

  // Token blacklist: tokens where agent sold at a loss (sold < 95% of bought)
  const blacklistRows = await db.prepare(
    `SELECT token_address,
      SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as bought,
      SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as sold
     FROM trades WHERE agent_id = ?
     GROUP BY token_address HAVING sold > 0 AND sold < bought * 0.95`
  ).bind(agent.id).all();
  const blacklistedTokens = new Set(blacklistRows.results.map(r => r.token_address));

  const filterStats = { total: candidates.length, held: 0, recentSold: 0, maxed: 0, blacklisted: 0, crowded: 0, sol: 0, mcap: 0, volume24h: 0, volume1h: 0, momentum: 0, txns: 0, liquidity: 0, tooNew: 0, tooOld: 0, passed: 0 };
  const scored = candidates
    .filter(t => {
      if (heldMints.has(t.address)) { filterStats.held++; return false; }
      if (recentlySold.has(t.address)) { filterStats.recentSold++; return false; }
      if (maxedTokens.has(t.address)) { filterStats.maxed++; return false; }
      if (GLOBAL_BLACKLIST.has(t.address)) { filterStats.blacklisted++; return false; }
      if (t.symbol && SYMBOL_BLACKLIST.has(t.symbol.toUpperCase())) { filterStats.blacklisted++; return false; }
      if (blacklistedTokens.has(t.address)) { filterStats.blacklisted++; return false; }
      if (crowdedTokens.has(t.address)) { filterStats.crowded++; return false; }
      if (t.address === SOL_MINT) { filterStats.sol++; return false; }

      const isFresh = (t.pair_age_hours || 0) < 1; // just migrated / still on pump
      const volFloor = isDegen ? 2000 : (isFresh ? 3000 : 10000);
      const vol1hFloor = isDegen ? 500 : (isFresh ? 500 : 1000);
      const liqBase = isDegen ? 500 : (isFresh ? 1000 : 2000);
      const liqScale = isDegen ? 2000 : (isFresh ? 5000 : 15000);
      const minAgeBase = isDegen ? 0.03 : 0.08; // ~2 min degen, ~5 min standard
      const minAgeScale = isDegen ? 0.1 : 0.4;
      const maxAge = dna.max_pair_age_hours || (isDegen ? 24 : 168);

      const minMcap = dna.min_mcap || (isDegen ? 5000 : 20000);
      const maxMcap = dna.max_mcap || (isDegen ? 500000 : Infinity);
      if ((t.market_cap || 0) < minMcap) { filterStats.mcap++; return false; }
      if ((t.market_cap || 0) > maxMcap) { filterStats.mcap++; return false; }

      if (t.volume_24h < volFloor) { filterStats.volume24h++; return false; }
      if ((t.volume_1h || 0) < vol1hFloor) { filterStats.volume1h++; return false; }

      // Require positive momentum
      const minMomentum = isDegen ? -10 : -3;
      if ((t.price_change_1h || 0) < minMomentum) { filterStats.momentum++; return false; }

      const minTxns = isDegen
        ? Math.max(5, Math.round((dna.buy_threshold_holders || 50) * 0.1))
        : Math.max(15, Math.round((dna.buy_threshold_holders || 100) * 0.15));
      if (t.txns_24h < minTxns) { filterStats.txns++; return false; }

      const minLiq = liqBase + (1 - dna.risk_tolerance) * liqScale;
      if (t.liquidity_usd < minLiq) { filterStats.liquidity++; return false; }

      const minAge = minAgeBase + (1 - dna.risk_tolerance) * minAgeScale;
      if (t.pair_age_hours < minAge) { filterStats.tooNew++; return false; }
      if (t.pair_age_hours > maxAge) { filterStats.tooOld++; return false; }

      // Pre-filter obvious wash trading (vol/liq > 40x for non-degen, 60x for degen)
      if (t.liquidity_usd > 0 && t.volume_24h > 0) {
        const vlr = t.volume_24h / t.liquidity_usd;
        const vlrMax = isDegen ? 60 : 40;
        if (vlr > vlrMax) { filterStats.blacklisted++; return false; }
      }

      filterStats.passed++;
      return true;
    })
    .map(t => ({ ...t, score: scoreToken(t, dna, marketRegime) }))
    .sort((a, b) => b.score - a.score);

  console.log(`Agent ${agent.id} filter: ${JSON.stringify(filterStats)}`);

  const minScore = isDegen ? 4 : 5;
  const strongCandidates = scored.filter(t => t.score >= minScore);
  const skipped = [];
  if (strongCandidates.length === 0 && scored.length > 0) {
    return { sells: sellResults, action: 'hold', reason: `no strong signals (best score ${scored[0]?.score.toFixed(1)}, need ${minScore})`, filterStats, _debug };
  }

  for (const t of strongCandidates.slice(0, 5)) {
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
        r.includes('single wallet holds') ||
        r.includes('transfer fee') ||
        r.includes('only') // "only N holders"
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

    // Unique traders check disabled — too many RPC calls for Cloudflare Workers
    // Wash trading is still caught by vol/liq ratio filter above

    // === HOLDER CONCENTRATION CHECK ===
    // Require 5+ holders with >1.1% of total supply to filter wash-traded rugs
    try {
      const { bigHolders } = await getHolderConcentration(t.address, rpcUrl);
      if (bigHolders < 5) {
        skipped.push({ token: t.symbol, reason: `bad holder distribution (${bigHolders} holders >1.1%)` });
        continue;
      }
    } catch (e) {
      // If RPC fails, skip the check rather than blocking all buys
      console.warn(`Holder check failed for ${t.symbol}: ${e.message}`);
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

        // Set buy lock BEFORE sending tx to prevent duplicate buys on retry
        if (kv) await kv.put(`buylock:${agent.id}`, Date.now().toString(), { expirationTtl: 60 });

        const txSig = await signAndSendSwapTx(ppTx, agentSecret, rpcUrl);

        // Query on-chain balance to record actual token_amount (tx already confirmed by signAndSend)
        let tokenAmount = 0;
        try {
          await new Promise(r => setTimeout(r, 2000));
          const postBuyBalances = await getTokenBalances(agentPubkey, rpcUrl);
          const bought = postBuyBalances.find(b => b.mint === t.address);
          if (bought) tokenAmount = bought.amount;
        } catch {}
        if (tokenAmount <= 0) console.warn(`Agent ${agent.id}: token_amount=0 after degen buy of ${t.symbol}, tx=${txSig}`);

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

    // === NORMAL: buy via Jupiter (fallback to PumpPortal if no quote) ===
    const buyQuote = await getJupiterQuote(SOL_MINT, t.address, tradeAmountLamports);
    if (!buyQuote) {
      // Fallback: try PumpPortal for pump.fun native tokens
      if (t.isPumpNative || t.dex === 'pumpfun') {
        try {
          const ppTx = await getPumpPortalTx(agentPubkey, 'buy', t.address, tradeAmountSol, {
            denominatedInSol: true, slippage: 2, pool: 'auto',
          });
          if (ppTx) {
            if (kv) await kv.put(`buylock:${agent.id}`, Date.now().toString(), { expirationTtl: 60 });
            const txSig = await signAndSendSwapTx(ppTx, agentSecret, rpcUrl);
            let tokenAmount = 0;
            try {
              await new Promise(r => setTimeout(r, 2000));
              const postBuyBalances = await getTokenBalances(agentPubkey, rpcUrl);
              const bought = postBuyBalances.find(b => b.mint === t.address);
              if (bought) tokenAmount = bought.amount;
            } catch {}
            return {
              sells: sellResults, action: 'buy', token: t.address, symbol: t.symbol,
              reason: `PumpPortal fallback | score ${t.score.toFixed(1)}`,
              amount_sol: tradeAmountSol, token_amount: tokenAmount, tx_signature: txSig,
            };
          }
        } catch (e) {
          skipped.push({ token: t.symbol, reason: `pumpportal fallback: ${e.message}` });
          continue;
        }
      }
      skipped.push({ token: t.symbol, reason: 'quote failed' }); continue;
    }

    const swapTx = await getJupiterSwapTx(buyQuote, agentPubkey);
    if (!swapTx) { skipped.push({ token: t.symbol, reason: 'swap tx failed' }); continue; }

    try {
      if (kv) await kv.put(`buylock:${agent.id}`, Date.now().toString(), { expirationTtl: 60 });
      const txSig = await signAndSendSwapTx(swapTx, agentSecret, rpcUrl);

      // Query on-chain balance for actual token_amount (tx already confirmed by signAndSend)
      let tokenAmount = 0;
      try {
        await new Promise(r => setTimeout(r, 2000));
        const postBuyBalances = await getTokenBalances(agentPubkey, rpcUrl);
        const bought = postBuyBalances.find(b => b.mint === t.address);
        if (bought) tokenAmount = bought.amount;
      } catch {}
      // Fallback: estimate from Jupiter quote
      if (tokenAmount <= 0 && buyQuote?.outAmount) {
        const decimals = buyQuote.outputMint?.decimals || 6;
        tokenAmount = parseInt(buyQuote.outAmount) / (10 ** decimals);
        console.warn(`Agent ${agent.id}: using quote fallback for token_amount of ${t.symbol}: ${tokenAmount}`);
      }
      if (tokenAmount <= 0) console.warn(`Agent ${agent.id}: token_amount=0 after buy of ${t.symbol}, tx=${txSig}`);

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

  return { sells: sellResults, action: 'hold', reason: `no signals (${scored.length} candidates filtered)`, skipped, filterStats, topScored: scored.slice(0, 5).map(t => ({ s: t.symbol, score: +t.score.toFixed(1), vol_liq: t.liquidity_usd > 0 ? +(t.volume_24h/t.liquidity_usd).toFixed(1) : 0 })), _debug };
}

// ============================================================
// SCORING — improved with caps and penalties
// ============================================================

function scoreToken(token, dna, marketRegime = null) {
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

  // Fresh launch bonus — tokens < 1h old with momentum are prime entries
  if (token.pair_age_hours < 1) score += 3;
  else if (token.pair_age_hours < 3) score += 1.5;

  // Risk-tolerant agents get bonus for newer tokens
  if (dna.risk_tolerance > 0.7 && token.pair_age_hours < 12) score += 2;

  // Patient agents prefer tokens that survived the first few hours
  if (dna.patience > 0.7 && token.pair_age_hours > 6) score += 1;

  // pump.fun native bonus — early entry opportunity
  if (token.isPumpNative) score += 1;

  // Market regime adjustment
  if (marketRegime) {
    if (marketRegime.regime === 'trending_down') score *= 0.85;
    else if (marketRegime.regime === 'choppy') score *= 0.9;
    else if (marketRegime.regime === 'trending_up') score *= 1 + marketRegime.confidence * 0.15;
  }

  return score;
}

// ============================================================
// SELL EXECUTION
// ============================================================

let _currentKv = null, _currentAgentId = null;
async function executeSell(quote, pubkey, secret, rpcUrl, info, kv, agentId) {
  if (!kv) kv = _currentKv;
  if (!agentId) agentId = _currentAgentId;
  // Try Jupiter if we have a quote
  if (quote) {
    const swapTx = await getJupiterSwapTx(quote, pubkey).catch(() => null);
    if (swapTx) {
      try {
        const txSig = await signAndSendSwapTx(swapTx, secret, rpcUrl);
        return {
          action: 'sell', token: info.token, symbol: info.symbol, reason: info.reason,
          pnl_pct: info.pnlPct, amount_sol: info.outSol, token_amount: info.tokenAmount,
          tx_signature: txSig,
        };
      } catch (e) {
        console.error(`Jupiter sell failed for ${info.symbol}:`, e.message);
      }
    }
  }
  // PumpPortal fallback for pump.fun tokens
  if (info.token && info.token.endsWith('pump')) {
    return executeDegenSell(pubkey, secret, rpcUrl, info.token, '100%', {
      symbol: info.symbol, reason: info.reason,
      pnlPct: info.pnlPct, tokenAmount: info.tokenAmount,
      estimatedSol: info.outSol || 0,
    }, kv, agentId);
  }
  return { action: 'hold', reason: 'sell failed (no jupiter, not pump token)' };
}

// Degen sell via PumpPortal
async function executeDegenSell(pubkey, secret, rpcUrl, mint, _label, info, kv, agentId, emergency = false) {
  const slippage = await getSellSlippage(kv, agentId, mint, emergency);
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
