import { processAgent } from "../_lib/engine.js";
import { discoverTokens, getTokenData } from "../_lib/market-data.js";
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

      if (decision.action === "buy" && decision.tx_signature) {
        // Track buys per token — remove from candidates when max reached
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

  // === LIVE PnL UPDATE — runs for ALL alive agents every cycle ===
  let pnlUpdated = 0;
  for (const agent of agentsRaw.results) {
    if (!agent.agent_wallet || !agent.initial_capital) continue;
    try {
      const solBal = await getBalance(agent.agent_wallet, rpcUrl);
      const tokens = await getTokenBalances(agent.agent_wallet, rpcUrl);
      let tokenVal = 0;
      for (const t of tokens) {
        const data = await getTokenData(t.mint).catch(() => null);
        if (data && data.price_native) tokenVal += data.price_native * t.amount;
      }
      const livePnl = solBal + tokenVal - (agent.initial_capital || 0);
      await db.prepare("UPDATE agents SET total_pnl = ? WHERE id = ?")
        .bind(parseFloat(livePnl.toFixed(6)), agent.id).run();
      pnlUpdated++;
    } catch (e) {
      console.error(`PnL update failed for ${agent.id}:`, e.message);
    }
  }

  // === DEATH CHECK DISABLED — re-enable when economy is stable ===
  const deaths = 0;

  return Response.json({ processed: agentsList.length, results, deaths, pnlUpdated });
}
