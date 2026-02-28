import { processAgent } from "../_lib/engine.js";
import { discoverTokens } from "../_lib/market-data.js";
import { getBalance, getTokenBalances, sendSol, setJupiterApiKey, getJupiterQuote, SOL_MINT } from "../_lib/solana.js";

export async function onRequest(context) {
  if (context.env.JUPITER_API_KEY) setJupiterApiKey(context.env.JUPITER_API_KEY);
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const kv = context.env.AGENT_KEYS;

  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });
  if (!kv) return Response.json({ error: "AGENT_KEYS KV not configured" }, { status: 500 });

  // Discover candidate tokens ONCE, share across all agents
  const candidates = await discoverTokens();
  console.log(`Discovered ${candidates.length} candidate tokens`);

  const agents = await db.prepare("SELECT * FROM agents WHERE status = 'alive'").all();
  const results = [];

  for (const agent of agents.results) {
    const dna = JSON.parse(agent.dna);

    // Check interval
    const lastTrade = await db.prepare(
      "SELECT created_at FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agent.id).first();

    if (lastTrade) {
      const mins = (Date.now() - new Date(lastTrade.created_at + "Z").getTime()) / 60000;
      if (mins < (dna.check_interval_min || 5)) {
        results.push({ agent: agent.id, skipped: true });
        continue;
      }
    }

    // Get agent's secret key from KV
    const agentSecret = await kv.get(`agent:${agent.id}:secret`);
    if (!agentSecret) {
      results.push({ agent: agent.id, error: "no keypair" });
      continue;
    }

    try {
      const decision = await processAgent(agent, db, rpcUrl, agentSecret, agent.agent_wallet, candidates);

      if (decision.action === "buy" && decision.tx_signature) {
        await db.batch([
          db.prepare(
            "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, price_at_trade, tx_signature) VALUES (?, ?, 'buy', ?, ?, 0, ?)"
          ).bind(agent.id, decision.token, decision.amount_sol, decision.token_amount || 0, decision.tx_signature),
          db.prepare(
            "UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?"
          ).bind(agent.id),
          db.prepare(
            "INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)"
          ).bind(agent.id, JSON.stringify({
            action: "buy", token: decision.symbol, amount: decision.amount_sol, tx: decision.tx_signature,
          })),
        ]);
      } else if (decision.action === "sell" && decision.tx_signature) {
        await db.batch([
          db.prepare(
            "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', ?, ?, 0, 0, ?)"
          ).bind(agent.id, decision.token, decision.amount_sol, decision.token_amount || 0, decision.tx_signature),
          db.prepare(
            "UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?"
          ).bind(agent.id),
          db.prepare(
            "INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)"
          ).bind(agent.id, JSON.stringify({
            action: "sell", token: decision.symbol, pnl_pct: decision.pnl_pct, tx: decision.tx_signature,
          })),
        ]);
      }

      results.push({ agent: agent.id, action: decision.action, reason: decision.reason, tx: decision.tx_signature || null, skipped: decision.skipped || undefined });
    } catch (e) {
      console.error(`Agent ${agent.id} error:`, e.message);
      results.push({ agent: agent.id, error: e.message });
    }
  }

  // === DEATH CHECK DISABLED — re-enable when economy is stable ===
  const deaths = 0;

  return Response.json({ processed: agents.results.length, results, deaths });
}
