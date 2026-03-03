import { processAgent } from "../_lib/engine.js";
import { discoverTokens } from "../_lib/market-data.js";
import { setJupiterApiKey } from "../_lib/solana.js";

const MUTEX_KEY = 'cron:process-trades:lock';
const MUTEX_TTL = 180; // 3 min max lock

export async function onRequest(context) {
  if (context.env.JUPITER_API_KEY) setJupiterApiKey(context.env.JUPITER_API_KEY);
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // === TRADING PAUSE — remove this block to resume ===
  if (context.env.TRADING_PAUSED === "true") {
    return Response.json({ message: "Trading is paused", processed: 0 });
  }

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const kv = context.env.AGENT_KEYS;

  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });
  if (!kv) return Response.json({ error: "AGENT_KEYS KV not configured" }, { status: 500 });

  // === MUTEX — prevent concurrent cron cycles ===
  const lock = await kv.get(MUTEX_KEY);
  if (lock) {
    return Response.json({ skipped: true, reason: "Previous cycle still running" });
  }
  await kv.put(MUTEX_KEY, Date.now().toString(), { expirationTtl: MUTEX_TTL });

  try {
    return await runTradingCycle(db, rpcUrl, kv);
  } finally {
    await kv.delete(MUTEX_KEY);
  }
}

async function runTradingCycle(db, rpcUrl, kv) {
  // Discover candidate tokens ONCE, share across all agents
  const candidates = await discoverTokens();
  console.log(`Discovered ${candidates.length} candidate tokens`);

  const agentsRaw = await db.prepare("SELECT * FROM agents WHERE status = 'alive'").all();
  // Shuffle so all agents get fair chance, cap at 15 per cycle
  const agentsList = agentsRaw.results.slice().sort(() => Math.random() - 0.5).slice(0, 15);
  const results = [];
  const buyCount = {}; // track how many agents bought each token this cycle
  const MAX_BUYERS_PER_TOKEN = 3;

  for (const agent of agentsList) {
    // Get agent's secret key from KV
    const agentSecret = await kv.get(`agent:${agent.id}:secret`);
    if (!agentSecret) {
      results.push({ agent: agent.id, error: "no keypair" });
      continue;
    }

    try {
      const decision = await processAgent(agent, db, rpcUrl, agentSecret, agent.agent_wallet, candidates, kv);

      // Process ALL sells from this cycle (engine now returns multiple)
      for (const sell of (decision.sells || [])) {
        if (sell.action !== 'sell' || !sell.tx_signature) continue;
        await db.batch([
          db.prepare(
            "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', ?, ?, 0, 0, ?)"
          ).bind(agent.id, sell.token, sell.amount_sol, sell.token_amount || 0, sell.tx_signature),
          db.prepare(
            "UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?"
          ).bind(agent.id),
          db.prepare(
            "INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)"
          ).bind(agent.id, JSON.stringify({
            action: "sell", token: sell.symbol, pnl_pct: sell.pnl_pct, tx: sell.tx_signature,
          })),
        ]);
      }

      // Process buy (still max 1 per cycle)
      if (decision.action === "buy" && decision.tx_signature) {
        buyCount[decision.token] = (buyCount[decision.token] || 0) + 1;
        if (buyCount[decision.token] >= MAX_BUYERS_PER_TOKEN) {
          const idx = candidates.findIndex(c => c.address === decision.token);
          if (idx !== -1) candidates.splice(idx, 1);
        }

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
      }

      const sellCount = (decision.sells || []).filter(s => s.action === 'sell' && s.tx_signature).length;
      results.push({ agent: agent.id, action: decision.action, sells: sellCount, reason: decision.reason, tx: decision.tx_signature || null, skipped: decision.skipped || undefined });
    } catch (e) {
      console.error(`Agent ${agent.id} error:`, e.message);
      results.push({ agent: agent.id, error: e.message });
    }
  }

  // PnL updated by separate recalc-pnl cron step

  return Response.json({ processed: agentsList.length, results });
}
