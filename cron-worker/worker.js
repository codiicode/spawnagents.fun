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
  },
};
