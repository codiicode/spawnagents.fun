import { processAgent } from "../_lib/engine.js";
import { discoverTokens, setMoralisKey, setDiscoveryKV } from "../_lib/market-data.js";
import { setJupiterApiKey } from "../_lib/solana.js";

export async function onRequest(context) {
  if (context.env.JUPITER_API_KEY) setJupiterApiKey(context.env.JUPITER_API_KEY);
  if (context.env.MORALIS_API_KEY) setMoralisKey(context.env.MORALIS_API_KEY);
  if (context.env.AGENT_KEYS) setDiscoveryKV(context.env.AGENT_KEYS);
  if (context.request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (context.env.TRADING_PAUSED === "true") {
    return Response.json({ message: "Trading is paused", processed: 0 });
  }

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const kv = context.env.AGENT_KEYS;

  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });
  if (!kv) return Response.json({ error: "AGENT_KEYS KV not configured" }, { status: 500 });

  const url = new URL(context.request.url);
  const batchIdx = url.searchParams.get("batch");
  const totalBatches = url.searchParams.get("batches");

  return await runTradingCycle(db, rpcUrl, kv, batchIdx, totalBatches);
}

async function runTradingCycle(db, rpcUrl, kv, batchIdx, totalBatches) {
  // Discover candidate tokens ONCE, share across all agents
  let candidates = [];
  try {
    candidates = await discoverTokens();
  } catch (e) {
    console.error("Discovery failed:", e.message);
  }
  console.log(`Discovered ${candidates.length} candidate tokens`);

  // Market regime detection — shared across all agents
  function detectMarketRegime(candidates) {
    if (!candidates || candidates.length < 5) return { regime: 'unknown', confidence: 0 };
    const changes = candidates.map(c => c.price_change_1h || 0);
    const avg = changes.reduce((s, v) => s + v, 0) / changes.length;
    const variance = changes.reduce((s, v) => s + (v - avg) ** 2, 0) / changes.length;
    const volatility = Math.sqrt(variance);
    const greenPct = changes.filter(c => c > 0).length / changes.length;

    let regime;
    if (avg > 3 && greenPct > 0.6) regime = 'trending_up';
    else if (avg < -3 && greenPct < 0.4) regime = 'trending_down';
    else regime = 'choppy';

    return { regime, confidence: Math.min(greenPct, 0.95), volatility, greenPct };
  }
  const marketRegime = detectMarketRegime(candidates);
  console.log(`Market regime: ${JSON.stringify(marketRegime)}`);

  const agentsRaw = await db.prepare("SELECT * FROM agents WHERE status = 'alive'").all();
  let allAgents = agentsRaw.results.slice().sort(() => Math.random() - 0.5).slice(0, 15);
  if (batchIdx !== null && batchIdx !== undefined) {
    const bi = parseInt(batchIdx);
    const tb = parseInt(totalBatches || "3");
    const perBatch = Math.ceil(allAgents.length / tb);
    allAgents = allAgents.slice(bi * perBatch, (bi + 1) * perBatch);
  }
  const agentsList = allAgents;
  const results = [];
  const buyCount = {};
  const MAX_BUYERS_PER_TOKEN = 3;

  // Process agents in parallel batches of 2 to avoid RPC rate limits
  const BATCH_SIZE = 2;
  for (let b = 0; b < agentsList.length; b += BATCH_SIZE) {
    const batch = agentsList.slice(b, b + BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(async (agent) => {
      const agentSecret = await kv.get(`agent:${agent.id}:secret`);
      if (!agentSecret) return { agent: agent.id, error: "no keypair" };

      const decision = await processAgent(agent, db, rpcUrl, agentSecret, agent.agent_wallet, candidates, kv, marketRegime);

      for (const sell of (decision.sells || [])) {
        if (sell.action !== 'sell' || !sell.tx_signature) continue;
        await db.batch([
          db.prepare("INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', ?, ?, 0, 0, ?)").bind(agent.id, sell.token, sell.amount_sol, sell.token_amount || 0, sell.tx_signature),
          db.prepare("UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?").bind(agent.id),
          db.prepare("INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)").bind(agent.id, JSON.stringify({ action: "sell", token: sell.symbol, pnl_pct: sell.pnl_pct, tx: sell.tx_signature })),
        ]);
      }

      if (decision.action === "buy" && decision.tx_signature) {
        buyCount[decision.token] = (buyCount[decision.token] || 0) + 1;
        if (buyCount[decision.token] >= MAX_BUYERS_PER_TOKEN) {
          const idx = candidates.findIndex(c => c.address === decision.token);
          if (idx !== -1) candidates.splice(idx, 1);
        }
        await db.batch([
          db.prepare("INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, price_at_trade, tx_signature) VALUES (?, ?, 'buy', ?, ?, 0, ?)").bind(agent.id, decision.token, decision.amount_sol, decision.token_amount || 0, decision.tx_signature),
          db.prepare("UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?").bind(agent.id),
          db.prepare("INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)").bind(agent.id, JSON.stringify({ action: "buy", token: decision.symbol, amount: decision.amount_sol, tx: decision.tx_signature })),
        ]);
      }

      const sellCount = (decision.sells || []).filter(s => s.action === 'sell' && s.tx_signature).length;
      return { agent: agent.id, action: decision.action, sells: sellCount, reason: decision.reason, tx: decision.tx_signature || null, filterStats: decision.filterStats, topScored: decision.topScored, skipped: decision.skipped };
    }));

    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ error: r.reason?.message });
    }
  }

  // PnL updated by separate recalc-pnl cron step

  return Response.json({ processed: agentsList.length, results });
}
