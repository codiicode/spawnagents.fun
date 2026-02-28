import { getTokenBalances, getJupiterQuote, getJupiterSwapTx, signAndSendSwapTx, setJupiterApiKey, SOL_MINT } from "../_lib/solana.js";
import { getTokenData } from "../_lib/market-data.js";

export async function onRequest(context) {
  const secret = context.request.headers.get("x-cron-secret");
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (context.env.JUPITER_API_KEY) setJupiterApiKey(context.env.JUPITER_API_KEY);

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const kv = context.env.AGENT_KEYS;
  const url = new URL(context.request.url);
  const mode = url.searchParams.get("mode") || "old"; // "old" = age filter, "small" = value filter, "symbol" = specific token
  const maxValueUsd = parseFloat(url.searchParams.get("max_usd") || "10");
  const maxAgeHours = parseFloat(url.searchParams.get("max_age_hours") || "240"); // 10 days
  const targetSymbol = url.searchParams.get("symbol")?.toUpperCase();

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
