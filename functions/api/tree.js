export async function onRequest(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const genesisId = url.searchParams.get("genesis");
  try {
    if (!genesisId) {
      const roots = await db.prepare("SELECT id, generation, status, total_pnl FROM agents WHERE parent_id IS NULL ORDER BY created_at").all();
      return Response.json({ trees: roots.results });
    }
    const all = await db.prepare("WITH RECURSIVE tree AS (SELECT id, parent_id, generation, status, total_pnl, dna FROM agents WHERE id = ? UNION ALL SELECT a.id, a.parent_id, a.generation, a.status, a.total_pnl, a.dna FROM agents a JOIN tree t ON a.parent_id = t.id) SELECT * FROM tree").bind(genesisId).all();
    function buildTree(pid) {
      const node = all.results.find(a => a.id === pid);
      if (!node) return null;
      node.dna = JSON.parse(node.dna || "{}");
      node.children = all.results.filter(a => a.parent_id === pid).map(c => buildTree(c.id)).filter(Boolean);
      return node;
    }
    return Response.json({ tree: buildTree(genesisId) });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
