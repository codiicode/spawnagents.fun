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
      results.push({ agent: agent.id, action: decision.action, reason: decision.reason });
    } catch (e) { results.push({ agent: agent.id, error: e.message }); }
  }
  return Response.json({ processed: agents.results.length, results });
}
