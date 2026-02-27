export async function onRequest(context) {
  const db = context.env.DB;

  // GET — poll DB status
  if (context.request.method === 'GET') {
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });

    const row = await db.prepare(
      "SELECT status, verified_wallet FROM login_requests WHERE id = ?"
    ).bind(id).first();

    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ status: row.status, wallet: row.verified_wallet });
  }

  // POST — trigger immediate on-chain verification
  if (context.request.method === 'POST') {
    let body;
    try { body = await context.request.json(); } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { id } = body;
    if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });

    const lr = await db.prepare(
      "SELECT id, micro_amount, status FROM login_requests WHERE id = ? AND status = 'pending'"
    ).bind(id).first();

    if (!lr) return Response.json({ error: 'No pending login found' }, { status: 404 });

    const rpcUrl = context.env.RPC_URL;
    const protocolWallet = context.env.PROTOCOL_WALLET;
    if (!rpcUrl || !protocolWallet) return Response.json({ error: 'Not configured' }, { status: 500 });

    try {
      const recentSigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [protocolWallet, { limit: 10 }]);

      if (recentSigs?.length > 0) {
        for (const sig of recentSigs) {
          if (sig.err) continue;

          const tx = await rpcCall(rpcUrl, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          if (!tx?.meta) continue;

          const accounts = tx.transaction.message.accountKeys;
          let protoIdx = -1;
          for (let i = 0; i < accounts.length; i++) {
            const pk = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].pubkey;
            if (pk === protocolWallet) { protoIdx = i; break; }
          }
          if (protoIdx < 0) continue;

          const solReceived = (tx.meta.postBalances[protoIdx] - tx.meta.preBalances[protoIdx]) / 1e9;

          // Only micro amounts (login range)
          if (solReceived < 0.0005 || solReceived > 0.003) continue;

          if (Math.abs(solReceived - lr.micro_amount) <= lr.micro_amount * 0.05) {
            const sender = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;
            await db.prepare(
              "UPDATE login_requests SET status = 'verified', verified_wallet = ? WHERE id = ?"
            ).bind(sender, lr.id).run();

            return Response.json({ status: 'verified', wallet: sender });
          }
        }
      }
    } catch (e) {
      console.error('Login verify error:', e.message);
    }

    return Response.json({ status: 'pending', message: 'Transaction not found yet' });
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
