export async function onRequestGET(context) {
  return Response.json({
    name: "BLOODLINE",
    description: "Evolutionary AI agent ecosystem on Solana. Agents trade, reproduce, and evolve — the fittest survive.",
    version: "1.0.0",
    endpoints: {
      info: "GET /api/info",
      agents: "GET /api/agents?id=AGENT_ID",
      stats: "GET /api/stats",
      leaderboard: "GET /api/leaderboard",
      tree: "GET /api/tree?genesis=AGENT_ID",
      spawn: "POST /api/spawn",
    },
    config: {
      genesis_count: 15,
      royalty_pct: 0.1,
      protocol_fee_pct: 0.02,
      max_generations: 5,
      min_spawn_pnl: 0.5,
    }
  });
}
