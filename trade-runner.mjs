#!/usr/bin/env node
// trade-runner.mjs — Runs on Hetzner, pre-fetches ALL external data, sends to Worker
// Worker only does DB/KV + transaction signing (no outbound API calls needed)

const WORKER_URL = 'https://spawnagents.fun';
const CRON_SECRET = '5e73f510c86dd3547ec3d7358d7205fa887dfa5de552a374867ca287c6c09dff';
const HELIUS_URL = 'https://mainnet.helius-rpc.com/?api-key=c0b84ba1-2b4d-442c-a4d9-338fd2e1131e';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEXSCREENER = 'https://api.dexscreener.com';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ============================================================
// DISCOVERY — find candidate tokens from multiple sources
// ============================================================

function parsePair(pair) {
  if (!pair.baseToken?.address) return null;
  if ((pair.liquidity?.usd || 0) < 1000) return null;
  const txns = pair.txns || {};
  const h24 = txns.h24 || { buys: 0, sells: 0 };
  const h1 = txns.h1 || { buys: 0, sells: 0 };
  const m5 = txns.m5 || { buys: 0, sells: 0 };
  const pairAge = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : 999;
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    price_usd: parseFloat(pair.priceUsd || 0),
    price_native: parseFloat(pair.priceNative || 0),
    volume_24h: pair.volume?.h24 || 0,
    volume_6h: pair.volume?.h6 || 0,
    volume_1h: pair.volume?.h1 || 0,
    liquidity_usd: pair.liquidity?.usd || 0,
    market_cap: pair.marketCap || pair.fdv || 0,
    txns_24h: h24.buys + h24.sells,
    txns_1h: h1.buys + h1.sells,
    txns_5m: m5.buys + m5.sells,
    price_change_5m: pair.priceChange?.m5 || 0,
    price_change_1h: pair.priceChange?.h1 || 0,
    price_change_6h: pair.priceChange?.h6 || 0,
    price_change_24h: pair.priceChange?.h24 || 0,
    pair_age_hours: pairAge,
    buy_sell_ratio_1h: h1.sells > 0 ? h1.buys / h1.sells : h1.buys || 0,
    dex: pair.dexId,
  };
}

function parsePumpCoin(coin) {
  const mcap = coin.usd_market_cap || 0;
  if (mcap < 1000) return null;
  const liq = coin.virtual_sol_reserves ? (coin.virtual_sol_reserves / 1e9) * 2 : mcap * 0.1;
  const liqUsd = liq * 130;
  const ageMs = coin.created_timestamp ? Date.now() - coin.created_timestamp : 0;
  const ageHours = ageMs > 0 ? ageMs / 3600000 : 0.1;
  const estVol24h = coin.volume_24h || mcap * 0.5;
  return {
    address: coin.mint,
    symbol: coin.symbol || 'PUMP',
    name: coin.name || coin.symbol || 'Unknown',
    price_usd: mcap > 0 && coin.total_supply > 0 ? mcap / (coin.total_supply / 1e6) : 0,
    price_native: 0,
    volume_24h: estVol24h,
    volume_6h: estVol24h * 0.4,
    volume_1h: estVol24h * 0.15,
    liquidity_usd: liqUsd || mcap * 0.1,
    market_cap: mcap,
    txns_24h: coin.reply_count || 50,
    txns_1h: 10,
    txns_5m: 2,
    price_change_5m: 0,
    price_change_1h: 5,
    price_change_6h: 0,
    price_change_24h: 0,
    pair_age_hours: ageHours,
    buy_sell_ratio_1h: 1.2,
    dex: 'pumpfun',
    isPumpNative: true,
  };
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(tid);
    return null;
  }
}

async function lookupAndAdd(addresses, tokens, seen) {
  const unseen = addresses.filter(a => a && !seen.has(a));
  if (unseen.length === 0) return;
  for (let i = 0; i < unseen.length; i += 10) {
    const batch = unseen.slice(i, i + 10);
    const data = await fetchJson(`${DEXSCREENER}/latest/dex/tokens/${batch.join(',')}`);
    if (!data) continue;
    const bestPairs = {};
    for (const pair of (data.pairs || [])) {
      if (pair.chainId !== 'solana') continue;
      const addr = pair.baseToken.address;
      const liq = pair.liquidity?.usd || 0;
      if (!bestPairs[addr] || liq > (bestPairs[addr].liquidity?.usd || 0)) bestPairs[addr] = pair;
    }
    for (const [addr, pair] of Object.entries(bestPairs)) {
      if (seen.has(addr)) continue;
      seen.add(addr);
      const parsed = parsePair(pair);
      if (parsed) tokens.push(parsed);
    }
    if (i + 10 < unseen.length) await sleep(200);
  }
}

