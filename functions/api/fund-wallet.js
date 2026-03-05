import { sendSol } from '../_lib/solana.js';

export async function onRequest(context) {
  const secret = context.request.headers.get('x-cron-secret');
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(context.request.url);
  const to = url.searchParams.get('to');
  const amount = parseFloat(url.searchParams.get('amount'));

  if (!to || !amount || amount <= 0) return Response.json({ error: 'Need to and amount params' }, { status: 400 });

  const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;
  if (!protocolSecret) return Response.json({ error: 'No protocol key' }, { status: 500 });

  const rpcUrl = context.env.RPC_URL;
  try {
    const tx = await sendSol(protocolSecret, to, amount, rpcUrl);
    return Response.json({ success: true, to, amount, tx });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
