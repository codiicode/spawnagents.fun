import { getTrendingTokens, getTokenData } from "./market-data.js";
import {
  SOL_MINT,
  getBalance,
  getTokenBalances,
  getJupiterQuote,
  getJupiterSwapTx,
  signAndSendSwapTx,
} from "./solana.js";

export async function processAgent(agent, db, rpcUrl, agentSecret, agentPubkey) {
  const dna = JSON.parse(agent.dna);

  // Get real SOL balance
  const solBalance = await getBalance(agentPubkey, rpcUrl);

  // Get on-chain token holdings
  const tokenBalances = await getTokenBalances(agentPubkey, rpcUrl);

  // --- SELL SIGNALS: check existing positions ---
  for (const token of tokenBalances) {
    const tokenData = await getTokenData(token.mint);
    if (!tokenData) continue;

    // Cost basis from DB
    const costRow = await db.prepare(
      "SELECT SUM(CASE WHEN action='buy' THEN amount_sol ELSE 0 END) as total_bought, SUM(CASE WHEN action='sell' THEN amount_sol ELSE 0 END) as total_sold FROM trades WHERE agent_id = ? AND token_address = ?"
    ).bind(agent.id, token.mint).first();

    const costBasis = (costRow?.total_bought || 0) - (costRow?.total_sold || 0);
    if (costBasis <= 0) continue;

    // Get Jupiter quote to see what we'd get selling all tokens → SOL
    const sellQuote = await getJupiterQuote(token.mint, SOL_MINT, token.rawAmount);
    if (!sellQuote) continue;

    const outSol = parseInt(sellQuote.outAmount) / 1e9;
    const pnlPct = ((outSol - costBasis) / costBasis) * 100;

    // Take profit
    if (pnlPct >= dna.sell_profit_pct * (1 + dna.patience * 0.5)) {
      return await executeSell(sellQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol, reason: 'take profit',
        pnlPct, outSol, tokenAmount: token.amount,
      });
    }

    // Stop loss
    if (pnlPct <= -(dna.sell_loss_pct * (1 + dna.risk_tolerance * 0.5))) {
      return await executeSell(sellQuote, agentPubkey, agentSecret, rpcUrl, {
        token: token.mint, symbol: tokenData.symbol, reason: 'stop loss',
        pnlPct, outSol, tokenAmount: token.amount,
      });
    }
  }

  // --- BUY SIGNALS ---
  // Keep 0.01 SOL reserve for tx fees
  const availableSol = solBalance - 0.01;
  if (availableSol < 0.005) return { action: 'hold', reason: 'insufficient balance' };

  const tradeAmountSol = Math.min(availableSol, availableSol * (dna.max_position_pct / 100));
  const tradeAmountLamports = Math.round(tradeAmountSol * 1e9);

  const tokens = await getTrendingTokens(dna.focus);
  if (tokens.length === 0) return { action: 'idle', reason: 'no tokens found' };

  const heldMints = new Set(tokenBalances.map(t => t.mint));

  for (const t of tokens) {
    if (heldMints.has(t.address)) continue;

    const threshold = (dna.buy_threshold_volume || 500) * (Math.random() < dna.aggression ? 0.7 : 1.0);
    if (t.volume_24h >= threshold && t.liquidity_usd > 5000) {
      const buyQuote = await getJupiterQuote(SOL_MINT, t.address, tradeAmountLamports);
      if (!buyQuote) continue;

      const swapTx = await getJupiterSwapTx(buyQuote, agentPubkey);
      if (!swapTx) continue;

      try {
        const txSig = await signAndSendSwapTx(swapTx, agentSecret, rpcUrl);
        const tokenAmount = parseInt(buyQuote.outAmount) / (10 ** (t.decimals || 6));
        return {
          action: 'buy',
          token: t.address,
          symbol: t.symbol,
          reason: 'signal match',
          amount_sol: tradeAmountSol,
          token_amount: tokenAmount,
          tx_signature: txSig,
        };
      } catch (e) {
        console.error(`Swap failed for ${t.symbol}:`, e.message);
        continue;
      }
    }
  }

  return { action: 'hold', reason: 'no signals' };
}

async function executeSell(quote, pubkey, secret, rpcUrl, info) {
  const swapTx = await getJupiterSwapTx(quote, pubkey);
  if (!swapTx) return { action: 'hold', reason: 'swap tx failed' };

  try {
    const txSig = await signAndSendSwapTx(swapTx, secret, rpcUrl);
    return {
      action: 'sell',
      token: info.token,
      symbol: info.symbol,
      reason: info.reason,
      pnl_pct: info.pnlPct,
      amount_sol: info.outSol,
      token_amount: info.tokenAmount,
      tx_signature: txSig,
    };
  } catch (e) {
    console.error(`Sell failed for ${info.symbol}:`, e.message);
    return { action: 'hold', reason: 'sell tx failed' };
  }
}
