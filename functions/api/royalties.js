export async function onRequest(context) {
  if (context.request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const wallet = url.searchParams.get("wallet");
  if (!wallet) return Response.json({ error: "wallet required" }, { status: 400 });

  // Get all agents owned by this wallet
  const agents = await db.prepare(
    "SELECT id FROM agents WHERE owner_wallet = ?"
  ).bind(wallet).all();
  const agentIds = agents.results.map(a => a.id);
  if (agentIds.length === 0) return Response.json({ paid: {}, received: {} });

  const placeholders = agentIds.map(() => '?').join(',');

  // Royalties paid BY my agents
  const paid = await db.prepare(
    `SELECT from_agent_id, COALESCE(SUM(amount_sol), 0) as total FROM royalties WHERE from_agent_id IN (${placeholders}) AND tx_signature IS NOT NULL GROUP BY from_agent_id`
  ).bind(...agentIds).all();

  // Royalties received BY my agents
  const received = await db.prepare(
    `SELECT to_agent_id, COALESCE(SUM(amount_sol), 0) as total FROM royalties WHERE to_agent_id IN (${placeholders}) AND tx_signature IS NOT NULL GROUP BY to_agent_id`
  ).bind(...agentIds).all();

  const paidMap = {};
  for (const r of paid.results) paidMap[r.from_agent_id] = r.total;
  const receivedMap = {};
  for (const r of received.results) receivedMap[r.to_agent_id] = r.total;

  return Response.json({ paid: paidMap, received: receivedMap });
}
