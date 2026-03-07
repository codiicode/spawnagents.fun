export async function onRequest(context) {
  const rpcUrl = context.env.RPC_URL;
  if (!rpcUrl) return Response.json({ error: 'RPC not configured' }, { status: 500 });

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'finalized' }] }),
    });
    const data = await res.json();
    if (data.error) return Response.json({ error: data.error.message }, { status: 500 });
    return Response.json({ blockhash: data.result.value.blockhash });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
