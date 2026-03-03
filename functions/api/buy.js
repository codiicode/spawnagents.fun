import { encode } from '../_lib/base58.js';

const GENESIS_ARCHETYPES = {
  "the-berserker": { name: "The Berserker", tier: "degen" },
  "the-gambler": { name: "The Gambler", tier: "degen" },
  "the-beast": { name: "The Beast", tier: "degen" },
  "the-turtle": { name: "The Turtle", tier: "degen" },
  "the-monk": { name: "The Monk", tier: "degen" },
  "the-wolf": { name: "The Wolf", tier: "standard" },
  "the-jackal": { name: "The Jackal", tier: "standard" },
  "the-viper": { name: "The Viper", tier: "standard" },
  "the-sniper": { name: "The Sniper", tier: "standard" },
  "the-surgeon": { name: "The Surgeon", tier: "standard" },
  "the-oracle": { name: "The Oracle", tier: "standard" },
  "the-hawk": { name: "The Hawk", tier: "standard" },
  "the-phantom": { name: "The Phantom", tier: "standard" },
  "the-specter": { name: "The Specter", tier: "standard" },
  "the-colossus": { name: "The Colossus", tier: "standard" },
};

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const db = context.env.DB;
  const recipient = context.env.PROTOCOL_WALLET;

  if (!recipient) {
    return Response.json({ error: 'PROTOCOL_WALLET not configured' }, { status: 500 });
  }

  let body;
  try { body = await context.request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { agent_id, sol_amount, owner_wallet } = body;
  if (!agent_id) return Response.json({ error: 'Missing agent_id' }, { status: 400 });

  const arch = GENESIS_ARCHETYPES[agent_id];
  if (!arch) return Response.json({ error: 'Unknown agent' }, { status: 404 });

  // Validate SOL amount
  const solVal = parseFloat(sol_amount);
  if (!solVal || solVal < 1) return Response.json({ error: 'Minimum 1 SOL' }, { status: 400 });

  // Check if already claimed (dead/unclaimed agents can be re-purchased)
  const existing = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(agent_id).first();
  if (existing && existing.status !== 'dead' && existing.status !== 'unclaimed') return Response.json({ error: 'Already claimed' }, { status: 409 });

  // Determine $SPAWN cost based on tier
  const degenCost = parseInt(context.env.DEGEN_SPAWN_COST || '1500000');
  const standardCost = parseInt(context.env.STANDARD_SPAWN_COST || '3000000');
  const spawn_cost = arch.tier === 'degen' ? degenCost : standardCost;
  const spawn_mint = context.env.SPAWN_MINT || '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump';

  // Generate reference (32 random bytes → base58)
  const refBytes = new Uint8Array(32);
  crypto.getRandomValues(refBytes);
  const reference = encode(refBytes);

  const id = crypto.randomUUID();

  // Add unique micro-offset so manual payments can be matched by amount
  const microOffset = (Math.floor(Math.random() * 9999) + 1) / 1_000_000;
  const amount = parseFloat((solVal + microOffset).toFixed(6));

  // Save to DB
  await db.prepare(
    'INSERT INTO payment_requests (id, agent_id, amount, reference, recipient, status, spawn_cost, owner_wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, agent_id, amount, reference, recipient, 'pending', spawn_cost, owner_wallet || null).run();

  // Fetch recent blockhash for frontend transaction building
  let blockhash = null;
  const rpcUrl = context.env.RPC_URL;
  if (rpcUrl) {
    try {
      const rpcRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'finalized' }],
        }),
      });
      const rpcData = await rpcRes.json();
      blockhash = rpcData.result?.value?.blockhash || null;
    } catch {}
  }

  return Response.json({
    reference,
    amount,
    recipient,
    agent: arch.name,
    tier: arch.tier,
    spawn_cost,
    spawn_mint,
    blockhash,
  });
}
