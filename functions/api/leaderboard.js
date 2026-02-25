export async function onRequestGET(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type") || "agents";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 50);

  if (type === "families") {
    // Top genesis agents by total ecosystem PnL (self + all descendants)
    const families = await db.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT id, parent_id, total_pnl, generation
        FROM agents WHERE generation = 0
        UNION ALL
        SELECT a.id, a.parent_id, a.total_pnl, a.generation
        FROM agents a
        JOIN descendants d ON a.parent_id = d.id
      )
      SELECT
        g.id,
        g.owner_wallet,
        g.total_pnl as genesis_pnl,
        COUNT(d.id) as family_size,
        SUM(d.total_pnl) as family_pnl,
        MAX(d.generation) as deepest_generation
      FROM agents g
      LEFT JOIN descendants d ON d.id != g.id
      WHERE g.generation = 0
      GROUP BY g.id
      ORDER BY family_pnl DESC
      LIMIT ?
    `).bind(limit).all();

    return Response.json({ families: families.results });
  }

  // Top agents by PnL
  const agents = await db.prepare(`
    SELECT id, parent_id, generation, owner_wallet, total_pnl, total_trades, status, born_at
    FROM agents
    ORDER BY total_pnl DESC
    LIMIT ?
  `).bind(limit).all();

  return Response.json({ agents: agents.results });
}
