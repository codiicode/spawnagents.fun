export async function onRequest(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");

  if (!id) return Response.json({ error: "Missing id parameter" }, { status: 400 });

  try {
    const agent = await db.prepare(
      "SELECT id, name, generation, parent_id, owner_wallet, agent_wallet, total_pnl, total_trades, fitness_score, initial_capital, total_royalties_paid, total_royalties_received, status, meta, born_at, last_trade_at, dna, pnl_offset, pnl_offset_at FROM agents WHERE id = ?"
    ).bind(id).first();

    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const parsed = {
      ...agent,
      dna: JSON.parse(agent.dna || "{}"),
      meta: agent.meta ? JSON.parse(agent.meta) : null,
    };

    // Recent trades (last 50)
    const trades = await db.prepare(
      "SELECT id, token_address, action, amount_sol, token_amount, pnl, tx_signature, created_at FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(id).all();

    // Children
    const children = await db.prepare(
      "SELECT id, name, status, total_pnl FROM agents WHERE parent_id = ?"
    ).bind(id).all();

    // Parent info
    let parent = null;
    if (agent.parent_id) {
      parent = await db.prepare(
        "SELECT id, name FROM agents WHERE id = ?"
      ).bind(agent.parent_id).first();
    }

    // Win rate
    const allTrades = await db.prepare(
      "SELECT token_address, action, amount_sol FROM trades WHERE agent_id = ? ORDER BY created_at ASC"
    ).bind(id).all();

    const openBuys = {};
    let wins = 0;
    let totalSells = 0;
    for (const t of allTrades.results) {
      if (t.action === 'buy') {
        openBuys[t.token_address] = (openBuys[t.token_address] || 0) + t.amount_sol;
      } else if (t.action === 'sell') {
        totalSells++;
        const bought = openBuys[t.token_address] || 0;
        if (bought > 0 && t.amount_sol > bought) wins++;
        openBuys[t.token_address] = 0;
      }
    }
    const winRate = totalSells > 0 ? (wins / totalSells) : 0;

    // Build symbol map from events (events store token symbols, trades don't)
    const events = await db.prepare(
      "SELECT data FROM events WHERE agent_id = ? AND type = 'trade' ORDER BY rowid DESC LIMIT 200"
    ).bind(id).all();

    const symbolMap = {};
    for (const e of events.results) {
      try {
        const d = JSON.parse(e.data);
        if (d.tx && d.token) symbolMap[d.tx] = d.token;
      } catch {}
    }

    // Attach symbols to trades
    const tradesWithSymbols = trades.results.map(t => ({
      ...t,
      symbol: (t.tx_signature && symbolMap[t.tx_signature]) || null,
    }));

    // PnL history from KV (for chart)
    let pnlHistory = [];
    const kv = context.env.AGENT_KEYS;
    if (kv) {
      try {
        const raw = await kv.get(`pnl_history:${id}`);
        if (raw) pnlHistory = JSON.parse(raw);
      } catch {}
    }

    return Response.json({
      agent: parsed,
      trades: tradesWithSymbols,
      children: children.results,
      parent,
      winRate: parseFloat((winRate * 100).toFixed(1)),
      currentPnl: agent.total_pnl || 0,
      pnlHistory,
    });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
