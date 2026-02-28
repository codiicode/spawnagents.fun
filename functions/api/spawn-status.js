export async function onRequest(context) {
  const url = new URL(context.request.url);
  const spawnId = url.searchParams.get('id');
  if (!spawnId) return Response.json({ error: 'Missing id' }, { status: 400 });

  const db = context.env.DB;
  const pending = await db.prepare('SELECT * FROM pending_spawns WHERE id = ?').bind(spawnId).first();
  if (!pending) return Response.json({ error: 'Not found' }, { status: 404 });

  const result = { status: pending.status, spawn_cost: pending.spawn_cost, sol_amount: pending.sol_amount };

  if (pending.status === 'confirmed') {
    const spawn = await db.prepare(
      'SELECT child_id, mutation_log FROM spawns WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(pending.parent_id).first();

    if (spawn) {
      const child = await db.prepare(
        'SELECT id, generation, dna, agent_wallet FROM agents WHERE id = ?'
      ).bind(spawn.child_id).first();

      if (child) {
        result.child = {
          id: child.id,
          generation: child.generation,
          dna: JSON.parse(child.dna),
          mutations: JSON.parse(spawn.mutation_log),
          agent_wallet: child.agent_wallet,
        };
      }
    }
  }

  return Response.json(result);
}
