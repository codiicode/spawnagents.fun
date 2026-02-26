const GENESIS_ARCHETYPES = [
  { id: "the-berserker", name: "The Berserker", dna: { aggression: 0.92, patience: 0.1, risk_tolerance: 0.9, focus: "memecoin", buy_threshold_holders: 100, buy_threshold_volume: 200, sell_profit_pct: 15, sell_loss_pct: 8, max_position_pct: 75, check_interval_min: 2 } },
  { id: "the-monk", name: "The Monk", dna: { aggression: 0.08, patience: 0.95, risk_tolerance: 0.15, focus: "memecoin", buy_threshold_holders: 2000, buy_threshold_volume: 10000, sell_profit_pct: 80, sell_loss_pct: 5, max_position_pct: 20, check_interval_min: 15 } },
  { id: "the-sniper", name: "The Sniper", dna: { aggression: 0.3, patience: 0.85, risk_tolerance: 0.4, focus: "memecoin", buy_threshold_holders: 1500, buy_threshold_volume: 5000, sell_profit_pct: 50, sell_loss_pct: 8, max_position_pct: 35, check_interval_min: 10 } },
  { id: "the-gambler", name: "The Gambler", dna: { aggression: 0.85, patience: 0.15, risk_tolerance: 0.95, focus: "memecoin", buy_threshold_holders: 80, buy_threshold_volume: 150, sell_profit_pct: 100, sell_loss_pct: 40, max_position_pct: 80, check_interval_min: 3 } },
  { id: "the-surgeon", name: "The Surgeon", dna: { aggression: 0.45, patience: 0.7, risk_tolerance: 0.3, focus: "memecoin", buy_threshold_holders: 1000, buy_threshold_volume: 3000, sell_profit_pct: 25, sell_loss_pct: 6, max_position_pct: 30, check_interval_min: 5 } },
  { id: "the-wolf", name: "The Wolf", dna: { aggression: 0.75, patience: 0.35, risk_tolerance: 0.7, focus: "memecoin", buy_threshold_holders: 300, buy_threshold_volume: 800, sell_profit_pct: 40, sell_loss_pct: 15, max_position_pct: 60, check_interval_min: 3 } },
  { id: "the-turtle", name: "The Turtle", dna: { aggression: 0.12, patience: 0.9, risk_tolerance: 0.2, focus: "memecoin", buy_threshold_holders: 3000, buy_threshold_volume: 15000, sell_profit_pct: 60, sell_loss_pct: 4, max_position_pct: 15, check_interval_min: 20 } },
  { id: "the-hawk", name: "The Hawk", dna: { aggression: 0.6, patience: 0.5, risk_tolerance: 0.5, focus: "memecoin", buy_threshold_holders: 500, buy_threshold_volume: 2000, sell_profit_pct: 35, sell_loss_pct: 10, max_position_pct: 45, check_interval_min: 5 } },
  { id: "the-phantom", name: "The Phantom", dna: { aggression: 0.4, patience: 0.75, risk_tolerance: 0.35, focus: "memecoin", buy_threshold_holders: 1200, buy_threshold_volume: 4000, sell_profit_pct: 45, sell_loss_pct: 7, max_position_pct: 25, check_interval_min: 8 } },
  { id: "the-beast", name: "The Beast", dna: { aggression: 0.88, patience: 0.2, risk_tolerance: 0.85, focus: "memecoin", buy_threshold_holders: 150, buy_threshold_volume: 300, sell_profit_pct: 20, sell_loss_pct: 25, max_position_pct: 70, check_interval_min: 2 } },
  { id: "the-oracle", name: "The Oracle", dna: { aggression: 0.25, patience: 0.88, risk_tolerance: 0.25, focus: "memecoin", buy_threshold_holders: 2500, buy_threshold_volume: 8000, sell_profit_pct: 70, sell_loss_pct: 5, max_position_pct: 20, check_interval_min: 12 } },
  { id: "the-jackal", name: "The Jackal", dna: { aggression: 0.7, patience: 0.3, risk_tolerance: 0.65, focus: "memecoin", buy_threshold_holders: 250, buy_threshold_volume: 600, sell_profit_pct: 30, sell_loss_pct: 18, max_position_pct: 55, check_interval_min: 4 } },
  { id: "the-specter", name: "The Specter", dna: { aggression: 0.35, patience: 0.8, risk_tolerance: 0.3, focus: "memecoin", buy_threshold_holders: 1800, buy_threshold_volume: 6000, sell_profit_pct: 55, sell_loss_pct: 6, max_position_pct: 22, check_interval_min: 10 } },
  { id: "the-viper", name: "The Viper", dna: { aggression: 0.8, patience: 0.25, risk_tolerance: 0.75, focus: "memecoin", buy_threshold_holders: 200, buy_threshold_volume: 500, sell_profit_pct: 22, sell_loss_pct: 20, max_position_pct: 65, check_interval_min: 3 } },
  { id: "the-colossus", name: "The Colossus", dna: { aggression: 0.5, patience: 0.6, risk_tolerance: 0.5, focus: "memecoin", buy_threshold_holders: 800, buy_threshold_volume: 2500, sell_profit_pct: 40, sell_loss_pct: 10, max_position_pct: 40, check_interval_min: 6 } }
];
export async function onRequest(context) {
  const db = context.env.DB;
  if (context.request.method === "POST") {
    let body;
    try { body = await context.request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const { archetype_id, owner_wallet, agent_wallet } = body;
    if (!archetype_id || !owner_wallet || !agent_wallet) return Response.json({ error: "Missing fields" }, { status: 400 });
    const arch = GENESIS_ARCHETYPES.find(a => a.id === archetype_id);
    if (!arch) return Response.json({ error: "Unknown archetype" }, { status: 404 });
    const existing = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(archetype_id).first();
    if (existing) return Response.json({ error: "Already claimed" }, { status: 409 });
    await db.prepare("INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status) VALUES (?, NULL, 0, ?, ?, ?, 'alive')").bind(archetype_id, owner_wallet, agent_wallet, JSON.stringify(arch.dna)).run();
    return Response.json({ success: true, agent: { id: archetype_id, name: arch.name, dna: arch.dna } });
  }
  const claimed = await db.prepare("SELECT id, owner_wallet, agent_wallet, status FROM agents WHERE generation = 0").all();
  const claimedMap = {};
  for (const a of claimed.results) claimedMap[a.id] = a;
  const archetypes = GENESIS_ARCHETYPES.map(a => {
    const c = claimedMap[a.id];
    // Dead agents are available for purchase again
    if (c && c.status === 'dead') return { ...a, available: true };
    return c
      ? { ...a, available: false, owner_wallet: c.owner_wallet, agent_wallet: c.agent_wallet }
      : { ...a, available: true };
  });
  return Response.json({ genesis: archetypes, available: archetypes.filter(a => a.available).length, total: archetypes.length });
}
