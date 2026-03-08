export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      // Fire and return immediately — work continues in background
      ctx.waitUntil(runCron(env));
      return new Response('ok');
    }
    return new Response('alive');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function runCron(env) {
  const siteUrl = env.SITE_URL;
  const headers = { "Content-Type": "application/json", "X-Cron-Secret": env.CRON_SECRET };

  // Stagger batches to avoid RPC rate limits (10s between each)
  for (let b = 0; b < 3; b++) {
    await fetch(`${siteUrl}/api/process-trades?batch=${b}&batches=3`, { method: "POST", headers }).catch(() => {});
    if (b < 2) await new Promise(r => setTimeout(r, 10000));
  }

  await fetch(`${siteUrl}/api/recalc-pnl`, { headers }).catch(() => {});

  const now = new Date();
  if (now.getUTCHours() % 6 === 0 && now.getUTCMinutes() < 5) {
    await fetch(`${siteUrl}/api/distribute-royalties`, { method: "POST", headers }).catch(() => {});
  }

  await fetch(`${siteUrl}/api/verify-payments`, { method: "POST", headers }).catch(() => {});
}
