import { genesisDefaultDna } from "../../agent-engine/mutator.js";

// 15 named genesis archetypes
const ARCHETYPES = {
  "the-berserker":  { aggression: 0.9, patience: 0.1, risk_tolerance: 0.9, buy_threshold_holders: 200, buy_threshold_volume: 500,  sell_profit_pct: 15, sell_loss_pct: 25, max_position_pct: 70 },
  "the-monk":       { aggression: 0.15, patience: 0.9, risk_tolerance: 0.3, buy_threshold_holders: 1000, buy_threshold_volume: 3000, sell_profit_pct: 60, sell_loss_pct: 8,  max_position_pct: 20 },
  "the-sniper":     { aggression: 0.7, patience: 0.5, risk_tolerance: 0.6, buy_threshold_holders: 800, buy_threshold_volume: 2000, sell_profit_pct: 25, sell_loss_pct: 10, max_position_pct: 40 },
  "the-gambler":    { aggression: 0.85, patience: 0.2, risk_tolerance: 0.95, buy_threshold_holders: 100, buy_threshold_volume: 300,  sell_profit_pct: 50, sell_loss_pct: 40, max_position_pct: 80 },
  "the-surgeon":    { aggression: 0.4, patience: 0.7, risk_tolerance: 0.4, buy_threshold_holders: 600, buy_threshold_volume: 1500, sell_profit_pct: 20, sell_loss_pct: 8,  max_position_pct: 30 },
  "the-wolf":       { aggression: 0.75, patience: 0.3, risk_tolerance: 0.7, buy_threshold_holders: 400, buy_threshold_volume: 800,  sell_profit_pct: 35, sell_loss_pct: 18, max_position_pct: 55 },
  "the-turtle":     { aggression: 0.1, patience: 0.95, risk_tolerance: 0.2, buy_threshold_holders: 1500, buy_threshold_volume: 5000, sell_profit_pct: 80, sell_loss_pct: 5,  max_position_pct: 15 },
  "the-hawk":       { aggression: 0.6, patience: 0.4, risk_tolerance: 0.5, buy_threshold_holders: 500, buy_threshold_volume: 1000, sell_profit_pct: 30, sell_loss_pct: 15, max_position_pct: 50 },
  "the-phantom":    { aggression: 0.5, patience: 0.6, risk_tolerance: 0.55, buy_threshold_holders: 700, buy_threshold_volume: 1800, sell_profit_pct: 40, sell_loss_pct: 12, max_position_pct: 35 },
  "the-beast":      { aggression: 0.95, patience: 0.05, risk_tolerance: 0.85, buy_threshold_holders: 150, buy_threshold_volume: 400,  sell_profit_pct: 20, sell_loss_pct: 30, max_position_pct: 75 },
  "the-oracle":     { aggression: 0.3, patience: 0.8, risk_tolerance: 0.35, buy_threshold_holders: 900, buy_threshold_volume: 2500, sell_profit_pct: 45, sell_loss_pct: 7,  max_position_pct: 25 },
  "the-jackal":     { aggression: 0.8, patience: 0.25, risk_tolerance: 0.75, buy_threshold_holders: 300, buy_threshold_volume: 600,  sell_profit_pct: 22, sell_loss_pct: 20, max_position_pct: 60 },
  "the-specter":    { aggression: 0.45, patience: 0.55, risk_tolerance: 0.45, buy_threshold_holders: 650, buy_threshold_volume: 1200, sell_profit_pct: 35, sell_loss_pct: 12, max_position_pct: 40 },
  "the-viper":      { aggression: 0.7, patience: 0.35, risk_tolerance: 0.65, buy_threshold_holders: 350, buy_threshold_volume: 700,  sell_profit_pct: 28, sell_loss_pct: 16, max_position_pct: 50 },
  "the-colossus":   { aggression: 0.55, patience: 0.65, risk_tolerance: 0.5, buy_threshold_holders: 550, buy_threshold_volume: 1400, sell_profit_pct: 38, sell_loss_pct: 10, max_position_pct: 45 },
};

export async function onRequestGET(context) {
  // List available genesis archetypes and their status
  const db = context.env.DB;
  const existing = await db.prepare(
    "SELECT agent_id FROM agents WHERE generation = 0"
  ).all();

  const taken = new Set((existing.results || []).map(a => {
    // Extract archetype name from agent_id like "genesis_the-berserker"
    return a.agent_id.replace("genesis_", "");
  }));

  const available = Object.entries(ARCHETYPES).map(([name, dna]) => ({
    name,
    agent_id: `genesis_${name}`,
    available: !taken.has(name),
    dna: { ...dna, focus: "memecoin", check_interval_min: 5 },
  }));

  return Response.json({
    total: 15,
    sold: taken.size,
    remaining: 15 - taken.size,
    archetypes: available,
  });
}

export async function onRequestPOST(context) {
  const db = context.env.DB;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { archetype, owner_wallet, vault_pubkey, tx_signature } = body;

  if (!archetype || !owner_wallet || !vault_pubkey) {
    return Response.json({ error: "Missing: archetype, owner_wallet, vault_pubkey" }, { status: 400 });
  }

  // Validate archetype exists
  if (!ARCHETYPES[archetype]) {
    return Response.json({ error: `Unknown archetype: ${archetype}` }, { status: 400 });
  }

  const agentId = `genesis_${archetype}`;

  // Check not already taken
  const existing = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId).first();
  if (existing) {
    return Response.json({ error: `${archetype} is already claimed` }, { status: 409 });
  }

  // TODO: Verify on-chain that create_agent was called and deposit was made (tx_signature)

  const dna = {
    ...ARCHETYPES[archetype],
    focus: "memecoin",
    check_interval_min: 5,
  };

  await db.prepare(`
    INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status)
    VALUES (?, NULL, 0, ?, ?, ?, 'alive')
  `).bind(agentId, owner_wallet, vault_pubkey, JSON.stringify(dna)).run();

  return Response.json({
    success: true,
    agent: {
      id: agentId,
      archetype,
      owner_wallet,
      vault_pubkey,
      dna,
    }
  });
}
