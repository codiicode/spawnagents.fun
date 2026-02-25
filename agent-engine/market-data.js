const JUPITER_API = "https://quote-api.jup.ag/v6";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Fetch trending tokens from DexScreener
export async function getTrendingTokens(focus = "memecoin") {
  try {
    const res = await fetch(`${DEXSCREENER_API}/search?q=SOL`);
    if (!res.ok) return [];
    const data = await res.json();

    return (data.pairs || [])
      .filter(p => p.chainId === "solana" && p.liquidity?.usd > 5000)
      .map(p => ({
        address: p.baseToken.address,
        symbol: p.baseToken.symbol,
        price_usd: parseFloat(p.priceUsd || 0),
        volume_24h: p.volume?.h24 || 0,
        liquidity_usd: p.liquidity?.usd || 0,
        price_change_24h: p.priceChange?.h24 || 0,
        pair_created_at: p.pairCreatedAt,
        holders: 0, // DexScreener doesn't provide holder count directly
      }))
      .slice(0, 20);
  } catch (e) {
    console.error("Failed to fetch trending tokens:", e);
    return [];
  }
}

// Get token data for a specific mint
export async function getTokenData(tokenMint) {
  try {
    const res = await fetch(`${DEXSCREENER_API}/tokens/${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json();

    const pair = (data.pairs || [])[0];
    if (!pair) return null;

    return {
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      price_usd: parseFloat(pair.priceUsd || 0),
      volume_24h: pair.volume?.h24 || 0,
      volume_1h: pair.volume?.h1 || 0,
      liquidity_usd: pair.liquidity?.usd || 0,
      price_change_24h: pair.priceChange?.h24 || 0,
      price_change_1h: pair.priceChange?.h1 || 0,
    };
  } catch (e) {
    console.error("Failed to fetch token data:", e);
    return null;
  }
}

// Get Jupiter quote for a swap
export async function getQuote(inputMint, outputMint, amountLamports) {
  try {
    const res = await fetch(
      `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=300`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("Failed to get Jupiter quote:", e);
    return null;
  }
}

export { SOL_MINT };
