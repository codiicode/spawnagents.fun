export async function onRequest(context) {
  if (context.request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const secret = context.request.headers.get('x-cron-secret');
  if (secret !== context.env.CRON_SECRET) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { agent_id } = await context.request.json();
  if (!agent_id) return Response.json({ error: 'Missing agent_id' }, { status: 400 });
  const key = await context.env.AGENT_KEYS.get(`agent:${agent_id}:secret`);
  if (!key) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ key });
}
