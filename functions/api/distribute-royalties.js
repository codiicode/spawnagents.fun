export async function onRequest(context) {
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const db = context.env.DB;
  const royaltyPct = parseFloat(context.env.ROYALTY_PCT || "0.1");
  const maxGen = parseInt(context.env.MAX_GENERATIONS || "5");
  const profitable = await db.prepare("SELECT * FROM agents WHERE status = 'alive' AND total_pnl > 0 AND parent_id IS NOT NULL").all();
  const batch = [];
  for (const agent of profitable.results) {
    const paid = await db.prepare("SELECT COALESCE(SUM(amount_sol), 0) as paid FROM royalties WHERE from_agent_id = ?").bind(agent.id).first();
    const remaining = agent.total_pnl * royaltyPct - (paid?.paid || 0);
    if (remaining <= 0.001) continue;
    let currentId = agent.parent_id, depth = 0, share = remaining;
    while (currentId && depth < maxGen) {
      const p = await db.prepare("SELECT id, parent_id FROM agents WHERE id = ?").bind(currentId).first();
      if (!p) break;
      const payout = share * 0.5;
      if (payout > 0.001) batch.push(db.prepare("INSERT INTO royalties (from_agent_id, to_agent_id, amount_sol, generation_depth) VALUES (?, ?, ?, ?)").bind(agent.id, p.id, payout, depth + 1));
      share *= 0.5; currentId = p.parent_id; depth++;
    }
  }
  if (batch.length > 0) await db.batch(batch);
  return Response.json({ processed: profitable.results.length, royalties: batch.length });
}
