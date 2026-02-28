import { getBalance, getTokenBalances } from "../_lib/solana.js";
import { getTokenData } from "../_lib/market-data.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const wallet = url.searchParams.get("wallet");
  if (!wallet) return Response.json({ error: "wallet required" }, { status: 400 });

  const rpcUrl = context.env.RPC_URL;
  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });

  try {
    const [solBalance, tokenBalances] = await Promise.all([
      getBalance(wallet, rpcUrl),
      getTokenBalances(wallet, rpcUrl).catch(() => []),
    ]);

    // Look up prices for each token via DexScreener
    const tokens = [];
    for (const t of tokenBalances) {
      const data = await getTokenData(t.mint).catch(() => null);
      tokens.push({
        mint: t.mint,
        symbol: data?.symbol || t.mint.slice(0, 6),
        amount: t.amount,
        price_usd: data?.price_usd || 0,
        value_usd: (data?.price_usd || 0) * t.amount,
      });
    }

    // SOL price via DexScreener (wrapped SOL pair)
    let solPrice = 0;
    try {
      const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
      if (res.ok) {
        const d = await res.json();
        const usdcPair = (d.pairs || []).find(p => p.chainId === "solana" && p.quoteToken?.symbol === "USDC");
        if (usdcPair) solPrice = parseFloat(usdcPair.priceUsd || 0);
      }
    } catch {}

    const solValueUsd = solBalance * solPrice;
    const tokensValueUsd = tokens.reduce((sum, t) => sum + t.value_usd, 0);

    return Response.json({
      wallet,
      sol_balance: solBalance,
      sol_price: solPrice,
      sol_value_usd: solValueUsd,
      tokens,
      total_value_usd: solValueUsd + tokensValueUsd,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
