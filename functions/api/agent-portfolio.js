import { getBalance, getTokenBalances } from "../_lib/solana.js";
import { getTokenData } from "../_lib/market-data.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const agentId = url.searchParams.get("agent_id");
  const walletParam = url.searchParams.get("wallet");

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });

  // Resolve wallet — either from agent_id lookup or direct param
  let wallet = walletParam;
  if (agentId && db) {
    const agent = await db.prepare("SELECT agent_wallet FROM agents WHERE id = ?").bind(agentId).first();
    if (agent) wallet = agent.agent_wallet;
  }
  if (!wallet) return Response.json({ error: "wallet or agent_id required" }, { status: 400 });

  try {
    const [solBalance, tokenBalances] = await Promise.all([
      getBalance(wallet, rpcUrl),
      getTokenBalances(wallet, rpcUrl).catch(() => []),
    ]);

    // Get cost basis per token from trades table
    const costBasisMap = {};
    if (agentId && db) {
      const trades = await db.prepare(
        "SELECT token_address, action, amount_sol FROM trades WHERE agent_id = ?"
      ).bind(agentId).all();
      for (const t of trades.results) {
        if (!costBasisMap[t.token_address]) costBasisMap[t.token_address] = 0;
        if (t.action === 'buy') costBasisMap[t.token_address] += t.amount_sol;
        if (t.action === 'sell') costBasisMap[t.token_address] -= t.amount_sol;
      }
    }

    // SOL price via DexScreener
    let solPrice = 0;
    try {
      const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
      if (res.ok) {
        const d = await res.json();
        const usdcPair = (d.pairs || []).find(p => p.chainId === "solana" && p.quoteToken?.symbol === "USDC");
        if (usdcPair) solPrice = parseFloat(usdcPair.priceUsd || 0);
      }
    } catch {}

    // Look up prices and calculate PnL for each token
    const tokens = [];
    for (const t of tokenBalances) {
      const data = await getTokenData(t.mint).catch(() => null);
      const valueUsd = (data?.price_usd || 0) * t.amount;
      const costBasisSol = costBasisMap[t.mint] || 0;
      const costBasisUsd = costBasisSol * solPrice;
      const pnlUsd = costBasisUsd > 0 ? valueUsd - costBasisUsd : 0;
      const pnlPct = costBasisUsd > 0 ? ((valueUsd - costBasisUsd) / costBasisUsd) * 100 : 0;

      tokens.push({
        mint: t.mint,
        symbol: data?.symbol || t.mint.slice(0, 6),
        amount: t.amount,
        price_usd: data?.price_usd || 0,
        value_usd: valueUsd,
        cost_basis_sol: costBasisSol,
        cost_basis_usd: costBasisUsd,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
      });
    }

    const solValueUsd = solBalance * solPrice;
    const tokensValueUsd = tokens.reduce((sum, t) => sum + t.value_usd, 0);
    const totalPnlUsd = tokens.reduce((sum, t) => sum + t.pnl_usd, 0);

    return Response.json({
      wallet,
      sol_balance: solBalance,
      sol_price: solPrice,
      sol_value_usd: solValueUsd,
      tokens,
      total_value_usd: solValueUsd + tokensValueUsd,
      total_pnl_usd: totalPnlUsd,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
