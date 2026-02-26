const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const JUPITER_API = "https://quote-api.jup.ag/v6";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export async function getTrendingTokens(focus) {
  try {
    const res = await fetch(`${DEXSCREENER_API}/search?q=SOL`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.pairs || []).filter(p => p.chainId === "solana" && p.liquidity?.usd > 5000).map(p => ({ address: p.baseToken.address, symbol: p.baseToken.symbol, price_usd: parseFloat(p.priceUsd || 0), volume_24h: p.volume?.h24 || 0, liquidity_usd: p.liquidity?.usd || 0 })).slice(0, 20);
  } catch (e) { return []; }
}
export async function getQuote(inputMint, outputMint, amountLamports) {
  try {
    const res = await fetch(
      `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=300`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

export async function getTokenData(tokenMint) {
  try {
    const res = await fetch(`${DEXSCREENER_API}/tokens/${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = (data.pairs || [])[0];
    if (!pair) return null;
    return { address: pair.baseToken.address, symbol: pair.baseToken.symbol, price_usd: parseFloat(pair.priceUsd || 0), volume_24h: pair.volume?.h24 || 0, liquidity_usd: pair.liquidity?.usd || 0 };
  } catch (e) { return null; }
}
