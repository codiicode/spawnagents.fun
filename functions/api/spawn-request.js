const SPAWN_COSTS = { 1: 1000000, 2: 750000, 3: 500000, 4: 250000, 5: 100000 };

export async function onRequest(context) {
  if (context.request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  const db = context.env.DB;
  const protocolWallet = context.env.PROTOCOL_WALLET;
  if (!protocolWallet) return Response.json({ error: 'Server config error' }, { status: 500 });

  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { parent_id, sol_amount, owner_wallet } = body;
  if (!parent_id || !sol_amount || !owner_wallet) return Response.json({ error: 'Missing fields' }, { status: 400 });

  // Validate parent
  const parent = await db.prepare('SELECT * FROM agents WHERE id = ?').bind(parent_id).first();
  if (!parent) return Response.json({ error: 'Parent not found' }, { status: 404 });
  if (parent.status !== 'alive') return Response.json({ error: 'Parent not alive' }, { status: 400 });
  // PnL check
  const minPnl = parseFloat(context.env.MIN_SPAWN_PNL || '0.4');
  if (parent.total_pnl < minPnl) {
    return Response.json({ error: `Parent needs ${minPnl} SOL PnL (has ${parent.total_pnl.toFixed(3)})` }, { status: 400 });
  }

  // 6h cooldown between spawns
  const lastSpawn = await db.prepare(
    'SELECT created_at FROM spawns WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(parent_id).first();
  if (lastSpawn) {
    const hours = (Date.now() - new Date(lastSpawn.created_at + 'Z').getTime()) / 3600000;
    if (hours < 6) return Response.json({ error: `Cooldown: ${(6 - hours).toFixed(1)}h remaining` }, { status: 400 });
  }

  // Calculate costs
  const childGen = parent.generation + 1;
  if (childGen > 5) return Response.json({ error: 'Max generation reached (5)' }, { status: 400 });
  const spawnCost = SPAWN_COSTS[childGen] || 100000;

  // Min 1 SOL deposit
  const solDeposit = Math.max(1, parseFloat(sol_amount));

  // Unique micro-offset for SOL amount matching (0.000001–0.009999)
  const microOffset = (Math.floor(Math.random() * 9999) + 1) / 1_000_000;
  const totalSol = parseFloat((solDeposit + microOffset).toFixed(6));

  const spawnId = crypto.randomUUID();

  await db.prepare(
    "INSERT INTO pending_spawns (id, parent_id, owner_wallet, spawn_cost, sol_amount, micro_amount, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
  ).bind(spawnId, parent_id, owner_wallet, spawnCost, totalSol, totalSol).run();

  return Response.json({
    spawn_id: spawnId,
    parent_id,
    child_generation: childGen,
    spawn_cost_tokens: spawnCost,
    spawn_mint: '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump',
    sol_amount: totalSol,
    protocol_wallet: protocolWallet,
  });
}
