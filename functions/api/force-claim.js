import { generateKeypair, sendSol } from '../_lib/solana.js';

const GENESIS_DNA = {
  "the-berserker": { degen: true, aggression: 0.95, patience: 0.05, risk_tolerance: 0.95, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 100, sell_loss_pct: 15, max_position_pct: 80, check_interval_min: 2 },
  "the-monk": { degen: true, aggression: 0.88, patience: 0.2, risk_tolerance: 0.9, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 200, sell_loss_pct: 12, max_position_pct: 60, check_interval_min: 3 },
  "the-gambler": { degen: true, aggression: 0.92, patience: 0.1, risk_tolerance: 0.99, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 250, sell_loss_pct: 50, max_position_pct: 85, check_interval_min: 2 },
  "the-turtle": { degen: true, aggression: 0.85, patience: 0.25, risk_tolerance: 0.88, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 150, sell_loss_pct: 10, max_position_pct: 50, check_interval_min: 3 },
  "the-beast": { degen: true, aggression: 0.98, patience: 0.05, risk_tolerance: 0.98, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 120, sell_loss_pct: 30, max_position_pct: 85, check_interval_min: 2 },
  "the-wolf": { aggression: 0.75, patience: 0.35, risk_tolerance: 0.7, buy_threshold_holders: 300, buy_threshold_volume: 800, sell_profit_pct: 40, sell_loss_pct: 15, max_position_pct: 60, check_interval_min: 3 },
  "the-jackal": { aggression: 0.7, patience: 0.3, risk_tolerance: 0.65, buy_threshold_holders: 250, buy_threshold_volume: 600, sell_profit_pct: 30, sell_loss_pct: 18, max_position_pct: 55, check_interval_min: 4 },
  "the-viper": { aggression: 0.8, patience: 0.25, risk_tolerance: 0.75, buy_threshold_holders: 200, buy_threshold_volume: 500, sell_profit_pct: 22, sell_loss_pct: 20, max_position_pct: 65, check_interval_min: 3 },
  "the-sniper": { aggression: 0.3, patience: 0.85, risk_tolerance: 0.4, buy_threshold_holders: 1500, buy_threshold_volume: 5000, sell_profit_pct: 50, sell_loss_pct: 8, max_position_pct: 35, check_interval_min: 10 },
  "the-surgeon": { aggression: 0.45, patience: 0.7, risk_tolerance: 0.3, buy_threshold_holders: 1000, buy_threshold_volume: 3000, sell_profit_pct: 25, sell_loss_pct: 6, max_position_pct: 30, check_interval_min: 5 },
  "the-oracle": { aggression: 0.25, patience: 0.88, risk_tolerance: 0.25, buy_threshold_holders: 2500, buy_threshold_volume: 8000, sell_profit_pct: 70, sell_loss_pct: 5, max_position_pct: 20, check_interval_min: 12 },
  "the-hawk": { aggression: 0.6, patience: 0.5, risk_tolerance: 0.5, buy_threshold_holders: 500, buy_threshold_volume: 2000, sell_profit_pct: 35, sell_loss_pct: 10, max_position_pct: 45, check_interval_min: 5 },
  "the-phantom": { aggression: 0.4, patience: 0.75, risk_tolerance: 0.35, buy_threshold_holders: 1200, buy_threshold_volume: 4000, sell_profit_pct: 45, sell_loss_pct: 7, max_position_pct: 25, check_interval_min: 8 },
  "the-specter": { aggression: 0.35, patience: 0.8, risk_tolerance: 0.3, buy_threshold_holders: 1800, buy_threshold_volume: 6000, sell_profit_pct: 55, sell_loss_pct: 6, max_position_pct: 22, check_interval_min: 10 },
  "the-colossus": { aggression: 0.5, patience: 0.6, risk_tolerance: 0.5, buy_threshold_holders: 800, buy_threshold_volume: 2500, sell_profit_pct: 40, sell_loss_pct: 10, max_position_pct: 40, check_interval_min: 6 },
};

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const cronSecret = context.request.headers.get('X-Cron-Secret');
  if (cronSecret !== context.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await context.request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { tx_signature, agent_id, buyer_wallet, amount_sol } = body;
  if (!tx_signature || !agent_id || !buyer_wallet || !amount_sol) {
    return Response.json({ error: 'Missing fields: tx_signature, agent_id, buyer_wallet, amount_sol' }, { status: 400 });
  }

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const kv = context.env.AGENT_KEYS;
  const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;

  // Check agent doesn't exist or is reclaimable
  const existing = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(agent_id).first();
  if (existing && existing.status !== 'dead' && existing.status !== 'unclaimed') {
    return Response.json({ error: 'Agent already claimed' }, { status: 409 });
  }

  let dna = GENESIS_DNA[agent_id];
  // Support custom DNA for spawned agents
  if (!dna && body.dna) dna = body.dna;
  if (!dna) return Response.json({ error: 'Unknown agent' }, { status: 404 });

  // Generate keypair
  const keypair = await generateKeypair();
  if (kv) await kv.put(`agent:${agent_id}:secret`, keypair.secretKey);

  // Fund agent (90% of payment)
  const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.05');
  const tradingCapital = amount_sol * (1 - feePct);

  let fundingTx;
  try {
    fundingTx = await sendSol(protocolSecret, keypair.publicKey, tradingCapital, rpcUrl);
  } catch (e) {
    return Response.json({ error: `Funding failed: ${e.message}` }, { status: 500 });
  }

  // Create or update agent
  const parentId = body.parent_id || null;
  const generation = body.generation || 0;
  const agentName = body.name || null;

  if (existing) {
    await db.prepare(
      "UPDATE agents SET owner_wallet = ?, agent_wallet = ?, dna = ?, status = 'alive', initial_capital = ?, total_pnl = 0, total_trades = 0, total_royalties_paid = 0, parent_id = COALESCE(?, parent_id), generation = ?, name = COALESCE(?, name) WHERE id = ?"
    ).bind(buyer_wallet, keypair.publicKey, JSON.stringify(dna), tradingCapital, parentId, generation, agentName, agent_id).run();
  } else {
    await db.prepare(
      "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital, name) VALUES (?, ?, ?, ?, ?, ?, 'alive', ?, ?)"
    ).bind(agent_id, parentId, generation, buyer_wallet, keypair.publicKey, JSON.stringify(dna), tradingCapital, agentName).run();
  }

  // Mark any matching payment requests as confirmed
  await db.prepare(
    "UPDATE payment_requests SET status = 'confirmed', buyer_wallet = ?, tx_signature = ?, confirmed_at = datetime('now') WHERE agent_id = ? AND status IN ('pending', 'expired')"
  ).bind(buyer_wallet, tx_signature, agent_id).run();

  // Log event
  await db.prepare(
    "INSERT INTO events (agent_id, type, data) VALUES (?, 'genesis_claimed', ?)"
  ).bind(agent_id, JSON.stringify({
    buyer: buyer_wallet, amount: amount_sol, tx: tx_signature,
    agent_wallet: keypair.publicKey, trading_capital: tradingCapital,
    funding_tx: fundingTx, method: 'force_claim',
  })).run();

  return Response.json({
    success: true,
    agent_id,
    agent_wallet: keypair.publicKey,
    trading_capital: tradingCapital,
    funding_tx: fundingTx,
  });
}
