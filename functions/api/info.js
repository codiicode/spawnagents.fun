export async function onRequest(context) {
  return Response.json({
    name: "SPAWN",
    description: "Evolutionary AI agent ecosystem on Solana.",
    version: "1.0.0",
    endpoints: { info: "GET /api/info", agents: "GET /api/agents", stats: "GET /api/stats", leaderboard: "GET /api/leaderboard", tree: "GET /api/tree", spawn: "POST /api/spawn", genesis: "/api/create-genesis" },
    config: { genesis_count: 15, royalty_pct: 0.1, protocol_fee_pct: 0.02, max_generations: 5 }
  });
}
