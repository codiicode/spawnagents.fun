import { sendSol, getBalance } from '../_lib/solana.js';

export async function onRequest(context) {
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = context.env.DB;
  const kv = context.env.AGENT_KEYS;
  const rpcUrl = context.env.RPC_URL;
  const royaltyPct = parseFloat(context.env.ROYALTY_PCT || "0.1");
  const maxGen = parseInt(context.env.MAX_GENERATIONS || "5");

  // Only process children (have parent_id) that are profitable
  const profitable = await db.prepare(
    "SELECT * FROM agents WHERE status = 'alive' AND total_pnl > 0 AND parent_id IS NOT NULL"
  ).all();

  const results = [];
  let totalPaid = 0;

  for (const agent of profitable.results) {
    // How much has already been paid out on-chain from this agent?
    const paid = await db.prepare(
      "SELECT COALESCE(SUM(amount_sol), 0) as paid FROM royalties WHERE from_agent_id = ? AND tx_signature IS NOT NULL"
    ).bind(agent.id).first();

    const owedTotal = agent.total_pnl * royaltyPct;
    const remaining = owedTotal - (paid?.paid || 0);
    if (remaining <= 0.005) continue;

    // Check child agent has enough SOL (keep 0.1 SOL reserve for trading)
    const childBalance = await getBalance(agent.agent_wallet, rpcUrl);
    const available = childBalance - 0.1;
    if (available <= 0.005) continue;

    const payableAmount = Math.min(remaining, available);

    // Get child's secret key
    const childSecret = await kv.get(`agent:${agent.id}:secret`);
    if (!childSecret) continue;

    // Walk parent chain — 50% to parent, 25% to grandparent, etc.
    let currentId = agent.parent_id;
    let depth = 0;
    let share = payableAmount;

    while (currentId && depth < maxGen && share > 0.002) {
      const parent = await db.prepare(
        "SELECT id, parent_id, owner_wallet, status FROM agents WHERE id = ?"
      ).bind(currentId).first();
      if (!parent || !parent.owner_wallet) break;

      const TREASURY = '4EtGKSvtteZNafiYTnxRggjMsmazCY5iZEikqTbGgmAc';
      const destination = parent.status === 'dead' ? TREASURY : parent.owner_wallet;

      const payout = parseFloat((share * 0.5).toFixed(6));
      if (payout < 0.002) break;

      try {
        const tx = await sendSol(childSecret, destination, payout, rpcUrl);
        await db.batch([
          db.prepare(
            "INSERT INTO royalties (from_agent_id, to_agent_id, amount_sol, tx_signature) VALUES (?, ?, ?, ?)"
          ).bind(agent.id, parent.id, payout, tx),
          db.prepare(
            "INSERT INTO events (type, agent_id, data) VALUES ('royalty', ?, ?)"
          ).bind(agent.id, JSON.stringify({
            from: agent.id, to: parent.id, to_wallet: destination,
            amount: payout, depth: depth + 1, tx,
          })),
        ]);
        results.push({ from: agent.id, to: parent.id, amount: payout, tx });
        totalPaid += payout;
      } catch (e) {
        results.push({ from: agent.id, to: parent.id, amount: payout, error: e.message });
      }

      share *= 0.5;
      currentId = parent.parent_id;
      depth++;
    }
  }

  return Response.json({
    processed: profitable.results.length,
    payments: results.filter(r => r.tx).length,
    total_distributed: parseFloat(totalPaid.toFixed(6)),
    results,
  });
}
