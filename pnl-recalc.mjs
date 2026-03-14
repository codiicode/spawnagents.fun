#!/usr/bin/env node
// pnl-recalc.mjs — Runs on Hetzner, calculates PnL as (SOL + token value) - initial_capital

const WORKER_URL = 'https://spawnagents.fun';
const CRON_SECRET = '5e73f510c86dd3547ec3d7358d7205fa887dfa5de552a374867ca287c6c09dff';
const HELIUS_URL = 'https://mainnet.helius-rpc.com/?api-key=6a1e303d-792e-4cf7-a2f7-479b9965ec4c';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function rpc(method, params) {
  const res = await fetch(HELIUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function main() {
  log('PnL recalc starting...');

  // 1. Get all alive agents
  const agentsRes = await fetch(`${WORKER_URL}/api/agents?status=alive`);
  const agentsData = await agentsRes.json();
  const agents = agentsData.agents || [];
  log(`${agents.length} alive agents`);

  // 2. Fetch SOL + token balances for all agents
  const holdings = {};
  const allTokenMints = new Set();

  for (const agent of agents) {
    const wallet = agent.agent_wallet;
    if (!wallet) continue;
    try {
      const balRes = await rpc('getBalance', [wallet, { commitment: 'confirmed' }]);
      const sol = (balRes?.value || 0) / 1e9;

      const [tok1, tok2] = await Promise.all([
        rpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] })),
        rpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_2022 }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] })),
      ]);

      const allAccounts = [...(tok1?.value || []), ...(tok2?.value || [])];
      const tokens = allAccounts
        .map(acc => {
          const info = acc.account.data.parsed.info;
          return {
            mint: info.mint,
            amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
            decimals: info.tokenAmount.decimals,
          };
        })
        .filter(t => t.amount > 0);

      holdings[agent.id] = { sol, tokens, wallet, initial: agent.initial_capital || 0, withdrawn: agent.total_withdrawn || 0 };
      for (const t of tokens) allTokenMints.add(t.mint);

      if (tokens.length > 0) {
        log(`  ${agent.id}: ${sol.toFixed(4)} SOL + ${tokens.length} token(s)`);
      }
    } catch (e) {
      log(`  ${agent.id}: balance fetch failed - ${e.message}`);
      holdings[agent.id] = { sol: 0, tokens: [], wallet, initial: agent.initial_capital || 0, withdrawn: agent.total_withdrawn || 0, error: e.message };
    }
  }

  // 3. Fetch token prices + symbols from DexScreener (priceNative = price in SOL)
  const tokenPrices = {};
  const tokenSymbols = {};
  const mints = [...allTokenMints];
  log(`Fetching prices for ${mints.length} token(s)...`);

  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`);
      if (res.ok) {
        const pairs = await res.json();
        if (Array.isArray(pairs)) {
          const bestByMint = {};
          for (const pair of pairs) {
            const mint = pair.baseToken?.address;
            const priceNative = parseFloat(pair.priceNative || '0');
            if (mint && priceNative > 0) {
              const liq = pair.liquidity?.usd || 0;
              if (!bestByMint[mint] || liq > bestByMint[mint].liq) {
                bestByMint[mint] = { price: priceNative, liq, symbol: pair.baseToken?.symbol, priceUsd: parseFloat(pair.priceUsd || '0') };
              }
            }
          }
          for (const [mint, info] of Object.entries(bestByMint)) {
            tokenPrices[mint] = info.price;
            if (info.symbol) tokenSymbols[mint] = info.symbol;
          }
        }
      }
    } catch (e) {
      log(`  DexScreener price fetch failed: ${e.message}`);
    }
  }

  log(`Got prices for ${Object.keys(tokenPrices).length}/${mints.length} tokens`);

  // 4. Calculate PnL and update via API
  const updates = [];
  for (const agent of agents) {
    const h = holdings[agent.id];
    if (!h || h.error) { updates.push({ id: agent.id, error: h?.error || 'no data' }); continue; }

    let tokenValueSol = 0;
    const tokenDetails = [];
    for (const t of h.tokens) {
      const price = tokenPrices[t.mint] || 0;
      const value = t.amount * price;
      tokenValueSol += value;
      if (value > 0.001) tokenDetails.push(`${t.mint.substring(0,8)}=${value.toFixed(4)}`);
    }

    const totalValue = h.sol + tokenValueSol;
    const pnl = (totalValue + h.withdrawn) - h.initial;

    updates.push({
      id: agent.id,
      sol: h.sol,
      tokens_sol: tokenValueSol,
      total: totalValue,
      initial: h.initial,
      withdrawn: h.withdrawn,
      pnl,
      token_details: tokenDetails,
    });
  }

  // 5. Cache balances + prices in KV for portfolio endpoint
  const balanceCache = {};
  for (const agent of agents) {
    const h = holdings[agent.id];
    if (!h || h.error) continue;
    balanceCache[agent.id] = {
      sol: h.sol,
      tokens: h.tokens.map(t => ({
        mint: t.mint,
        amount: t.amount,
        decimals: t.decimals,
        price_native: tokenPrices[t.mint] || 0,
        symbol: tokenSymbols[t.mint] || t.mint.slice(0, 6),
      })),
    };
  }

  // Send balance cache alongside PnL updates
  const res = await fetch(`${WORKER_URL}/api/recalc-pnl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': CRON_SECRET,
    },
    body: JSON.stringify({ updates, balanceCache }),
  });
  const resultText = await res.text();
  log(`Worker response (${res.status}): ${resultText.substring(0, 500)}`);
  const result = JSON.parse(resultText);

  // Summary
  const profitable = updates.filter(u => u.pnl > 0).length;
  const losing = updates.filter(u => u.pnl < 0).length;
  log(`Done. ${profitable} profitable, ${losing} losing.`);
  for (const u of updates) {
    if (u.error) { log(`  ${u.id}: ERROR ${u.error}`); continue; }
    const sign = u.pnl >= 0 ? '+' : '';
    const tokStr = u.tokens_sol > 0.001 ? ` + ${u.tokens_sol.toFixed(4)} tok` : '';
    const wdStr = u.withdrawn > 0 ? ` wd:${u.withdrawn.toFixed(4)}` : '';
    log(`  ${u.id.padEnd(22)} ${u.sol.toFixed(4)} SOL${tokStr} = ${u.total.toFixed(4)} (init ${u.initial.toFixed(4)}${wdStr}) → ${sign}${u.pnl.toFixed(4)}`);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
