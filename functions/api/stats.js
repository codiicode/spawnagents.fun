export async function onRequestGET(context) {
  const db = context.env.DB;

  const [agentStats, tradeStats, royaltyStats, spawnStats] = await db.batch([
    db.prepare(`
      SELECT
        COUNT(*) as total_agents,
        COUNT(CASE WHEN status = 'alive' THEN 1 END) as alive_agents,
        COUNT(CASE WHEN status = 'dead' THEN 1 END) as dead_agents,
        COUNT(CASE WHEN generation = 0 THEN 1 END) as genesis_count,
        MAX(generation) as max_generation,
        SUM(total_pnl) as ecosystem_pnl
      FROM agents
    `),
    db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN action = 'buy' THEN amount_sol ELSE 0 END) as total_volume_bought,
        SUM(CASE WHEN action = 'sell' THEN amount_sol ELSE 0 END) as total_volume_sold
      FROM trades
    `),
    db.prepare(`
      SELECT
        COUNT(*) as total_royalty_payments,
        SUM(amount_sol) as total_royalties_distributed
      FROM royalties
    `),
    db.prepare(`
      SELECT
        COUNT(*) as total_spawns,
        SUM(blood_burned) as total_blood_burned
      FROM spawns
    `)
  ]);

  return Response.json({
    agents: agentStats.results[0],
    trades: tradeStats.results[0],
    royalties: royaltyStats.results[0],
    spawns: spawnStats.results[0]
  });
}
