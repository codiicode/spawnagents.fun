import { getTokenBalances, getJupiterQuote, getJupiterSwapTx, signAndSendSwapTx, getPumpPortalTx, setJupiterApiKey, SOL_MINT, sendSol, getBalance } from "../_lib/solana.js";
import { getTokenData } from "../_lib/market-data.js";

export async function onRequest(context) {
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (context.env.JUPITER_API_KEY) setJupiterApiKey(context.env.JUPITER_API_KEY);

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const kv = context.env.AGENT_KEYS;
  const url = new URL(context.request.url);
  const mode = url.searchParams.get("mode") || "old";

  // Withdraw mode: send all SOL from agent wallet to a target address
  if (mode === "withdraw") {
    const agentId = url.searchParams.get("agent_id");
    const toAddress = url.searchParams.get("to");
    if (!agentId || !toAddress) return Response.json({ error: "Need agent_id and to params" }, { status: 400 });

    const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId).first();
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const agentSecret = await kv.get(`agent:${agentId}:secret`);
    if (!agentSecret) return Response.json({ error: "No secret key" }, { status: 404 });

    const balance = await getBalance(agent.agent_wallet, rpcUrl);
    const requestedAmount = parseFloat(url.searchParams.get("amount") || "0");
    const sendAmount = requestedAmount > 0 ? Math.min(requestedAmount, balance - 0.001) : balance - 0.001;
    if (sendAmount <= 0) return Response.json({ error: "Insufficient balance", balance });

    try {
      const txSig = await sendSol(agentSecret, toAddress, sendAmount, rpcUrl);
      return Response.json({ success: true, agent_id: agentId, sent: sendAmount, to: toAddress, tx: txSig });
    } catch (e) {
      return Response.json({ error: e.message, balance }, { status: 500 });
    }
  }
  const maxValueUsd = parseFloat(url.searchParams.get("max_usd") || "10");
  const maxAgeHours = parseFloat(url.searchParams.get("max_age_hours") || "240"); // 10 days
  const targetSymbol = url.searchParams.get("symbol")?.toUpperCase();
  const targetMint = url.searchParams.get("mint");

  // Mint mode: sell a specific token by mint address from all agents (works even if rugged/delisted)
  if (mode === "mint" && targetMint) {
    const agents = await db.prepare("SELECT * FROM agents WHERE status = 'alive'").all();
    const results = [];
    for (const agent of agents.results) {
      const agentSecret = await kv.get(`agent:${agent.id}:secret`);
      if (!agentSecret) continue;
      const tokens = await getTokenBalances(agent.agent_wallet, rpcUrl).catch(() => []);
      const token = tokens.find(t => t.mint === targetMint);
      if (!token || token.amount <= 0) continue;

      // Try PumpPortal first (pump tokens), then Jupiter
      let txSig;
      try {
        const ppTx = await getPumpPortalTx(agent.agent_wallet, 'sell', targetMint, token.amount, {
          denominatedInSol: false, slippage: 30, pool: 'auto',
        });
        if (ppTx) txSig = await signAndSendSwapTx(ppTx, agentSecret, rpcUrl);
      } catch (e) { console.error(`PumpPortal fail for ${agent.id}:`, e.message); }

      if (!txSig) {
        try {
          const quote = await getJupiterQuote(targetMint, SOL_MINT, token.rawAmount);
          if (quote) {
            const swapTx = await getJupiterSwapTx(quote, agent.agent_wallet);
            if (swapTx) txSig = await signAndSendSwapTx(swapTx, agentSecret, rpcUrl);
          }
        } catch (e) { console.error(`Jupiter fail for ${agent.id}:`, e.message); }
      }

      if (txSig) {
        await db.batch([
          db.prepare(
            "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', 0, ?, 0, 0, ?)"
          ).bind(agent.id, targetMint, token.amount, txSig),
          db.prepare("UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?").bind(agent.id),
          db.prepare("INSERT INTO events (type, agent_id, data) VALUES ('trade', ?, ?)").bind(agent.id, JSON.stringify({ action: 'sell', token: targetMint.slice(0,8), reason: 'FORCE SELL (rug)', tx: txSig })),
        ]);
        results.push({ agent: agent.id, amount: token.amount, tx: txSig });
      } else {
        results.push({ agent: agent.id, amount: token.amount, error: 'all sell methods failed' });
      }
    }
    return Response.json({ forced_sells: results.filter(r => r.tx).length, results });
  }

  const DEGEN_IDS = new Set(["the-berserker", "the-gambler", "the-beast", "the-turtle", "the-monk"]);

  // Degen mode: sell all degen holdings over a mcap threshold via PumpPortal
  if (mode === "degen") {
    const maxMcap = parseFloat(url.searchParams.get("max_mcap") || "150000");
    const results = [];

    for (const agentId of DEGEN_IDS) {
      const agent = await db.prepare("SELECT * FROM agents WHERE id = ? AND status = 'alive'").bind(agentId).first();
      if (!agent) continue;
      const agentSecret = await kv.get(`agent:${agentId}:secret`);
      if (!agentSecret) continue;

      const tokens = await getTokenBalances(agent.agent_wallet, rpcUrl).catch(() => []);
      for (const token of tokens) {
        const data = await getTokenData(token.mint).catch(() => null);
        const mcap = data?.market_cap || 0;
        if (mcap <= maxMcap && mcap > 0) continue; // under cap, keep it

        try {
          const ppTx = await getPumpPortalTx(agent.agent_wallet, 'sell', token.mint, token.amount, {
            denominatedInSol: false, slippage: 25, pool: 'auto',
          });
          if (!ppTx) { results.push({ agent: agentId, token: data?.symbol || token.mint.slice(0,6), mcap, error: 'pumpportal tx failed' }); continue; }

          const txSig = await signAndSendSwapTx(ppTx, agentSecret, rpcUrl);
          await db.batch([
            db.prepare(
              "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', 0, ?, 0, 0, ?)"
            ).bind(agentId, token.mint, token.amount, txSig),
            db.prepare("UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?").bind(agentId),
          ]);
          results.push({ agent: agentId, token: data?.symbol || token.mint.slice(0,6), mcap, amount: token.amount, tx: txSig });
        } catch (e) {
          results.push({ agent: agentId, token: data?.symbol || token.mint.slice(0,6), mcap, error: e.message });
        }
      }
    }
    return Response.json({ forced_sells: results.length, results });
  }

  // --- Original modes (Jupiter) ---
  const agents = await db.prepare("SELECT * FROM agents WHERE status = 'alive'").all();
  const results = [];

  for (const agent of agents.results) {
    const agentSecret = await kv.get(`agent:${agent.id}:secret`);
    if (!agentSecret) continue;

    const tokens = await getTokenBalances(agent.agent_wallet, rpcUrl).catch(() => []);

    for (const token of tokens) {
      const data = await getTokenData(token.mint).catch(() => null);
      const valueUsd = data ? data.price_usd * token.amount : 0;

      if (mode === "symbol") {
        if (!data || data.symbol?.toUpperCase() !== targetSymbol) continue;
      } else if (mode === "small") {
        if (valueUsd >= maxValueUsd || valueUsd === 0) continue;
      } else {
        // "old" mode — sell tokens older than maxAgeHours
        if (!data || data.pair_age_hours < maxAgeHours) continue;
      }

      // Get sell quote
      const quote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
      if (!quote) { results.push({ agent: agent.id, token: data?.symbol || token.mint.slice(0,6), error: "no quote" }); continue; }

      const outSol = parseInt(quote.outAmount) / 1e9;

      const swapTx = await getJupiterSwapTx(quote, agent.agent_wallet);
      if (!swapTx) { results.push({ agent: agent.id, token: data?.symbol || token.mint.slice(0,6), error: "swap tx failed" }); continue; }

      try {
        const txSig = await signAndSendSwapTx(swapTx, agentSecret, rpcUrl);

        await db.batch([
          db.prepare(
            "INSERT INTO trades (agent_id, token_address, action, amount_sol, token_amount, pnl, price_at_trade, tx_signature) VALUES (?, ?, 'sell', ?, ?, 0, 0, ?)"
          ).bind(agent.id, token.mint, outSol, token.amount, txSig),
          db.prepare(
            "UPDATE agents SET total_trades = total_trades + 1, last_trade_at = datetime('now') WHERE id = ?"
          ).bind(agent.id),
        ]);

        const ageH = data?.pair_age_hours ? data.pair_age_hours.toFixed(0) + 'h' : '?';
        results.push({ agent: agent.id, token: data?.symbol || token.mint.slice(0,6), value_usd: valueUsd.toFixed(2), age: ageH, out_sol: outSol.toFixed(4), tx: txSig });
      } catch (e) {
        results.push({ agent: agent.id, token: data?.symbol || token.mint.slice(0,6), error: e.message });
      }
    }
  }

  return Response.json({ forced_sells: results.length, results });
}
