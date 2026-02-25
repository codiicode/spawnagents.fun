import { getTrendingTokens, getTokenData } from "./market-data.js";
export async function processAgent(agent, db) {
  const dna = JSON.parse(agent.dna);
  const tokens = await getTrendingTokens(dna.focus);
  if (tokens.length === 0) return { action: "idle", reason: "no tokens found" };
  const openPositions = await db.prepare("SELECT token_address, SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as bought, SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as sold, SUM(CASE WHEN action='buy' THEN token_amount ELSE 0 END) as tokens_bought, SUM(CASE WHEN action='sell' THEN token_amount ELSE 0 END) as tokens_sold FROM trades WHERE agent_id = ? GROUP BY token_address HAVING bought > sold").bind(agent.id).all();
  for (const pos of openPositions.results) {
    const currentData = await getTokenData(pos.token_address);
    if (!currentData) continue;
    const holdingTokens = (pos.tokens_bought || 0) - (pos.tokens_sold || 0);
    if (holdingTokens <= 0) continue;
    const costBasis = pos.bought - pos.sold;
    const currentValue = holdingTokens * currentData.price_usd;
    const pnlPct = costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0;
    if (pnlPct >= dna.sell_profit_pct * (1 + dna.patience * 0.5)) return { action: "sell", token: pos.token_address, symbol: currentData.symbol, reason: "take profit", amount: holdingTokens, pnl_pct: pnlPct };
    if (pnlPct <= -(dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5))) return { action: "sell", token: pos.token_address, symbol: currentData.symbol, reason: "stop loss", amount: holdingTokens, pnl_pct: pnlPct };
  }
  const heldTokens = new Set(openPositions.results.map(p => p.token_address));
  for (const token of tokens) {
    if (heldTokens.has(token.address)) continue;
    const threshold = dna.buy_threshold_volume * (Math.random() < dna.aggression ? 0.7 : 1.0);
    if (token.volume_24h >= threshold && token.liquidity_usd > 5000) return { action: "buy", token: token.address, symbol: token.symbol, reason: "signal match", amount_sol: 0.01 };
  }
  return { action: "hold", reason: "no signals" };
}
