import { mutate } from "../_lib/mutator.js";
import { generateKeypair } from "../_lib/solana.js";
export async function onRequest(context) {
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = context.env.DB;
  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { parent_id, blood_fee, sol_deposit, owner_wallet } = body;
  if (!parent_id || !blood_fee || !sol_deposit || !owner_wallet) return Response.json({ error: "Missing fields" }, { status: 400 });
  const parent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(parent_id).first();
  if (!parent) return Response.json({ error: "Parent not found" }, { status: 404 });
  if (parent.status !== "alive") return Response.json({ error: "Parent not alive" }, { status: 400 });
  if (parent.total_pnl < parseFloat(context.env.MIN_SPAWN_PNL || "0.4")) return Response.json({ error: "Insufficient PnL" }, { status: 400 });
  const lastSpawn = await db.prepare("SELECT created_at FROM spawns WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1").bind(parent_id).first();
  if (lastSpawn) {
    const hours = (Date.now() - new Date(lastSpawn.created_at + "Z").getTime()) / 3600000;
    if (hours < 6) return Response.json({ error: `Cooldown: ${(6 - hours).toFixed(1)}h remaining` }, { status: 400 });
  }
  const childGen = parent.generation + 1;
  const SPAWN_COSTS = { 1: 1000000, 2: 750000, 3: 500000, 4: 250000, 5: 100000 };
  const minBlood = SPAWN_COSTS[childGen] || 100000;
  if (blood_fee < minBlood) return Response.json({ error: `Need ${minBlood.toLocaleString()} $SPAWN (gen ${childGen})` }, { status: 400 });
  const parentDna = JSON.parse(parent.dna);
  const { childDna, mutations } = mutate(parentDna);
  const childId = `agent_${crypto.randomUUID().slice(0, 8)}`;

  // Generate dedicated trading wallet for child agent
  const keypair = await generateKeypair();
  const kv = context.env.AGENT_KEYS;
  if (kv) {
    await kv.put(`agent:${childId}:secret`, keypair.secretKey);
  }

  await db.batch([
    db.prepare("INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, spawn_cost_blood) VALUES (?, ?, ?, ?, ?, ?, 'alive', ?)").bind(childId, parent_id, childGen, owner_wallet, keypair.publicKey, JSON.stringify(childDna), blood_fee),
    db.prepare("INSERT INTO spawns (parent_id, child_id, blood_burned, mutation_log) VALUES (?, ?, ?, ?)").bind(parent_id, childId, blood_fee, JSON.stringify(mutations)),
    db.prepare("INSERT INTO events (type, agent_id, data) VALUES ('spawn', ?, ?)").bind(childId, JSON.stringify({ parent: parent_id, generation: childGen, mutations, blood_fee, sol_deposit, agent_wallet: keypair.publicKey }))
  ]);
  return Response.json({ success: true, child: { id: childId, parent_id, generation: childGen, dna: childDna, mutations, agent_wallet: keypair.publicKey } });
}
