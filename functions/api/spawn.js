import { mutate } from "../../agent-engine/mutator.js";

export async function onRequestPOST(context) {
  const db = context.env.DB;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { parent_id, blood_amount, burn_tx, owner_wallet, agent_wallet } = body;

  if (!parent_id || !blood_amount || !owner_wallet || !agent_wallet) {
    return Response.json({ error: "Missing required fields: parent_id, blood_amount, owner_wallet, agent_wallet" }, { status: 400 });
  }

  // 1. Verify parent exists and is eligible
  const parent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(parent_id).first();
  if (!parent) return Response.json({ error: "Parent not found" }, { status: 404 });
  if (parent.status !== "alive") return Response.json({ error: "Parent is not alive" }, { status: 400 });

  const minPnl = parseFloat(context.env.MIN_SPAWN_PNL || "0.5");
  if (parent.total_pnl < minPnl) {
    return Response.json({ error: `Parent needs at least ${minPnl} SOL PnL to reproduce (has ${parent.total_pnl})` }, { status: 400 });
  }

  // 2. Check cooldown (7 days since last spawn)
  const lastSpawn = await db.prepare(
    "SELECT created_at FROM spawns WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(parent_id).first();

  if (lastSpawn) {
    const daysSince = (Date.now() - new Date(lastSpawn.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) {
      return Response.json({ error: `Cooldown: ${(7 - daysSince).toFixed(1)} days remaining` }, { status: 400 });
    }
  }

  // 3. Check minimum $BLOOD cost (scales with generation)
  const childGeneration = parent.generation + 1;
  const minBlood = 1000 * childGeneration;
  if (blood_amount < minBlood) {
    return Response.json({ error: `Generation ${childGeneration} requires at least ${minBlood} $BLOOD (got ${blood_amount})` }, { status: 400 });
  }

  // 4. TODO: Verify $BLOOD burn on-chain (burn_tx)
  // For now we trust the caller — on-chain verification comes in token integration phase

  // 5. Mutate DNA
  const parentDna = JSON.parse(parent.dna);
  const { childDna, mutations } = mutate(parentDna);

  // 6. Create child agent
  const childId = `agent_${crypto.randomUUID().slice(0, 8)}`;

  await db.batch([
    db.prepare(`
      INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, spawn_cost_blood)
      VALUES (?, ?, ?, ?, ?, ?, 'alive', ?)
    `).bind(childId, parent_id, childGeneration, owner_wallet, agent_wallet, JSON.stringify(childDna), blood_amount),

    db.prepare(`
      INSERT INTO spawns (parent_id, child_id, blood_burned, mutation_log)
      VALUES (?, ?, ?, ?)
    `).bind(parent_id, childId, blood_amount, JSON.stringify(mutations))
  ]);

  return Response.json({
    success: true,
    child: {
      id: childId,
      parent_id,
      generation: childGeneration,
      dna: childDna,
      mutations,
      blood_burned: blood_amount
    }
  });
}
