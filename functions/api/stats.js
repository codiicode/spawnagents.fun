export async function onRequest(context) {
  const db = context.env.DB;
  try {
    const [r, solPrice] = await Promise.all([
      db.batch([
        db.prepare("SELECT COUNT(*) as alive FROM agents WHERE status = 'alive'"),
        db.prepare("SELECT COUNT(*) as dead FROM agents WHERE status = 'dead'"),
        db.prepare("SELECT COUNT(*) as total FROM trades"),
        db.prepare("SELECT COUNT(*) as cnt FROM trades WHERE created_at > datetime('now', '-24 hours')"),
        db.prepare("SELECT COALESCE(SUM(amount_sol), 0) as vol FROM trades WHERE created_at > datetime('now', '-24 hours')"),
        db.prepare("SELECT id, COALESCE(name, REPLACE(REPLACE(id, 'the-', 'The '), '-', ' ')) as name, total_pnl FROM agents WHERE status = 'alive' ORDER BY total_pnl DESC LIMIT 1"),
      ]),
      fetchSolPrice(),
    ]);
    const volSol = parseFloat(r[4].results[0].vol.toFixed(4));
    const best = r[5].results[0];
    return Response.json({
      agents_alive: r[0].results[0].alive,
      agents_dead: r[1].results[0].dead,
      total_trades: r[2].results[0].total,
      trades_24h: r[3].results[0].cnt,
      volume_24h_sol: volSol,
      volume_24h_usd: Math.round(volSol * solPrice),
      sol_price: solPrice,
      best_agent: best ? { id: best.id, name: best.name, pnl: best.total_pnl } : null,
    }, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

async function fetchSolPrice() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    if (res.ok) {
      const d = await res.json();
      const pair = (d.pairs || []).find(p => p.chainId === 'solana' && p.quoteToken?.symbol === 'USDC');
      if (pair) return parseFloat(pair.priceUsd || 0);
    }
  } catch {}
  return 0;
}
