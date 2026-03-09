export async function onRequest(context) {
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = context.env.DB;
  const agents = await db.prepare("SELECT id, agent_wallet FROM agents WHERE status = 'alive'").all();
  return Response.json(agents.results);
}
