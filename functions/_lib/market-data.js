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

  // Source 4: Latest token profiles (catches fresh pump.fun migrations)
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

  // Source 5: Search for recent pumpswap migrations + trending terms
  for (const q of ['pumpswap', 'pump.fun', 'raydium SOL']) {
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        for (const pair of (data.pairs || []).slice(0, 30)) {
          if (pair.chainId !== 'solana') continue;
          if (seen.has(pair.baseToken.address)) continue;
          seen.add(pair.baseToken.address);
          const parsed = parsePair(pair);
          if (parsed) tokens.push(parsed);
        }
      }
    } catch {}
  }

  // Source 6: DexScreener new pairs on Solana (catches all fresh migrations)
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/pairs/solana`);
    if (res.ok) {
      const data = await res.json();
      for (const pair of (data.pairs || []).slice(0, 40)) {
        if (seen.has(pair.baseToken.address)) continue;
        seen.add(pair.baseToken.address);
        const parsed = parsePair(pair);
        if (parsed) tokens.push(parsed);
      }
    }
  } catch {}

  // Source 7: pump.fun bonding curve tokens (not yet migrated)
  try {
    const res = await fetch('https://frontend-api-v3.pump.fun/coins/currently-live?limit=20&offset=0&includeNsfw=false');
    if (res.ok) {
      const coins = await res.json();
      for (const coin of coins) {
        if (seen.has(coin.mint)) continue;
        seen.add(coin.mint);
        const mcap = coin.usd_market_cap || 0;
        if (mcap < 1000) continue;
        tokens.push({
          address: coin.mint,
          symbol: coin.symbol || '?',
          name: coin.name || '',
          price_usd: mcap > 0 && coin.total_supply ? mcap / (coin.total_supply / 1e6) : 0,
          price_native: 0,
          volume_24h: coin.volume_24h || mcap * 0.5,
          volume_6h: coin.volume_6h || 0,
          volume_1h: coin.volume_1h || mcap * 0.1,
          liquidity_usd: mcap * 0.3,
          market_cap: mcap,
          txns_24h: coin.num_holders || 50,
          txns_1h: 20,
          txns_5m: 5,
          price_change_5m: 0,
          price_change_1h: 0,
          price_change_6h: 0,
          price_change_24h: 0,
          pair_age_hours: coin.created_timestamp ? (Date.now() - coin.created_timestamp) / 3600000 : 1,
          buy_sell_ratio_1h: 1.5,
          dex: 'pumpfun',
        });
      }
    }
  } catch {}

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
    const pair = (data.pairs || []).find(p => p.chainId === 'solana');
    if (!pair) return null;
    return parsePair(pair);
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

// Check if a token is safe to buy. Returns { safe, reasons[] }
export async function checkTokenSafety(tokenAddress, dexData) {
  const reasons = [];

  // --- Heuristic checks on DexScreener data (free, instant) ---

  // Wash trading: extreme buy/sell ratio in 5 min
  if (dexData) {
    const m5 = dexData.txns_5m || 0;
    const r1h = dexData.buy_sell_ratio_1h || 0;

    // >10:1 buy/sell ratio in last hour = likely manipulation
    if (r1h > 10) {
      reasons.push('suspicious buy/sell ratio');
    }

    // Volume spike: 5min volume > 40% of 24h volume = coordinated pump
    if (dexData.volume_1h > 0 && dexData.volume_24h > 0) {
      if (dexData.volume_1h / dexData.volume_24h > 0.5) {
        reasons.push('volume spike (1h > 50% of 24h)');
      }
    }

    // Very high volume but very few transactions = few wallets faking volume
    if (dexData.volume_24h > 50000 && dexData.txns_24h < 50) {
      reasons.push('high volume with few txns (likely wash trading)');
    }

    // Extremely new with huge volume = likely coordinated launch/rug
    if (dexData.pair_age_hours < 1 && dexData.volume_24h > 200000) {
      reasons.push('brand new with suspicious volume');
    }

    // Low liquidity = easy to rug or manipulate
    if (dexData.liquidity_usd !== undefined && dexData.liquidity_usd < 5000) {
      reasons.push(`low liquidity ($${Math.round(dexData.liquidity_usd)})`);
    }

    // MC/liquidity ratio too high = inflated price with thin liquidity
    if (dexData.market_cap > 0 && dexData.liquidity_usd > 0) {
      const mcLiqRatio = dexData.market_cap / dexData.liquidity_usd;
      if (mcLiqRatio > 20) {
        reasons.push(`mc/liq ratio ${mcLiqRatio.toFixed(0)}x (inflated)`);
      }
    }
  }

  // --- RugCheck API (comprehensive on-chain analysis) ---
  try {
    const res = await fetch(`${RUGCHECK_API}/tokens/${tokenAddress}/report/summary`);
    if (res.ok) {
      const report = await res.json();

      // Rugged flag
      if (report.rugged) {
        reasons.push('flagged as rugged');
        return { safe: false, reasons, score: 0 };
      }

      // Mint authority still active = can print more tokens
      if (report.mintAuthority && report.mintAuthority !== '' && report.mintAuthority !== null) {
        reasons.push('mint authority active');
      }

      // Freeze authority = can freeze your wallet
      if (report.freezeAuthority && report.freezeAuthority !== '' && report.freezeAuthority !== null) {
        reasons.push('freeze authority active');
      }

      // Transfer fee = tax token
      if (report.transferFee && report.transferFee.pct > 0) {
        reasons.push(`transfer fee ${report.transferFee.pct}%`);
      }

      // RugCheck risk flags (skip "Creator history of rugged tokens" — too many false positives)
      if (report.risks && report.risks.length > 0) {
        const dangers = report.risks.filter(r => r.level === 'danger');
        for (const d of dangers) {
          const label = d.name || d.description || 'danger flag';
          if (label.toLowerCase().includes('creator history')) continue;
          reasons.push(label);
        }
      }

      // Low holder count
      if (report.totalHolders !== undefined && report.totalHolders < 30) {
        reasons.push(`only ${report.totalHolders} holders`);
      }

      // Top holder concentration (from topHolders if available)
      if (report.topHolders && Array.isArray(report.topHolders)) {
        const top10Pct = report.topHolders
          .slice(0, 10)
          .reduce((sum, h) => sum + (h.pct || 0), 0);
        if (top10Pct > 50) {
          reasons.push(`top 10 holders own ${top10Pct.toFixed(0)}%`);
        }
        // Single wallet holding >25% = major rug risk
        const biggestHolder = report.topHolders[0];
        if (biggestHolder && (biggestHolder.pct || 0) > 25) {
          reasons.push(`single wallet holds ${biggestHolder.pct.toFixed(0)}%`);
        }
      }

      // Score threshold — RugCheck score (higher = safer)
      const score = report.score || 0;
      return {
        safe: reasons.length === 0,
        reasons,
        score,
        holders: report.totalHolders,
      };
    }
  } catch {}

  // If RugCheck fails, rely on heuristics only
  return {
    safe: reasons.length === 0,
    reasons,
    score: reasons.length === 0 ? 500 : 0,
  };
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
