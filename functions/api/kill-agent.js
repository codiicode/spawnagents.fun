import { getBalance, sendSol } from '../_lib/solana.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const body = await context.request.json();
  const { agent_id, owner_wallet } = body;

  if (!agent_id || !owner_wallet) {
    return Response.json({ error: 'Missing agent_id or owner_wallet' }, { status: 400 });
  }

  const db = context.env.DB;
  const kv = context.env.AGENT_KEYS;
  const rpcUrl = context.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

  const TREASURY = '4EtGKSvtteZNafiYTnxRggjMsmazCY5iZEikqTbGgmAc';

  const agent = await db.prepare(
    'SELECT id, owner_wallet, agent_wallet, status, generation, parent_id FROM agents WHERE id = ?'
  ).bind(agent_id).first();

  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (agent.status !== 'alive') return Response.json({ error: 'Agent is not alive' }, { status: 400 });
  if (agent.owner_wallet !== owner_wallet) {
    return Response.json({ error: 'Not the owner of this agent' }, { status: 403 });
  }

  let sol_sent = 0;
  let tx = null;

  // Genesis agents (gen 0, no parent) → SOL goes to treasury
  const isGenesis = agent.generation === 0 && !agent.parent_id;
  const destination = isGenesis ? TREASURY : owner_wallet;

  try {
    const agentSecret = await kv.get(`agent:${agent_id}:secret`);
    if (agentSecret) {
      const balance = await getBalance(agent.agent_wallet, rpcUrl);
      const sendAmount = balance - 0.001;
      if (sendAmount > 0) {
        tx = await sendSol(agentSecret, destination, sendAmount, rpcUrl);
        sol_sent = sendAmount;
      }
    }
  } catch (e) {
    console.error('Kill agent send SOL failed:', e.message);
  }

  // Mark as dead
  await db.prepare(
    "UPDATE agents SET status = 'dead' WHERE id = ?"
  ).bind(agent_id).run();

  await db.prepare(
    "INSERT INTO events (agent_id, type, data) VALUES (?, 'death', ?)"
  ).bind(agent_id, JSON.stringify({ killed_by: 'owner', sol_sent, tx, destination })).run();

  return Response.json({ success: true, agent_id, sol_sent, tx });
}
