import { encode } from '../_lib/base58.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const db = context.env.DB;
  const recipient = context.env.PROTOCOL_WALLET;
  if (!recipient) return Response.json({ error: 'Not configured' }, { status: 500 });

  // Generate unique reference
  const refBytes = new Uint8Array(32);
  crypto.getRandomValues(refBytes);
  const reference = encode(refBytes);

  // Random micro amount: 0.001 + random 0.000001-0.000999
  const micro = 0.001 + Math.floor(Math.random() * 999) / 1000000;
  const microAmount = parseFloat(micro.toFixed(6));

  const id = crypto.randomUUID();

  await db.prepare(
    "INSERT INTO login_requests (id, micro_amount, reference, status) VALUES (?, ?, ?, 'pending')"
  ).bind(id, microAmount, reference).run();

  // Expire old requests
  await db.prepare(
    "DELETE FROM login_requests WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')"
  ).run();

  return Response.json({ id, micro_amount: microAmount, reference, send_to: recipient });
}
