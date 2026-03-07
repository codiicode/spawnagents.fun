export async function onRequest(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type") || "agents";
  try {
    if (type === "families") {
      const r = await db.prepare("WITH RECURSIVE tree AS (SELECT id, id as root_id, total_pnl FROM agents WHERE parent_id IS NULL UNION ALL SELECT a.id, t.root_id, a.total_pnl FROM agents a JOIN tree t ON a.parent_id = t.id) SELECT root_id as genesis_id, COUNT(*) as family_size, SUM(total_pnl) as family_pnl FROM tree GROUP BY root_id ORDER BY family_pnl DESC LIMIT 20").all();
      return Response.json({ type: "families", leaderboard: r.results });
    }
    const r = await db.prepare(
      "SELECT id, name, parent_id, generation, total_pnl, total_trades, status FROM agents WHERE status = 'alive' AND id NOT LIKE 'test-%' ORDER BY total_pnl DESC LIMIT 20"
    ).all();
    return Response.json({ type: "agents", leaderboard: r.results });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
