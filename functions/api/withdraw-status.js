export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'Missing id parameter' }, { status: 400 });

  const db = context.env.DB;
  const wr = await db.prepare(
    'SELECT status, tx_signature, amount_sol, agent_id, method FROM withdrawal_requests WHERE id = ?'
  ).bind(id).first();

  if (!wr) return Response.json({ error: 'Withdrawal not found' }, { status: 404 });

  return Response.json({
    status: wr.status,
    tx_signature: wr.tx_signature,
    amount_sol: wr.amount_sol,
    agent_id: wr.agent_id,
    method: wr.method,
  });
}
