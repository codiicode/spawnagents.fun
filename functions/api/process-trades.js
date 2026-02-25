import { processAgent } from "../../agent-engine/engine.js";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

export async function onRequestPOST(context) {
  const db = context.env.DB;

  // Auth — only cron worker
  const secret = context.request.headers.get("X-Cron-Secret");
  if (secret !== context.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = await db.prepare(
    "SELECT id, dna, agent_wallet, total_pnl FROM agents WHERE status = 'alive'"
  ).all();

  const results = [];

  for (const agent of agents.results) {
    const dna = JSON.parse(agent.dna);

    // Cooldown check
    const lastTrade = await db.prepare(
      "SELECT created_at FROM trades WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agent.id).first();

    if (lastTrade) {
      const minsSince = (Date.now() - new Date(lastTrade.created_at + "Z").getTime()) / (1000 * 60);
      if (minsSince < (dna.check_interval_min || 5)) {
        results.push({ agent: agent.id, action: "skipped", reason: "cooldown" });
        continue;
      }
    }

    // Run agent engine — get trading decision
    try {
      const decision = await processAgent(agent, db);

      if (decision.action === "hold" || decision.action === "idle") {
        results.push({ agent: agent.id, ...decision });
        continue;
      }

      // Build Jupiter swap
      let inputMint, outputMint, amountRaw;

      if (decision.action === "buy") {
        inputMint = SOL_MINT;
        outputMint = decision.token;
        amountRaw = Math.floor((decision.amount_sol || 0.01) * LAMPORTS_PER_SOL);
      } else if (decision.action === "sell") {
        inputMint = decision.token;
        outputMint = SOL_MINT;
        amountRaw = Math.floor((decision.amount || 0) * 1e6); // assume 6 decimals
      } else {
        results.push({ agent: agent.id, action: "unknown", decision });
        continue;
      }

      // Get Jupiter quote
      const quoteRes = await fetch(
        `${JUPITER_QUOTE_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=300`
      );

      if (!quoteRes.ok) {
        results.push({ agent: agent.id, action: "error", reason: "no quote" });
        continue;
      }

      const quote = await quoteRes.json();

      // Get swap transaction
      const swapRes = await fetch(JUPITER_SWAP_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: agent.agent_wallet,
          wrapAndUnwrapSol: true,
        })
      });

      if (!swapRes.ok) {
        results.push({ agent: agent.id, action: "error", reason: "swap build failed" });
        continue;
      }

      const swapData = await swapRes.json();

      // TODO: Submit transaction on-chain via execute_swap instruction
      // 1. Deserialize swapData.swapTransaction (base64 → VersionedTransaction)
      // 2. Extract Jupiter instruction data + accounts
      // 3. Build execute_swap instruction with remaining_accounts
      // 4. Sign with operator keypair
      // 5. Send transaction via RPC

      // For now, log the decision and quote in DB
      const pnl = decision.pnl_pct ? (decision.amount_sol || 0) * (decision.pnl_pct / 100) : 0;

      await db.prepare(`
        INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, price_at_trade, pnl)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        agent.id,
        decision.token,
        decision.action,
        decision.action === "buy" ? (decision.amount_sol || 0.01) : 0,
        decision.action === "sell" ? decision.amount : 0,
        quote.outAmount ? parseInt(quote.outAmount) : 0,
        pnl
      ).run();

      // Update agent PnL
      if (pnl !== 0) {
        await db.prepare(
          "UPDATE agents SET total_pnl = total_pnl + ?, total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?"
        ).bind(pnl, agent.id).run();
      } else {
        await db.prepare(
          "UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?"
        ).bind(agent.id).run();
      }

      results.push({
        agent: agent.id,
        action: decision.action,
        token: decision.token,
        symbol: decision.symbol,
        reason: decision.reason,
      });

    } catch (e) {
      results.push({ agent: agent.id, action: "error", reason: e.message });
    }
  }

  return Response.json({ processed: results.length, results });
}
