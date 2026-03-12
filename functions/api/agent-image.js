export async function onRequest(context) {
  const url = new URL(context.request.url);
  const agentId = url.searchParams.get('id');
  if (!agentId) return new Response('Missing id', { status: 400 });

  const kv = context.env.AGENT_KEYS;
  if (!kv) return new Response('KV not configured', { status: 500 });

  if (context.request.method === 'GET') {
    const data = await kv.get(`agent:${agentId}:image`);
    if (!data) return new Response('No image', { status: 404 });

    // data is "data:image/jpeg;base64,..." or "data:image/png;base64,..."
    const match = data.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return new Response('Invalid image data', { status: 500 });

    const contentType = match[1];
    const raw = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    return new Response(raw, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' } });
  }

  if (context.request.method === 'POST') {
    const body = await context.request.json();
    const { owner_wallet, image_data } = body;
    if (!owner_wallet || !image_data) return Response.json({ error: 'Missing fields' }, { status: 400 });

    // Verify ownership
    const db = context.env.DB;
    const agent = await db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').bind(agentId).first();
    if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
    if (agent.owner_wallet !== owner_wallet) return Response.json({ error: 'Not the owner' }, { status: 403 });

    // Validate it's a data URL and not too large (max ~200KB base64)
    if (!image_data.startsWith('data:image/')) return Response.json({ error: 'Invalid image format' }, { status: 400 });
    if (image_data.length > 300000) return Response.json({ error: 'Image too large (max ~200KB)' }, { status: 400 });

    await kv.put(`agent:${agentId}:image`, image_data);
    return Response.json({ success: true });
  }

  return new Response('Method not allowed', { status: 405 });
}
