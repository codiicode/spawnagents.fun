export async function onRequest(context) {
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (context.request.method !== 'POST') return Response.json({ error: "POST required" }, { status: 405 });

  const db = context.env.DB;
  const { agent_id, amount } = await context.request.json();

  if (!agent_id || !amount || amount <= 0) {
    return Response.json({ error: "agent_id and positive amount required" }, { status: 400 });
  }

  const agent = await db.prepare("SELECT id, initial_capital FROM agents WHERE id = ?").bind(agent_id).first();
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

  const newInit = (agent.initial_capital || 0) + amount;
  await db.prepare("UPDATE agents SET initial_capital = ? WHERE id = ?").bind(parseFloat(newInit.toFixed(6)), agent_id).run();

  return Response.json({ agent_id, old_initial: agent.initial_capital, deposit: amount, new_initial: newInit });
}
