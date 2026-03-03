import { getBalance, getTokenBalances, SOL_MINT } from "../_lib/solana.js";
import { getTokenPrice } from "../_lib/market-data.js";

export async function onRequest(context) {
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });

  // SOL price from DexScreener — skip entire PnL cycle if fetch fails
  let solPrice = 0;
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
    if (res.ok) {
      const d = await res.json();
      const usdcPair = (d.pairs || []).find(p => p.chainId === "solana" && p.quoteToken?.symbol === "USDC");
      if (usdcPair) solPrice = parseFloat(usdcPair.priceUsd || 0);
    }
  } catch {}

  if (solPrice <= 0) {
    return Response.json({ skipped: true, reason: "Could not fetch SOL price" });
  }

  const agents = await db.prepare("SELECT id, agent_wallet, initial_capital FROM agents WHERE status = 'alive'").all();
  const results = [];

  for (const agent of agents.results) {
    try {
      const solBal = await getBalance(agent.agent_wallet, rpcUrl);
      const tokens = await getTokenBalances(agent.agent_wallet, rpcUrl).catch(() => []);
      let tokenValueSol = 0;
      for (const t of tokens) {
        const td = await getTokenPrice(t.mint).catch(() => null);
        if (td && td.price_usd > 0) {
          tokenValueSol += (td.price_usd * t.amount) / solPrice;
        }
      }
      const totalValue = solBal + tokenValueSol;
      const realPnl = totalValue - (agent.initial_capital || 0);
      await db.prepare("UPDATE agents SET total_pnl = ? WHERE id = ?").bind(parseFloat(realPnl.toFixed(6)), agent.id).run();
      results.push({ agent: agent.id, sol: solBal.toFixed(4), tokens_sol: tokenValueSol.toFixed(4), total: totalValue.toFixed(4), pnl: realPnl.toFixed(4) });
    } catch (e) {
      results.push({ agent: agent.id, error: e.message });
    }
  }

  return Response.json({ sol_price: solPrice, results });
}
