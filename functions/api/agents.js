export async function onRequestGET(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");

  // Single agent with recent trades
  if (id) {
    const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first();
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const trades = await db.prepare(
      "SELECT * FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all();

    const children = await db.prepare(
      "SELECT id, generation, status, total_pnl, total_trades, born_at FROM agents WHERE parent_id = ?"
    ).bind(id).all();

    const royaltiesReceived = await db.prepare(
      "SELECT SUM(amount_sol) as total FROM royalties WHERE to_agent_id = ?"
    ).bind(id).first();

    return Response.json({
      ...agent,
      dna: JSON.parse(agent.dna),
      trades: trades.results,
      children: children.results,
      royalties_received: royaltiesReceived?.total || 0
    });
  }

  // All agents (summary)
  const status = url.searchParams.get("status") || "alive";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

  const agents = await db.prepare(
    "SELECT id, parent_id, generation, owner_wallet, status, total_pnl, total_trades, born_at FROM agents WHERE status = ? ORDER BY total_pnl DESC LIMIT ?"
  ).bind(status, limit).all();

  return Response.json({ agents: agents.results });
}
