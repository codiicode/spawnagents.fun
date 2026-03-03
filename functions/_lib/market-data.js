const DEXSCREENER = 'https://api.dexscreener.com';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================================
// TOKEN DISCOVERY — fetches candidates from multiple sources
// Call once per cron cycle, share across all agents
// ============================================================

export async function discoverTokens() {
  const seen = new Set();
  const tokens = [];

  // Source 1: Search for active Solana pairs
  for (const q of ['SOL', 'solana pump']) {
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        for (const pair of (data.pairs || [])) {
          if (pair.chainId !== 'solana') continue;
          addBestPair(pair, tokens, seen);
        }
      }
    } catch {}
  }

  // Source 2: Latest token profiles (catches fresh pump.fun migrations)
  try {
    const res = await fetch(`${DEXSCREENER}/token-profiles/latest/v1`);
    if (res.ok) {
      const profiles = await res.json();
      const solAddrs = profiles
        .filter(p => p.chainId === 'solana')
        .map(p => p.tokenAddress)
        .slice(0, 20);
      await lookupAndAdd(solAddrs, tokens, seen);
    }
  } catch {}

  // Source 3: Search for recent pumpswap migrations + trending terms
  for (const q of ['pumpswap', 'pump.fun', 'raydium SOL']) {
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        for (const pair of (data.pairs || []).slice(0, 30)) {
          if (pair.chainId !== 'solana') continue;
          addBestPair(pair, tokens, seen);
        }
      }
    } catch {}
  }

  // Source 4: DexScreener new pairs on Solana (catches fresh migrations)
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/pairs/solana`);
    if (res.ok) {
      const data = await res.json();
      for (const pair of (data.pairs || []).slice(0, 40)) {
        addBestPair(pair, tokens, seen);
      }
    }
  } catch {}

  // Source 5: pump.fun currently live — collect addresses, lookup real data via DexScreener
  try {
    const res = await fetch('https://frontend-api-v3.pump.fun/coins/currently-live?limit=20&offset=0&includeNsfw=false');
    if (res.ok) {
      const coins = await res.json();
      const pumpAddrs = coins
        .filter(c => (c.usd_market_cap || 0) >= 1000)
        .map(c => c.mint)
        .filter(a => !seen.has(a));
      await lookupAndAdd(pumpAddrs, tokens, seen);
    }
  } catch {}

  return tokens;
}

// Add pair, keeping only the highest-liquidity pair per token address
function addBestPair(pair, tokens, seen) {
  const addr = pair.baseToken?.address;
  if (!addr) return;

  if (seen.has(addr)) {
    // Check if this pair has higher liquidity than the existing one
    const existingIdx = tokens.findIndex(t => t.address === addr);
    if (existingIdx >= 0) {
      const existingLiq = tokens[existingIdx].liquidity_usd || 0;
      const newLiq = pair.liquidity?.usd || 0;
      if (newLiq > existingLiq) {
        const parsed = parsePair(pair);
        if (parsed) tokens[existingIdx] = parsed;
      }
    }
    return;
  }

  seen.add(addr);
  const parsed = parsePair(pair);
  if (parsed) tokens.push(parsed);
}

// Batch lookup token addresses via DexScreener /tokens/ endpoint
async function lookupAndAdd(addresses, tokens, seen) {
  const unseen = addresses.filter(a => !seen.has(a));
  if (unseen.length === 0) return;

  for (let i = 0; i < unseen.length; i += 10) {
    const batch = unseen.slice(i, i + 10);
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${batch.join(',')}`);
      if (!res.ok) continue;
      const data = await res.json();

      // Group pairs by token, pick highest liquidity per token
      const bestPairs = {};
      for (const pair of (data.pairs || [])) {
        if (pair.chainId !== 'solana') continue;
        const addr = pair.baseToken.address;
        const liq = pair.liquidity?.usd || 0;
        if (!bestPairs[addr] || liq > (bestPairs[addr].liquidity?.usd || 0)) {
          bestPairs[addr] = pair;
        }
      }

      for (const addr of Object.keys(bestPairs)) {
        if (seen.has(addr)) continue;
        seen.add(addr);
        const parsed = parsePair(bestPairs[addr]);
        if (parsed) tokens.push(parsed);
      }
    } catch {}
  }
}

