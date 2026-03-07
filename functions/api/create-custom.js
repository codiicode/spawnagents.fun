import { encode } from '../_lib/base58.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try { body = await context.request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, dna, meta, owner_wallet, sol_amount } = body;

  if (!name || !dna || !owner_wallet || !sol_amount) {
    return Response.json({ error: 'Missing fields: name, dna, owner_wallet, sol_amount' }, { status: 400 });
  }

  // Validate name
  const cleanName = name.trim().slice(0, 24);
  if (cleanName.length < 2) {
    return Response.json({ error: 'Name must be at least 2 characters' }, { status: 400 });
  }

  // Validate DNA parameters
  const errors = [];
  if (typeof dna.aggression !== 'number' || dna.aggression < 0 || dna.aggression > 1) errors.push('aggression must be 0-1');
  if (typeof dna.risk_tolerance !== 'number' || dna.risk_tolerance < 0 || dna.risk_tolerance > 1) errors.push('risk_tolerance must be 0-1');
  if (typeof dna.patience !== 'number' || dna.patience < 0 || dna.patience > 1) errors.push('patience must be 0-1');
  if (typeof dna.sell_profit_pct !== 'number' || dna.sell_profit_pct < 0 || dna.sell_profit_pct > 1000) errors.push('sell_profit_pct must be 0-1000');
  if (typeof dna.sell_loss_pct !== 'number' || dna.sell_loss_pct < 1 || dna.sell_loss_pct > 100) errors.push('sell_loss_pct must be 1-100');
  if (typeof dna.max_position_pct !== 'number' || dna.max_position_pct < 10 || dna.max_position_pct > 90) errors.push('max_position_pct must be 10-90');
  if (errors.length > 0) {
    return Response.json({ error: errors.join(', ') }, { status: 400 });
  }

  // Min 0.5 SOL deposit
  const solDeposit = Math.max(0.5, parseFloat(sol_amount));

  const db = context.env.DB;
  const protocolWallet = context.env.PROTOCOL_WALLET;
  if (!protocolWallet) return Response.json({ error: 'Server config error' }, { status: 500 });

  // Generate unique agent ID
  const idBytes = new Uint8Array(4);
  crypto.getRandomValues(idBytes);
  const agentId = 'agent_' + Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Build full DNA — use user-provided advanced values if present, else derive
  const isDegen = !!dna.degen;
  const holders = (typeof dna.buy_threshold_holders === 'number' && dna.buy_threshold_holders >= 10 && dna.buy_threshold_holders <= 2000)
    ? dna.buy_threshold_holders
    : (isDegen ? 50 : Math.round(100 + (1 - dna.risk_tolerance) * 2000));
  const volume = (typeof dna.buy_threshold_volume === 'number' && dna.buy_threshold_volume >= 1000 && dna.buy_threshold_volume <= 1000000)
    ? dna.buy_threshold_volume
    : (isDegen ? 20000 : Math.round(500 + (1 - dna.risk_tolerance) * 7000));
  const maxPositions = (typeof dna.max_positions === 'number' && dna.max_positions >= 1 && dna.max_positions <= 5)
    ? dna.max_positions : undefined;

  const fullDna = {
    aggression: dna.aggression,
    patience: dna.patience,
    risk_tolerance: dna.risk_tolerance,
    sell_profit_pct: dna.sell_profit_pct,
    sell_loss_pct: dna.sell_loss_pct,
    max_position_pct: dna.max_position_pct,
    buy_threshold_holders: holders,
    buy_threshold_volume: volume,
    check_interval_min: Math.max(2, Math.round(2 + dna.patience * 10)),
    ...(maxPositions ? { max_positions: maxPositions } : {}),
    ...(isDegen ? { degen: true } : {}),
  };

  // Generate reference address for payment tracking
  const refBytes = new Uint8Array(32);
  crypto.getRandomValues(refBytes);
  const reference = encode(refBytes);

  // Micro-offset for unique amount matching
  const microOffset = (Math.floor(Math.random() * 9999) + 1) / 1_000_000;
  const totalSol = parseFloat((solDeposit + microOffset).toFixed(6));

  const paymentId = crypto.randomUUID();

  // Store payment request with custom DNA
  await db.prepare(
    "INSERT INTO payment_requests (id, agent_id, amount, reference, recipient, status, spawn_cost, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, datetime('now'))"
  ).bind(paymentId, agentId, totalSol, reference, protocolWallet).run();

  // Store custom DNA, name, and meta in KV (verify-payments will read this when confirming)
  const kv = context.env.AGENT_KEYS;
  if (kv) {
    await kv.put(`custom:${agentId}:dna`, JSON.stringify(fullDna), { expirationTtl: 86400 });
    await kv.put(`custom:${agentId}:name`, cleanName, { expirationTtl: 86400 });
    await kv.put(`custom:${agentId}:owner`, owner_wallet, { expirationTtl: 86400 });
    if (meta) await kv.put(`custom:${agentId}:meta`, JSON.stringify(meta), { expirationTtl: 86400 });
  }

  return Response.json({
    payment_id: paymentId,
    agent_id: agentId,
    agent_name: cleanName,
    amount: totalSol,
    reference,
    recipient: protocolWallet,
    dna: fullDna,
  });
}
