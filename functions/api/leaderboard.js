export async function onRequest(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type") || "agents";
  try {
    if (type === "families") {
      const r = await db.prepare("WITH RECURSIVE tree AS (SELECT id, id as root_id, total_pnl FROM agents WHERE parent_id IS NULL UNION ALL SELECT a.id, t.root_id, a.total_pnl FROM agents a JOIN tree t ON a.parent_id = t.id) SELECT root_id as genesis_id, COUNT(*) as family_size, SUM(total_pnl) as family_pnl FROM tree GROUP BY root_id ORDER BY family_pnl DESC LIMIT 20").all();
      return Response.json({ type: "families", leaderboard: r.results });
    }
    const period = url.searchParams.get("period") || "all";

    if (period === "24h") {
      // Get all alive agents with current PnL
      const agents = await db.prepare(
        "SELECT id, name, total_pnl, total_trades FROM agents WHERE status = 'alive' AND id NOT LIKE 'test-%'"
      ).all();

      const kv = context.env.AGENT_KEYS;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const results = [];

      for (const a of agents.results) {
        let pnl24h = 0;
        if (kv) {
          try {
            const raw = await kv.get(`pnl_history:${a.id}`);
            if (raw) {
              const history = JSON.parse(raw);
              // Find oldest point within 24h
              const oldest = history.find(h => h.t >= cutoff);
              if (oldest) {
                pnl24h = (a.total_pnl || 0) - oldest.v;
              } else if (history.length > 0) {
                // All points are older than 24h, use the most recent one
                pnl24h = (a.total_pnl || 0) - history[history.length - 1].v;
              }
            }
          } catch {}
        }
        results.push({ id: a.id, name: a.name, total_pnl: parseFloat(pnl24h.toFixed(4)), total_trades: a.total_trades });
      }

      results.sort((a, b) => b.total_pnl - a.total_pnl);
      return Response.json({ type: "agents", period: "24h", leaderboard: results.slice(0, 20) });
    }

    const r = await db.prepare(
      "SELECT id, name, parent_id, generation, total_pnl, total_trades, status FROM agents WHERE status = 'alive' AND id NOT LIKE 'test-%' ORDER BY total_pnl DESC LIMIT 20"
    ).all();
    return Response.json({ type: "agents", period: "all", leaderboard: r.results });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
