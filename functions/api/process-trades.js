import { processAgent } from "../_lib/engine.js";
import { discoverTokens } from "../_lib/market-data.js";
import { getBalance, sendSol } from "../_lib/solana.js";

export async function onRequest(context) {
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
        const pnl = decision.pnl_pct ? (decision.pnl_pct / 100) * decision.amount_sol : 0;
        await db.batch([
          db.prepare(
            "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', ?, ?, ?, 0, ?)"
          ).bind(agent.id, decision.token, decision.amount_sol, decision.token_amount || 0, pnl, decision.tx_signature),
          db.prepare(
            "UPDATE agents SET total_trades = total_trades + 1, total_pnl = total_pnl + ?, last_trade_at = datetime('now') WHERE id = ?"
          ).bind(pnl, agent.id),
          db.prepare(
            "INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)"
          ).bind(agent.id, JSON.stringify({
            action: "sell", token: decision.symbol, pnl_pct: decision.pnl_pct, tx: decision.tx_signature,
          })),
        ]);
      }

      results.push({ agent: agent.id, action: decision.action, reason: decision.reason, tx: decision.tx_signature || null });
    } catch (e) {
      console.error(`Agent ${agent.id} error:`, e.message);
      results.push({ agent: agent.id, error: e.message });
    }
  }

  // === DEATH CHECK: kill agents that lost 80%+ of capital ===
  const deathPct = parseFloat(context.env.DEATH_LOSS_PCT || "0.8");
  let deaths = 0;

  for (const agent of agents.results) {
    if (agent.initial_capital <= 0) continue; // no capital info, skip

    try {
      const balance = await getBalance(agent.agent_wallet, rpcUrl);
      const threshold = agent.initial_capital * (1 - deathPct);

      if (balance < threshold) {
        // Agent is dead — send remaining SOL to protocol wallet
        const protocolWallet = context.env.PROTOCOL_WALLET;
        const agentSecret = await kv.get(`agent:${agent.id}:secret`);
        let deathTx = null;

        if (agentSecret && protocolWallet && balance > 0.002) {
          try {
            const sendAmount = balance - 0.001; // keep dust for rent
            deathTx = await sendSol(agentSecret, protocolWallet, sendAmount, rpcUrl);
          } catch (e) {
            console.error(`Failed to reclaim ${agent.id} funds:`, e.message);
          }
        }

        await db.batch([
          db.prepare("UPDATE agents SET status = 'dead' WHERE id = ?").bind(agent.id),
          db.prepare(
            "INSERT INTO events (type, agent_id, data) VALUES ('death', ?, ?)"
          ).bind(agent.id, JSON.stringify({
            balance,
            initial_capital: agent.initial_capital,
            loss_pct: ((1 - balance / agent.initial_capital) * 100).toFixed(1),
            reclaim_tx: deathTx,
          })),
        ]);

        console.log(`Agent ${agent.id} died: ${balance.toFixed(4)} SOL remaining (started with ${agent.initial_capital})`);
        deaths++;
      }
    } catch (e) {
      console.error(`Death check failed for ${agent.id}:`, e.message);
    }
  }

  return Response.json({ processed: agents.results.length, results, deaths });
}
