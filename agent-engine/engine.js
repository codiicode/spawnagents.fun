import { getTrendingTokens, getTokenData } from "./market-data.js";

// Main decision loop for a single agent
export async function processAgent(agent, db) {
  const dna = JSON.parse(agent.dna);

  // 1. Get market data
  const tokens = await getTrendingTokens(dna.focus);
  if (tokens.length === 0) return { action: "idle", reason: "no tokens found" };

  // 2. Check existing positions (open buys without matching sells)
  const openPositions = await db.prepare(`
    SELECT token_address, SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as bought,
           SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as sold,
           SUM(CASE WHEN action='buy' THEN token_amount ELSE 0 END) as tokens_bought,
           SUM(CASE WHEN action='sell' THEN token_amount ELSE 0 END) as tokens_sold
    FROM trades WHERE agent_id = ?
    GROUP BY token_address
    HAVING bought > sold
  `).bind(agent.id).all();

  // 3. Check sells first (take profit / stop loss)
  for (const pos of openPositions.results) {
    const currentData = await getTokenData(pos.token_address);
    if (!currentData) continue;

    const holdingTokens = (pos.tokens_bought || 0) - (pos.tokens_sold || 0);
    if (holdingTokens <= 0) continue;

    const costBasis = pos.bought - pos.sold;
    const currentValue = holdingTokens * currentData.price_usd; // Approximate
    const pnlPct = costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0;

    // Take profit — patience lowers the threshold (more patient = holds longer)
    const adjustedProfitThreshold = dna.sell_profit_pct * (1 + dna.patience * 0.5);
    if (pnlPct >= adjustedProfitThreshold) {
      return {
        action: "sell",
        token: pos.token_address,
        symbol: currentData.symbol,
        reason: `take profit at ${pnlPct.toFixed(1)}% (threshold: ${adjustedProfitThreshold.toFixed(1)}%)`,
        amount: holdingTokens,
        pnl_pct: pnlPct
      };
    }

    // Stop loss — risk_tolerance raises the threshold (more risk-tolerant = holds through dips)
    const adjustedLossThreshold = dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5);
    if (pnlPct <= -adjustedLossThreshold) {
      return {
        action: "sell",
        token: pos.token_address,
        symbol: currentData.symbol,
        reason: `stop loss at ${pnlPct.toFixed(1)}% (threshold: -${adjustedLossThreshold.toFixed(1)}%)`,
        amount: holdingTokens,
        pnl_pct: pnlPct
      };
    }
  }

  // 4. Check buys — find tokens that match DNA criteria
  const heldTokens = new Set(openPositions.results.map(p => p.token_address));

  for (const token of tokens) {
    if (heldTokens.has(token.address)) continue; // Already holding

    // Volume check (mapped from SOL — approximate)
    const volumeOk = token.volume_24h >= dna.buy_threshold_volume;

    // Aggression adds randomness — high aggression = more likely to buy marginal tokens
    const aggressionBoost = Math.random() < dna.aggression ? 0.7 : 1.0;
    const adjustedVolumeThreshold = dna.buy_threshold_volume * aggressionBoost;

    if (token.volume_24h >= adjustedVolumeThreshold && token.liquidity_usd > 5000) {
      // Check position sizing
      // TODO: Get agent's SOL balance to calculate max_position_pct
      const tradeAmountSol = 0.01; // Start micro — configurable later

      return {
        action: "buy",
        token: token.address,
        symbol: token.symbol,
        reason: `volume ${token.volume_24h} > threshold ${adjustedVolumeThreshold.toFixed(0)}, liq $${token.liquidity_usd.toFixed(0)}`,
        amount_sol: tradeAmountSol
      };
    }
  }

  return { action: "hold", reason: "no signals" };
}
