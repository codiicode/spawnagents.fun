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

  const agents = await db.prepare("SELECT id, agent_wallet, initial_capital, total_withdrawn FROM agents WHERE status = 'alive'").all();
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
      const withdrawn = agent.total_withdrawn || 0;

      // Include royalties paid OUT from this agent (so they don't count as losses)
      const royaltiesPaidRow = await db.prepare(
        "SELECT COALESCE(SUM(amount_sol), 0) as total FROM royalties WHERE from_agent_id = ? AND tx_signature IS NOT NULL"
      ).bind(agent.id).first();
      const royaltiesPaid = royaltiesPaidRow?.total || 0;

      const realPnl = (totalValue + withdrawn + royaltiesPaid) - (agent.initial_capital || 0);

      // Fitness: Sharpe ratio + win rate + drawdown
      const agentTrades = await db.prepare(
        `SELECT token_address, action, amount_sol FROM trades WHERE agent_id = ? ORDER BY created_at ASC`
      ).bind(agent.id).all();

      const openBuys = {};
      const positions = [];
      for (const t of agentTrades.results) {
        if (t.action === 'buy') {
          openBuys[t.token_address] = (openBuys[t.token_address] || 0) + t.amount_sol;
        } else if (t.action === 'sell' && openBuys[t.token_address]) {
          const ret = openBuys[t.token_address] > 0 ? (t.amount_sol / openBuys[t.token_address]) - 1 : 0;
          positions.push(ret);
          openBuys[t.token_address] = 0;
        }
      }

      let fitnessScore = 0;
      if (positions.length >= 3) {
        const winRate = positions.filter(r => r > 0).length / positions.length;
        const avgRet = positions.reduce((s, r) => s + r, 0) / positions.length;
        const stdDev = Math.sqrt(positions.reduce((s, r) => s + (r - avgRet) ** 2, 0) / positions.length) || 0.01;
        const sharpe = avgRet / stdDev;

        let cum = 0, peak = 0, maxDD = 0;
        for (const r of positions) {
          cum += r;
          if (cum > peak) peak = cum;
          if (peak - cum > maxDD) maxDD = peak - cum;
        }
        const ddPenalty = Math.max(0, 1 - maxDD);
        fitnessScore = sharpe * 0.4 + winRate * 0.3 + ddPenalty * 0.3;
      } else {
        fitnessScore = realPnl > 0 ? realPnl * 0.5 : realPnl;
      }

      await db.prepare("UPDATE agents SET total_pnl = ?, fitness_score = ? WHERE id = ?").bind(parseFloat(realPnl.toFixed(6)), parseFloat(fitnessScore.toFixed(6)), agent.id).run();
      results.push({ agent: agent.id, sol: solBal.toFixed(4), tokens_sol: tokenValueSol.toFixed(4), total: totalValue.toFixed(4), pnl: realPnl.toFixed(4), fitness: fitnessScore.toFixed(4) });
    } catch (e) {
      results.push({ agent: agent.id, error: e.message });
    }
  }

  return Response.json({ sol_price: solPrice, results });
}
