export async function onRequest(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });

  const db = context.env.DB;
  const row = await db.prepare(
    "SELECT status, verified_wallet FROM login_requests WHERE id = ?"
  ).bind(id).first();

  if (!row) return Response.json({ error: 'Not found' }, { status: 404 });

  return Response.json({ status: row.status, wallet: row.verified_wallet });
}
