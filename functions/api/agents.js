export async function onRequest(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  try {
    if (id) {
      const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first();
      if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
      const trades = await db.prepare("SELECT * FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all();
      const children = await db.prepare("SELECT id, generation, status, total_pnl FROM agents WHERE parent_id = ?").bind(id).all();
      agent.dna = JSON.parse(agent.dna || "{}");
      return Response.json({ agent, trades: trades.results, children: children.results });
    }
    const status = url.searchParams.get("status") || "alive";
    const agents = await db.prepare("SELECT id, parent_id, generation, owner_wallet, status, total_pnl, created_at FROM agents WHERE status = ? ORDER BY created_at DESC LIMIT 100").bind(status).all();
    return Response.json({ agents: agents.results });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
