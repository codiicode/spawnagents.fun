export async function onRequest(context) {
  const db = context.env.DB;
  try {
    const r = await db.batch([
      db.prepare("SELECT COUNT(*) as alive FROM agents WHERE status = 'alive'"),
      db.prepare("SELECT COUNT(*) as dead FROM agents WHERE status = 'dead'"),
      db.prepare("SELECT COUNT(*) as total FROM trades"),
      db.prepare("SELECT COUNT(*) as cnt FROM trades WHERE created_at > datetime('now', '-24 hours')"),
      db.prepare("SELECT COALESCE(SUM(amount_sol), 0) as vol FROM trades WHERE action = 'buy' AND created_at > datetime('now', '-24 hours')"),
      db.prepare("SELECT id, COALESCE(name, REPLACE(REPLACE(id, 'the-', 'The '), '-', ' ')) as name, total_pnl FROM agents WHERE status = 'alive' ORDER BY total_pnl DESC LIMIT 1"),
    ]);
    const best = r[5].results[0];
    return Response.json({
      agents_alive: r[0].results[0].alive,
      agents_dead: r[1].results[0].dead,
      total_trades: r[2].results[0].total,
      trades_24h: r[3].results[0].cnt,
      volume_24h_sol: parseFloat(r[4].results[0].vol.toFixed(4)),
      best_agent: best ? { id: best.id, name: best.name, pnl: best.total_pnl } : null,
    }, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
