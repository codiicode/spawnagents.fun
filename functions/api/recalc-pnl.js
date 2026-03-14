export async function onRequest(context) {
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (context.request.method !== 'POST') {
    return Response.json({ error: "POST with updates required. PnL is calculated by Hetzner script." }, { status: 400 });
  }

  const db = context.env.DB;

  let updates = null;
  let balanceCache = null;
  try {
    const body = await context.request.json();
    if (body.updates) updates = body.updates;
    if (body.balanceCache) balanceCache = body.balanceCache;
  } catch {}

  if (!updates || updates.length === 0) {
    return Response.json({ error: "No updates provided. PnL is calculated by Hetzner script." }, { status: 400 });
  }

  // Store balance cache in KV (from Hetzner script)
  const kv = context.env.AGENT_KEYS;
  if (balanceCache && kv) {
    for (const [agentId, data] of Object.entries(balanceCache)) {
      try {
        await kv.put(`balance:${agentId}`, JSON.stringify(data), { expirationTtl: 900 });
      } catch {}
    }
  }

  const results = [];
  for (const u of updates) {
    if (u.error) { results.push({ agent: u.id, error: u.error }); continue; }
    try {
      const agent = await db.prepare("SELECT pnl_mode, initial_capital, total_withdrawn, total_deposited FROM agents WHERE id = ?").bind(u.id).first();
      const agentTrades = await db.prepare(
        "SELECT token_address, action, amount_sol FROM trades WHERE agent_id = ? ORDER BY created_at ASC"
      ).bind(u.id).all();

      // Per-token totals for fitness
      const tokenBuys = {};
      const tokenSells = {};
      for (const t of agentTrades.results) {
        if (t.action === 'buy') {
          tokenBuys[t.token_address] = (tokenBuys[t.token_address] || 0) + t.amount_sol;
        } else if (t.action === 'sell') {
          tokenSells[t.token_address] = (tokenSells[t.token_address] || 0) + t.amount_sol;
        }
      }
      const positions = [];
      for (const mint of Object.keys(tokenBuys)) {
        const sold = tokenSells[mint] || 0;
        const bought = tokenBuys[mint] || 0;
        if (sold > 0 && bought > 0) positions.push((sold / bought) - 1);
      }

      let pnl;
      if (agent?.pnl_mode === 'trades') {
        // Trades mode: (sol + tokens + withdrawn) - (initial + deposited)
        const initCap = agent.initial_capital || 0;
        const withdrawn = agent.total_withdrawn || 0;
        const deposited = agent.total_deposited || 0;
        pnl = parseFloat(((u.sol + (u.tokens_sol || 0) + withdrawn) - (initCap + deposited)).toFixed(6));
      } else {
        // Balance mode: Hetzner's PnL unchanged
        pnl = parseFloat(u.pnl.toFixed(6));
      }

      let fitnessScore = 0;
      if (positions.length >= 3) {
        const winRate = positions.filter(r => r > 0).length / positions.length;
        const avgRet = positions.reduce((s, r) => s + r, 0) / positions.length;
        const stdDev = Math.sqrt(positions.reduce((s, r) => s + (r - avgRet) ** 2, 0) / positions.length) || 0.01;
        const sharpe = avgRet / stdDev;
        let cum = 0, peak = 0, maxDD = 0;
        for (const r of positions) { cum += r; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
        const ddPenalty = Math.max(0, 1 - maxDD);
        fitnessScore = sharpe * 0.4 + winRate * 0.3 + ddPenalty * 0.3;
      } else {
        fitnessScore = pnl > 0 ? pnl * 0.5 : pnl;
      }

      await db.prepare("UPDATE agents SET total_pnl = ?, fitness_score = ? WHERE id = ?").bind(pnl, parseFloat(fitnessScore.toFixed(6)), u.id).run();
      results.push({ agent: u.id, pnl: pnl.toFixed(4), sol: u.sol?.toFixed(4), tokens_sol: u.tokens_sol?.toFixed(4), fitness: fitnessScore.toFixed(4) });
    } catch (e) {
      results.push({ agent: u.id, error: e.message });
    }
  }
  // Store PnL history snapshots in KV (for profile chart)
  if (kv) {
    const now = Date.now();
    for (const r of results) {
      if (r.error || r.pnl === undefined) continue;
      try {
        const key = `pnl_history:${r.agent}`;
        const raw = await kv.get(key);
        const history = raw ? JSON.parse(raw) : [];
        history.push({ t: now, v: parseFloat(r.pnl) });
        // Keep last 144 points (24h at 10min intervals)
        while (history.length > 144) history.shift();
        await kv.put(key, JSON.stringify(history));
      } catch {}
    }
  }

  return Response.json({ source: 'hetzner', results });
}
