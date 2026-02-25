export async function onRequestGET(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const genesisId = url.searchParams.get("genesis");

  if (!genesisId) {
    // Return all genesis agents as roots
    const roots = await db.prepare(
      "SELECT id, owner_wallet, status, total_pnl, total_trades, born_at, dna FROM agents WHERE generation = 0 ORDER BY born_at ASC"
    ).all();

    return Response.json({
      roots: roots.results.map(r => ({ ...r, dna: JSON.parse(r.dna) }))
    });
  }

  // Full tree for a specific genesis
  const allDescendants = await db.prepare(`
    WITH RECURSIVE tree AS (
      SELECT id, parent_id, generation, owner_wallet, status, total_pnl, total_trades, born_at, dna
      FROM agents WHERE id = ?
      UNION ALL
      SELECT a.id, a.parent_id, a.generation, a.owner_wallet, a.status, a.total_pnl, a.total_trades, a.born_at, a.dna
      FROM agents a
      JOIN tree t ON a.parent_id = t.id
    )
    SELECT * FROM tree ORDER BY generation ASC, born_at ASC
  `).bind(genesisId).all();

  // Build nested tree
  const nodes = allDescendants.results.map(a => ({
    ...a,
    dna: JSON.parse(a.dna),
    children: []
  }));

  const map = {};
  nodes.forEach(n => map[n.id] = n);

  let root = null;
  nodes.forEach(n => {
    if (n.id === genesisId) {
      root = n;
    } else if (map[n.parent_id]) {
      map[n.parent_id].children.push(n);
    }
  });

  return Response.json({ tree: root });
}
