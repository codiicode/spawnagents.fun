import { getBalance, getTokenBalances } from "../_lib/solana.js";
import { getTokenData } from "../_lib/market-data.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const agentId = url.searchParams.get("agent_id");
  const walletParam = url.searchParams.get("wallet");

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  if (!rpcUrl) return Response.json({ error: "RPC_URL not configured" }, { status: 500 });

  // Resolve wallet — either from agent_id lookup or direct param
  let wallet = walletParam;
  if (agentId && db) {
    const agent = await db.prepare("SELECT agent_wallet FROM agents WHERE id = ?").bind(agentId).first();
    if (agent) wallet = agent.agent_wallet;
  }
  if (!wallet) return Response.json({ error: "wallet or agent_id required" }, { status: 400 });

  try {
    // Try KV cache first (populated by Hetzner pnl-recalc every 10 min)
    let solBalance, tokenBalances;
    const kv = context.env.AGENT_KEYS;
    const cachedRaw = agentId && kv ? await kv.get(`balance:${agentId}`) : null;
    const cachedData = cachedRaw ? JSON.parse(cachedRaw) : null;
    if (cachedData) {
      solBalance = cachedData.sol;
      tokenBalances = cachedData.tokens || [];
    } else {
      [solBalance, tokenBalances] = await Promise.all([
        getBalance(wallet, rpcUrl),
        getTokenBalances(wallet, rpcUrl).catch(() => []),
      ]);
    }

    // Get cost basis per token from trades table
    const tokenTradeInfo = {};
    if (agentId && db) {
      const trades = await db.prepare(
        "SELECT token_address, action, amount_sol, token_amount FROM trades WHERE agent_id = ?"
      ).bind(agentId).all();
      for (const t of trades.results) {
        if (!tokenTradeInfo[t.token_address]) {
          tokenTradeInfo[t.token_address] = { totalBoughtSol: 0, totalBoughtTokens: 0, totalSoldSol: 0, hasZeroSells: false };
        }
        const info = tokenTradeInfo[t.token_address];
        if (t.action === 'buy') {
          info.totalBoughtSol += t.amount_sol;
          info.totalBoughtTokens += (t.token_amount || 0);
        }
        if (t.action === 'sell') {
          if (t.amount_sol > 0) {
            info.totalSoldSol += t.amount_sol;
          } else {
            info.hasZeroSells = true;
          }
        }
      }
    }

    // SOL price via DexScreener
    let solPrice = 0;
    try {
      const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
      if (res.ok) {
        const d = await res.json();
        const usdcPair = (d.pairs || []).find(p => p.chainId === "solana" && p.quoteToken?.symbol === "USDC");
        if (usdcPair) solPrice = parseFloat(usdcPair.priceUsd || 0);
      }
    } catch {}

    // Build price lookup from KV cache (Hetzner populates this with DexScreener data)
    const cachedPrices = {};
    if (cachedData) {
      for (const t of (cachedData.tokens || [])) {
        cachedPrices[t.mint] = { price_native: t.price_native || 0, symbol: t.symbol || t.mint.slice(0, 6) };
      }
    }

    // Look up prices and calculate PnL for each token
    const tokens = [];
    for (const t of tokenBalances) {
      // Use cached price from Hetzner (avoids DexScreener rate limiting from Worker)
      const cp = cachedPrices[t.mint];
      let priceNative = cp?.price_native || 0;
      let symbol = cp?.symbol || t.mint.slice(0, 6);
      let priceUsd = priceNative * solPrice;

      // Fallback to DexScreener only if no cache
      if (!cp) {
        const data = await getTokenData(t.mint).catch(() => null);
        if (data) {
          priceUsd = data.price_usd || 0;
          priceNative = data.price_native || 0;
          symbol = data.symbol || symbol;
        }
      }

      const valueUsd = priceUsd * t.amount;

      const info = tokenTradeInfo[t.mint];
      let costBasisSol = 0;

      if (info) {
        if (info.hasZeroSells) {
          if (priceNative > 0) {
            costBasisSol = priceNative * t.amount;
          }
        } else {
          costBasisSol = info.totalBoughtSol - info.totalSoldSol;
          if (costBasisSol < 0) costBasisSol = 0;
        }
      }

      const costBasisUsd = costBasisSol * solPrice;
      const pnlUsd = costBasisUsd > 0 ? valueUsd - costBasisUsd : 0;
      const pnlPct = costBasisUsd > 0 ? ((valueUsd - costBasisUsd) / costBasisUsd) * 100 : 0;

      tokens.push({
        mint: t.mint,
        symbol,
        amount: t.amount,
        price_usd: priceUsd,
        value_usd: valueUsd,
        cost_basis_sol: costBasisSol,
        cost_basis_usd: costBasisUsd,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
      });
    }

    const solValueUsd = solBalance * solPrice;
    const tokensValueUsd = tokens.reduce((sum, t) => sum + t.value_usd, 0);
    const totalPnlUsd = tokens.reduce((sum, t) => sum + t.pnl_usd, 0);

    return Response.json({
      wallet,
      sol_balance: solBalance,
      sol_price: solPrice,
      sol_value_usd: solValueUsd,
      tokens,
      total_value_usd: solValueUsd + tokensValueUsd,
      total_pnl_usd: totalPnlUsd,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
