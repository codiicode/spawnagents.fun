export default {
  async scheduled(event, env, ctx) {
    const siteUrl = env.SITE_URL;
    if (!siteUrl) {
      console.error("SITE_URL not configured");
      return;
    }

    const headers = {
      "Content-Type": "application/json",
      "X-Cron-Secret": env.CRON_SECRET,
    };

    // 1. Process agent trades
    try {
      const tradeRes = await fetch(`${siteUrl}/api/process-trades`, {
        method: "POST",
        headers,
      });
      const tradeData = await tradeRes.json();
      console.log(`Processed trades: ${tradeData.processed || 0} agents`);
    } catch (e) {
      console.error("Failed to process trades:", e);
    }

    // 2. Distribute royalties (runs every cycle but only pays out when there's new profit)
    try {
      const royaltyRes = await fetch(`${siteUrl}/api/distribute-royalties`, {
        method: "POST",
        headers,
      });
      const royaltyData = await royaltyRes.json();
      if (royaltyData.payments > 0) {
        console.log(`Distributed ${royaltyData.payments} royalty payments, total: ${royaltyData.total_distributed} SOL`);
      }
    } catch (e) {
      console.error("Failed to distribute royalties:", e);
    }

    // 3. Verify pending payments (Solana Pay)
    try {
      const payRes = await fetch(`${siteUrl}/api/verify-payments`, {
        method: "POST",
        headers,
      });
      const payData = await payRes.json();
      if (payData.confirmed > 0) {
        console.log(`Verified ${payData.confirmed} payments (${payData.pending} were pending)`);
      }
    } catch (e) {
      console.error("Failed to verify payments:", e);
    }
  },
};
