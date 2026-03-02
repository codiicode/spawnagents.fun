export async function onRequest(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  try {
    if (id) {
      const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first();
      if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
      const trades = await db.prepare("SELECT * FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all();
      const children = await db.prepare("SELECT id, name, generation, status, total_pnl FROM agents WHERE parent_id = ?").bind(id).all();
      agent.dna = JSON.parse(agent.dna || "{}");
      return Response.json({ agent, trades: trades.results, children: children.results });
    }
    const status = url.searchParams.get("status");
    let query, params;
    if (status) {
      query = "SELECT id, name, parent_id, generation, owner_wallet, agent_wallet, dna, status, total_pnl, total_trades, born_at, last_trade_at FROM agents WHERE status = ? ORDER BY born_at DESC LIMIT 100";
      params = [status];
    } else {
      query = "SELECT id, name, parent_id, generation, owner_wallet, agent_wallet, dna, status, total_pnl, total_trades, born_at, last_trade_at FROM agents ORDER BY born_at DESC LIMIT 100";
      params = [];
    }
    const stmt = params.length ? db.prepare(query).bind(...params) : db.prepare(query);
    const agents = await stmt.all();
    return Response.json({ agents: agents.results });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
