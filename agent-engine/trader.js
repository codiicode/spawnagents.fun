import { getQuote, SOL_MINT } from "./market-data.js";

const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const LAMPORTS_PER_SOL = 1_000_000_000;

// Execute a buy (SOL → Token)
export async function executeBuy(agentWallet, tokenMint, amountSol, rpcUrl) {
  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Get quote
  const quote = await getQuote(SOL_MINT, tokenMint, amountLamports);
  if (!quote) return { success: false, error: "No quote available" };

  // Get swap transaction
  try {
    const swapRes = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentWallet,
        wrapAndUnwrapSol: true,
      })
    });

    if (!swapRes.ok) return { success: false, error: "Swap API failed" };

    const swapData = await swapRes.json();

    // TODO: Sign and send transaction using agent's private key
    // This requires Ed25519 signing — same pattern as FORTUNA's draw.js
    return {
      success: true,
      quote: {
        input_amount: amountSol,
        output_amount: parseInt(quote.outAmount) / Math.pow(10, quote.outputMint?.decimals || 6),
        price_impact: quote.priceImpactPct,
      },
      swap_transaction: swapData.swapTransaction,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Execute a sell (Token → SOL)
export async function executeSell(agentWallet, tokenMint, tokenAmount, tokenDecimals, rpcUrl) {
  const amountRaw = Math.floor(tokenAmount * Math.pow(10, tokenDecimals || 6));

  const quote = await getQuote(tokenMint, SOL_MINT, amountRaw);
  if (!quote) return { success: false, error: "No quote available" };

  try {
    const swapRes = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentWallet,
        wrapAndUnwrapSol: true,
      })
    });

    if (!swapRes.ok) return { success: false, error: "Swap API failed" };

    const swapData = await swapRes.json();

    return {
      success: true,
      quote: {
        input_amount: tokenAmount,
        output_sol: parseInt(quote.outAmount) / LAMPORTS_PER_SOL,
        price_impact: quote.priceImpactPct,
      },
      swap_transaction: swapData.swapTransaction,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