// Parse a DexScreener pair into our token format
function parsePair(pair) {
  if ((pair.liquidity?.usd || 0) < 1000) return null;

  const txns = pair.txns || {};
  const h24 = txns.h24 || { buys: 0, sells: 0 };
  const h1 = txns.h1 || { buys: 0, sells: 0 };
  const m5 = txns.m5 || { buys: 0, sells: 0 };

  const pairAge = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 3600000
    : 999;

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

// ============================================================
// SINGLE TOKEN LOOKUP — for checking held positions
// ============================================================

export async function getTokenData(tokenMint) {
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json();
    // Pick highest-liquidity Solana pair for this token
    const solPairs = (data.pairs || []).filter(p => p.chainId === 'solana');
    if (solPairs.length === 0) return null;
    const bestPair = solPairs.reduce((best, p) =>
      (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best
    );
    return parsePair(bestPair);
  } catch { return null; }
}

// Price-only lookup for PnL — no liquidity filter
export async function getTokenPrice(tokenMint) {
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = (data.pairs || []).find(p => p.chainId === 'solana');
    if (!pair) return null;
    return { price_usd: parseFloat(pair.priceUsd || 0), symbol: pair.baseToken?.symbol };
  } catch { return null; }
}

// ============================================================
// SAFETY CHECK — RugCheck API + heuristics to avoid scams
// ============================================================

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';

export async function checkTokenSafety(tokenAddress, dexData) {
  const reasons = [];

  if (dexData) {
    const r1h = dexData.buy_sell_ratio_1h || 0;
    if (r1h > 10) reasons.push('suspicious buy/sell ratio');

    if (dexData.volume_1h > 0 && dexData.volume_24h > 0) {
      if (dexData.volume_1h / dexData.volume_24h > 0.5) reasons.push('volume spike (1h > 50% of 24h)');
    }

    if (dexData.volume_24h > 50000 && dexData.txns_24h < 50) reasons.push('high volume with few txns (likely wash trading)');
    if (dexData.pair_age_hours < 1 && dexData.volume_24h > 200000) reasons.push('brand new with suspicious volume');
    if (dexData.liquidity_usd !== undefined && dexData.liquidity_usd < 5000) reasons.push(`low liquidity ($${Math.round(dexData.liquidity_usd)})`);

    if (dexData.market_cap > 0 && dexData.liquidity_usd > 0) {
      const mcLiqRatio = dexData.market_cap / dexData.liquidity_usd;
      if (mcLiqRatio > 20) reasons.push(`mc/liq ratio ${mcLiqRatio.toFixed(0)}x (inflated)`);
    }
  }

  try {
    const res = await fetch(`${RUGCHECK_API}/tokens/${tokenAddress}/report/summary`);
    if (res.ok) {
      const report = await res.json();

      if (report.rugged) {
        reasons.push('flagged as rugged');
        return { safe: false, reasons, score: 0 };
      }

      if (report.mintAuthority && report.mintAuthority !== '' && report.mintAuthority !== null) reasons.push('mint authority active');
      if (report.freezeAuthority && report.freezeAuthority !== '' && report.freezeAuthority !== null) reasons.push('freeze authority active');
      if (report.transferFee && report.transferFee.pct > 0) reasons.push(`transfer fee ${report.transferFee.pct}%`);

      if (report.risks && report.risks.length > 0) {
        const dangers = report.risks.filter(r => r.level === 'danger');
        for (const d of dangers) {
          const label = d.name || d.description || 'danger flag';
          if (label.toLowerCase().includes('creator history')) continue;
          reasons.push(label);
        }
      }

      if (report.totalHolders !== undefined && report.totalHolders < 30) reasons.push(`only ${report.totalHolders} holders`);

      if (report.topHolders && Array.isArray(report.topHolders)) {
        const top10Pct = report.topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0);
        if (top10Pct > 50) reasons.push(`top 10 holders own ${top10Pct.toFixed(0)}%`);
        const biggestHolder = report.topHolders[0];
        if (biggestHolder && (biggestHolder.pct || 0) > 25) reasons.push(`single wallet holds ${biggestHolder.pct.toFixed(0)}%`);
      }

      const score = report.score || 0;
      return { safe: reasons.length === 0, reasons, score, holders: report.totalHolders };
    }
  } catch {}

  return { safe: reasons.length === 0, reasons, score: reasons.length === 0 ? 500 : 0 };
}
