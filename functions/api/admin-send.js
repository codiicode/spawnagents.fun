import { sendSol } from '../_lib/solana.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  const secret = context.request.headers.get('x-cron-secret');
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await context.request.json();
  const { agent_id, amount_sol, destination } = body;
  if (!agent_id || !amount_sol || !destination) return Response.json({ error: 'Missing agent_id, amount_sol, destination' }, { status: 400 });

  const kv = context.env.AGENT_KEYS;
  const rpcUrl = body.rpc_url || context.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

  const agentSecret = await kv.get(`agent:${agent_id}:secret`);
  if (!agentSecret) return Response.json({ error: 'No keypair found' }, { status: 404 });

  try {
    const tx = await sendSol(agentSecret, destination, amount_sol, rpcUrl);
    return Response.json({ success: true, tx, amount_sol, destination });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
