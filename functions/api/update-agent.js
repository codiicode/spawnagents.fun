export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const body = await context.request.json();
  const { agent_id, owner_wallet, signature, message, meta, name } = body;
  const dna = body.dna ? { ...body.dna } : undefined;

  if (!agent_id || !owner_wallet) {
    return Response.json({ error: 'Missing agent_id or owner_wallet' }, { status: 400 });
  }

  const db = context.env.DB;

  // Fetch agent and verify ownership
  const agent = await db.prepare(
    'SELECT id, owner_wallet, status FROM agents WHERE id = ?'
  ).bind(agent_id).first();

  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (agent.status !== 'alive') return Response.json({ error: 'Agent is not alive' }, { status: 400 });
  if (agent.owner_wallet !== owner_wallet) {
    return Response.json({ error: 'Not the owner of this agent' }, { status: 403 });
  }

  // Ownership verified by matching owner_wallet above

  // Validate DNA
  if (dna) {
    const errors = [];
    if (typeof dna.aggression !== 'number' || dna.aggression < 0 || dna.aggression > 1) errors.push('aggression 0-1');
    if (typeof dna.risk_tolerance !== 'number' || dna.risk_tolerance < 0 || dna.risk_tolerance > 1) errors.push('risk_tolerance 0-1');
    if (typeof dna.patience !== 'number' || dna.patience < 0 || dna.patience > 1) errors.push('patience 0-1');
    if (typeof dna.sell_profit_pct !== 'number' || dna.sell_profit_pct < 0 || dna.sell_profit_pct > 1000) errors.push('sell_profit_pct 0-1000');
    if (typeof dna.sell_loss_pct !== 'number' || dna.sell_loss_pct < 1 || dna.sell_loss_pct > 100) errors.push('sell_loss_pct 1-100');
    if (typeof dna.max_position_pct !== 'number' || dna.max_position_pct < 10 || dna.max_position_pct > 90) errors.push('max_position_pct 10-90');
    if (errors.length > 0) return Response.json({ error: 'Invalid DNA: ' + errors.join(', ') }, { status: 400 });

    // Compute check_interval from aggression
    dna.check_interval_min = Math.round(2 + (1 - dna.aggression) * 10);
  }

  // Build update
  const updates = [];
  const binds = [];

  if (dna) {
    updates.push('dna = ?');
    binds.push(JSON.stringify(dna));
  }
  if (meta !== undefined) {
    updates.push('meta = ?');
    binds.push(typeof meta === 'string' ? meta : JSON.stringify(meta));
  }
  if (name && name.trim().length >= 2) {
    updates.push('name = ?');
    binds.push(name.trim());
  }

  if (updates.length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }

  binds.push(agent_id);
  await db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();

  await db.prepare(
    "INSERT INTO events (agent_id, type, data) VALUES (?, 'agent_updated', ?)"
  ).bind(agent_id, JSON.stringify({ updated_by: owner_wallet, fields: updates.map(u => u.split(' =')[0]) })).run();

  return Response.json({ success: true, agent_id });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
