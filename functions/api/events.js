export async function onRequest(context) {
  if (context.request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 50);
  const agentId = url.searchParams.get("agent_id");

  let events;
  if (agentId) {
    events = await db.prepare("SELECT * FROM events WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").bind(agentId, limit).all();
  } else {
    events = await db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").bind(limit).all();
  }
  return Response.json({ events: events.results });
}
