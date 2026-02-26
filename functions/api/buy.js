import { encode } from '../_lib/base58.js';

const GENESIS_ARCHETYPES = {
  "the-berserker": { name: "The Berserker", tier: "auction" },
  "the-gambler": { name: "The Gambler", tier: "auction" },
  "the-beast": { name: "The Beast", tier: "auction" },
  "the-turtle": { name: "The Turtle", tier: "auction" },
  "the-monk": { name: "The Monk", tier: "auction" },
  "the-wolf": { name: "The Wolf", price: 4 },
  "the-jackal": { name: "The Jackal", price: 4 },
  "the-viper": { name: "The Viper", price: 4 },
  "the-sniper": { name: "The Sniper", price: 3 },
  "the-surgeon": { name: "The Surgeon", price: 3 },
  "the-oracle": { name: "The Oracle", price: 3 },
  "the-hawk": { name: "The Hawk", price: 2 },
  "the-phantom": { name: "The Phantom", price: 2 },
  "the-specter": { name: "The Specter", price: 2 },
  "the-colossus": { name: "The Colossus", price: 2 },
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

  const { agent_id } = body;
  if (!agent_id) return Response.json({ error: 'Missing agent_id' }, { status: 400 });

  const arch = GENESIS_ARCHETYPES[agent_id];
  if (!arch) return Response.json({ error: 'Unknown agent' }, { status: 404 });
  if (arch.tier === 'auction') return Response.json({ error: 'Auction agents cannot be bought directly' }, { status: 400 });

  // Check if already claimed (dead agents can be re-purchased)
  const existing = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(agent_id).first();
  if (existing && existing.status !== 'dead') return Response.json({ error: 'Already claimed' }, { status: 409 });

  // Check for active pending payment
  const pending = await db.prepare(
    "SELECT id FROM payment_requests WHERE agent_id = ? AND status = 'pending' AND created_at > datetime('now', '-30 minutes')"
  ).bind(agent_id).first();
  if (pending) return Response.json({ error: 'Payment already pending for this agent' }, { status: 409 });

  // Generate reference (32 random bytes → base58)
  const refBytes = new Uint8Array(32);
  crypto.getRandomValues(refBytes);
  const reference = encode(refBytes);

  const id = crypto.randomUUID();
  const amount = arch.price;

  // Build Solana Pay URL
  const solanaPayUrl = `solana:${recipient}?amount=${amount}&reference=${reference}&label=SPAWN&message=${encodeURIComponent(arch.name)}`;

  // Save to DB
  await db.prepare(
    'INSERT INTO payment_requests (id, agent_id, amount, reference, recipient, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, agent_id, amount, reference, recipient, 'pending').run();

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
    url: solanaPayUrl,
    reference,
    amount,
    recipient,
    agent: arch.name,
    blockhash,
  });
}
