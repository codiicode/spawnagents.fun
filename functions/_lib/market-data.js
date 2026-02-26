const DEXSCREENER = 'https://api.dexscreener.com';
const JUPITER_API = 'https://quote-api.jup.ag/v6';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================================
// TOKEN DISCOVERY — fetches candidates from multiple sources
// Call once per cron cycle, share across all agents
// ============================================================

export async function discoverTokens() {
  const seen = new Set();
  const tokens = [];

  // Source 1: Top boosted tokens (paid DexScreener promotions = active community)
  try {
    const res = await fetch(`${DEXSCREENER}/token-boosts/top/v1`);
    if (res.ok) {
      const boosts = await res.json();
      const solAddrs = boosts
        .filter(b => b.chainId === 'solana')
        .map(b => b.tokenAddress)
        .slice(0, 20);
      await lookupAndAdd(solAddrs, tokens, seen);
    }
  } catch {}

  // Source 2: Latest boosted tokens (freshest trending)
  try {
    const res = await fetch(`${DEXSCREENER}/token-boosts/latest/v1`);
    if (res.ok) {
      const boosts = await res.json();
      const solAddrs = boosts
        .filter(b => b.chainId === 'solana')
        .map(b => b.tokenAddress)
        .slice(0, 15);
      await lookupAndAdd(solAddrs, tokens, seen);
    }
  } catch {}

  // Source 3: Search for active Solana pairs
  for (const q of ['SOL', 'solana pump']) {
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        for (const pair of (data.pairs || [])) {
          if (pair.chainId !== 'solana') continue;
          if (seen.has(pair.baseToken.address)) continue;
          seen.add(pair.baseToken.address);
          const parsed = parsePair(pair);
          if (parsed) tokens.push(parsed);
        }
      }
    } catch {}
  }

  return tokens;
}

// Batch lookup token addresses via DexScreener /tokens/ endpoint
async function lookupAndAdd(addresses, tokens, seen) {
  const unseen = addresses.filter(a => !seen.has(a));
  if (unseen.length === 0) return;

  // DexScreener supports comma-separated addresses, batches of 10
  for (let i = 0; i < unseen.length; i += 10) {
    const batch = unseen.slice(i, i + 10);
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${batch.join(',')}`);
      if (!res.ok) continue;
      const data = await res.json();

      for (const pair of (data.pairs || [])) {
        if (pair.chainId !== 'solana') continue;
        if (seen.has(pair.baseToken.address)) continue;
        seen.add(pair.baseToken.address);
        const parsed = parsePair(pair);
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
  const h6 = txns.h6 || { buys: 0, sells: 0 };
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
    volume_24h: pair.volume?.h24 || 0,
    volume_6h: pair.volume?.h6 || 0,
    volume_1h: pair.volume?.h1 || 0,
    liquidity_usd: pair.liquidity?.usd || 0,
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
    const pair = (data.pairs || []).find(p => p.chainId === 'solana');
    if (!pair) return null;
    return parsePair(pair);
  } catch { return null; }
}

// ============================================================
// JUPITER QUOTE
// ============================================================

export async function getQuote(inputMint, outputMint, amountLamports) {
  try {
    const res = await fetch(
      `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=300`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
