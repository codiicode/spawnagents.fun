import { processAgent } from "../_lib/engine.js";
export async function onRequest(context) {
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const db = context.env.DB;
  const agents = await db.prepare("SELECT * FROM agents WHERE status = 'alive'").all();
  const results = [];
  for (const agent of agents.results) {
    const dna = JSON.parse(agent.dna);
    const lastTrade = await db.prepare("SELECT created_at FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1").bind(agent.id).first();
    if (lastTrade) {
      const mins = (Date.now() - new Date(lastTrade.created_at + "Z").getTime()) / 60000;
      if (mins < (dna.check_interval_min || 5)) { results.push({ agent: agent.id, skipped: true }); continue; }
    }
    try {
      const decision = await processAgent(agent, db);
      if (decision.action === "buy") {
        await db.batch([
          db.prepare("INSERT INTO trades (agent_id, token_address, action, amount_sol, price_at_trade) VALUES (?, ?, 'buy', ?, ?)").bind(agent.id, decision.token, decision.amount_sol, 0),
          db.prepare("UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?").bind(agent.id),
          db.prepare("INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)").bind(agent.id, JSON.stringify({ action: "buy", token: decision.symbol, amount: decision.amount_sol }))
        ]);
      } else if (decision.action === "sell") {
        const pnl = decision.pnl_pct ? (decision.pnl_pct / 100) * 0.01 : 0;
        await db.batch([
          db.prepare("INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade) VALUES (?, ?, 'sell', ?, ?, ?, ?)").bind(agent.id, decision.token, 0, decision.amount, pnl, 0),
          db.prepare("UPDATE agents SET total_trades = total_trades + 1, total_pnl = total_pnl + ?, last_trade_at = datetime('now') WHERE id = ?").bind(pnl, agent.id),
          db.prepare("INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)").bind(agent.id, JSON.stringify({ action: "sell", token: decision.symbol, pnl_pct: decision.pnl_pct }))
        ]);
      }
      results.push({ agent: agent.id, action: decision.action, reason: decision.reason });
    } catch (e) { results.push({ agent: agent.id, error: e.message }); }
  }
  return Response.json({ processed: agents.results.length, results });
}
