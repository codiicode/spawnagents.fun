export async function onRequest(context) {
  const db = context.env.DB;
  try {
    const r = await db.batch([
      db.prepare("SELECT COUNT(*) as total FROM agents"),
      db.prepare("SELECT COUNT(*) as alive FROM agents WHERE status = 'alive'"),
      db.prepare("SELECT COALESCE(SUM(total_pnl), 0) as pnl FROM agents"),
      db.prepare("SELECT COUNT(*) as total FROM trades"),
      db.prepare("SELECT MAX(generation) as max_gen FROM agents"),
    ]);
    return Response.json({ agents: { total: r[0].results[0].total, alive: r[1].results[0].alive }, total_pnl_sol: r[2].results[0].pnl, total_trades: r[3].results[0].total, max_generation: r[4].results[0].max_gen || 0 });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
