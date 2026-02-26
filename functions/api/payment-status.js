export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(context.request.url);
  const ref = url.searchParams.get('ref');
  if (!ref) return Response.json({ error: 'Missing ref parameter' }, { status: 400 });

  const db = context.env.DB;
  const pr = await db.prepare(
    'SELECT status, tx_signature, buyer_wallet, agent_id, amount FROM payment_requests WHERE reference = ?'
  ).bind(ref).first();

  if (!pr) return Response.json({ error: 'Payment not found' }, { status: 404 });

  return Response.json({
    status: pr.status,
    tx_signature: pr.tx_signature,
    buyer_wallet: pr.buyer_wallet,
    agent_id: pr.agent_id,
    amount: pr.amount,
  });
}