async function discoverTokens() {
  const seen = new Set();
  const tokens = [];
  const stats = {};

  // 1. DexScreener new pairs
  try {
    const data = await fetchJson(`${DEXSCREENER}/latest/dex/pairs/solana`);
    if (data) {
      for (const pair of (data.pairs || []).slice(0, 40)) {
        const addr = pair.baseToken?.address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const parsed = parsePair(pair);
        if (parsed) tokens.push(parsed);
      }
      stats.dex_new = tokens.length;
    }
  } catch {}

  // 2. DexScreener boosted tokens
  try {
    const boosts = await fetchJson(`${DEXSCREENER}/token-boosts/latest/v1`);
    if (boosts) {
      const addrs = boosts.filter(b => b.chainId === 'solana').map(b => b.tokenAddress).slice(0, 20);
      await lookupAndAdd(addrs, tokens, seen);
    }
  } catch {}

  // 3. DexScreener profiles
  try {
    const profiles = await fetchJson(`${DEXSCREENER}/token-profiles/latest/v1`);
    if (profiles) {
      const addrs = profiles.filter(p => p.chainId === 'solana').map(p => p.tokenAddress).slice(0, 20);
      await lookupAndAdd(addrs, tokens, seen);
      stats.dex_profiles = addrs.length;
    }
  } catch {}

  // 4. DexScreener search
  for (const q of ['SOL', 'solana pump', 'pumpswap']) {
    try {
      const data = await fetchJson(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (data) {
        for (const pair of (data.pairs || []).slice(0, 30)) {
          if (pair.chainId !== 'solana') continue;
          const addr = pair.baseToken?.address;
          if (!addr || seen.has(addr)) continue;
          seen.add(addr);
          const parsed = parsePair(pair);
          if (parsed) tokens.push(parsed);
        }
      }
    } catch {}
  }
  stats.dex_search = tokens.length - (stats.dex_new || 0) - (stats.dex_profiles || 0);

  // 5. pump.fun currently live
  try {
    const coins = await fetchJson('https://frontend-api-v3.pump.fun/coins/currently-live?limit=20&offset=0&includeNsfw=false');
    if (coins) {
      let c = 0;
      for (const coin of coins) {
        if (seen.has(coin.mint)) continue;
        const parsed = parsePumpCoin(coin);
        if (parsed) { seen.add(coin.mint); tokens.push(parsed); c++; }
      }
      stats.pump_live = c;
    }
  } catch {}

  // 6. pump.fun king of the hill
  try {
    const coins = await fetchJson('https://frontend-api-v3.pump.fun/coins/king-of-the-hill?limit=20&offset=0&includeNsfw=false');
    if (coins) {
      let c = 0;
      for (const coin of coins) {
        if (seen.has(coin.mint) || (coin.usd_market_cap || 0) < 5000) continue;
        const parsed = parsePumpCoin(coin);
        if (parsed) { seen.add(coin.mint); tokens.push(parsed); c++; }
      }
      stats.pump_koth = c;
    }
  } catch {}

  // 7. pump.fun graduated
  try {
    const coins = await fetchJson('https://frontend-api-v3.pump.fun/coins/latest-graduated?limit=20&offset=0&includeNsfw=false');
    if (coins) {
      const gradAddrs = coins.filter(c => c.mint && !seen.has(c.mint)).map(c => c.mint);
      await lookupAndAdd(gradAddrs, tokens, seen);
      // Fallback for tokens not yet on DexScreener
      for (const c of coins) {
        if (seen.has(c.mint)) continue;
        const parsed = parsePumpCoin(c);
        if (parsed) { seen.add(c.mint); tokens.push(parsed); }
      }
      stats.pump_grad = gradAddrs.length;
    }
  } catch {}

  // 8. GeckoTerminal trending
  try {
    const data = await fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1', {
      headers: { 'Accept': 'application/json' },
    });
    if (data) {
      const addrs = (data.data || [])
        .map(p => p.relationships?.base_token?.data?.id?.replace('solana_', ''))
        .filter(a => a && !seen.has(a));
      await lookupAndAdd(addrs, tokens, seen);
      stats.gecko_trending = addrs.length;
    }
  } catch {}

  // 9. GeckoTerminal new pools
  try {
    const data = await fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', {
      headers: { 'Accept': 'application/json' },
    });
    if (data) {
      const addrs = (data.data || [])
        .map(p => p.relationships?.base_token?.data?.id?.replace('solana_', ''))
        .filter(a => a && !seen.has(a));
      await lookupAndAdd(addrs, tokens, seen);
      stats.gecko_new = addrs.length;
    }
  } catch {}

  // 10. GeckoTerminal PumpSwap pools
  try {
    const data = await fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?sort=h24_tx_count_desc&page=1', {
      headers: { 'Accept': 'application/json' },
    });
    if (data) {
      const addrs = (data.data || [])
        .map(p => p.relationships?.base_token?.data?.id?.replace('solana_', ''))
        .filter(a => a && !seen.has(a));
      await lookupAndAdd(addrs, tokens, seen);
      stats.pumpswap = addrs.length;
    }
  } catch {}

  return { tokens, stats };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  log('=== Trade runner started ===');

  // 1. Fetch agent wallets from Worker
  let agents;
  try {
    const res = await fetch(`${WORKER_URL}/api/agent-wallets`, {
      headers: { 'x-cron-secret': CRON_SECRET },
    });
    agents = await res.json();
    if (!Array.isArray(agents) || agents.length === 0) {
      log('No alive agents found');
      return;
    }
    log(`Found ${agents.length} alive agents`);
  } catch (e) {
    log(`Failed to fetch agents: ${e.message}`);
    return;
  }

  // 2. Fetch balances + discovery in parallel
  const balances = {};
  const balancePromise = (async () => {
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
              rawAmount: info.tokenAmount.amount,
            };
          })
          .filter(t => t.amount > 0);
        if (tokens.length > 0) {
          log(`  ${agent.id} (${wallet.substring(0,8)}): ${sol.toFixed(4)} SOL, ${tokens.length} token(s)`);
        }
        balances[wallet] = { sol, tokens };
      } catch (e) {
        log(`  Balance fetch failed for ${agent.id}: ${e.message}`);
      }
      await sleep(150);
    }
  })();

  const discoveryPromise = discoverTokens();

  await balancePromise;
  const { tokens: candidates, stats: discoveryStats } = await discoveryPromise;

  log(`Balances: ${Object.keys(balances).length}/${agents.length} | Discovery: ${candidates.length} tokens (${JSON.stringify(discoveryStats)})`);

  // 3. Fetch DexScreener data for held tokens (for sell signals)
  const heldMints = new Set();
  for (const info of Object.values(balances)) {
    for (const t of (info.tokens || [])) heldMints.add(t.mint);
  }

  const tokenData = {};
  if (heldMints.size > 0) {
    const mintArr = [...heldMints];
    for (let i = 0; i < mintArr.length; i += 30) {
      const batch = mintArr.slice(i, i + 30);
      const data = await fetchJson(`${DEXSCREENER}/latest/dex/tokens/${batch.join(',')}`);
      if (data) {
        const bestPairs = {};
        for (const pair of (data.pairs || [])) {
          if (pair.chainId !== 'solana') continue;
          const addr = pair.baseToken.address;
          const liq = pair.liquidity?.usd || 0;
          if (!bestPairs[addr] || liq > (bestPairs[addr].liquidity?.usd || 0)) bestPairs[addr] = pair;
        }
        for (const [addr, pair] of Object.entries(bestPairs)) {
          tokenData[addr] = parsePair(pair) || tokenData[addr];
        }
      }
      if (i + 30 < mintArr.length) await sleep(300);
    }
    log(`Token data: ${Object.keys(tokenData).length}/${heldMints.size} held tokens`);
  }

  // 4. Send everything to Worker
  try {
    const res = await fetch(`${WORKER_URL}/api/process-trades`, {
      method: 'POST',
      headers: {
        'x-cron-secret': CRON_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ balances, tokenData, candidates }),
    });
    const result = await res.json();
    log(`Result: ${JSON.stringify(result)}`);
  } catch (e) {
    log(`Process-trades failed: ${e.message}`);
  }

  log('=== Trade runner finished ===');
}

async function rpc(method, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(HELIUS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
      const data = await res.json();
      if (data.error) {
        if (data.error.code === 429 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error(`RPC ${method}: ${data.error.message}`);
      }
      return data.result;
    } catch (e) {
      if (attempt < 2 && e.name === 'AbortError') { await sleep(500); continue; }
      throw e;
    }
  }
  throw new Error(`RPC ${method}: failed after 3 attempts`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => log(`Fatal: ${e.message}`));
