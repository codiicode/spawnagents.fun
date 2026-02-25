export async function onRequestPOST(context) {
  const db = context.env.DB;

  const secret = context.request.headers.get("X-Cron-Secret");
  if (secret !== context.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const royaltyPct = parseFloat(context.env.ROYALTY_PCT || "0.1");
  const protocolPct = parseFloat(context.env.PROTOCOL_FEE_PCT || "0.02");
  const maxGenerations = parseInt(context.env.MAX_GENERATIONS || "5");

  // Find agents with profit from trades not yet royalty-processed
  // We track this by comparing total_royalties_paid vs what should have been paid
  const profitableAgents = await db.prepare(`
    SELECT a.id, a.parent_id, a.total_pnl, a.total_royalties_paid
    FROM agents a
    WHERE a.parent_id IS NOT NULL
      AND a.total_pnl > 0
      AND a.total_pnl * ? > a.total_royalties_paid
  `).bind(royaltyPct).all();

  const royaltyPayments = [];
  let totalDistributed = 0;

  for (const agent of profitableAgents.results) {
    const owedTotal = agent.total_pnl * royaltyPct;
    const newRoyalty = owedTotal - agent.total_royalties_paid;

    if (newRoyalty <= 0.0001) continue; // Skip dust

    // Walk up the tree, paying royalties at each level
    let currentAmount = newRoyalty;
    let currentParentId = agent.parent_id;
    let depth = 0;

    while (currentParentId && depth < maxGenerations && currentAmount > 0.0001) {
      const parent = await db.prepare("SELECT id, parent_id FROM agents WHERE id = ?")
        .bind(currentParentId).first();

      if (!parent) break;

      // TODO: Execute actual SOL transfer on-chain
      royaltyPayments.push({
        from_agent_id: agent.id,
        to_agent_id: parent.id,
        amount_sol: currentAmount
      });

      totalDistributed += currentAmount;

      // Next level gets royaltyPct of what this level received
      currentAmount = currentAmount * royaltyPct;
      currentParentId = parent.parent_id;
      depth++;
    }

    // Update agent's total_royalties_paid
    await db.prepare(
      "UPDATE agents SET total_royalties_paid = ? WHERE id = ?"
    ).bind(owedTotal, agent.id).run();
  }

  // Batch insert royalty records
  if (royaltyPayments.length > 0) {
    const stmts = royaltyPayments.map(r =>
      db.prepare("INSERT INTO royalties (from_agent_id, to_agent_id, amount_sol) VALUES (?, ?, ?)")
        .bind(r.from_agent_id, r.to_agent_id, r.amount_sol)
    );
    await db.batch(stmts);
  }

  return Response.json({
    payments: royaltyPayments.length,
    total_distributed: totalDistributed,
    details: royaltyPayments
  });
}
