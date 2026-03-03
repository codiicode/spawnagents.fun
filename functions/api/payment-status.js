export async function onRequest(context) {
  const db = context.env.DB;

  // GET — poll DB status (called every 3s by frontend)
  if (context.request.method === 'GET') {
    const url = new URL(context.request.url);
    const ref = url.searchParams.get('ref');
    if (!ref) return Response.json({ error: 'Missing ref parameter' }, { status: 400 });

    const pr = await db.prepare(
      'SELECT status, tx_signature, buyer_wallet, agent_id, amount FROM payment_requests WHERE reference = ?'
    ).bind(ref).first();

    if (!pr) return Response.json({ error: 'Payment not found' }, { status: 404 });

    let agent_wallet = null;
    if (pr.status === 'confirmed') {
      const agent = await db.prepare('SELECT agent_wallet FROM agents WHERE id = ?').bind(pr.agent_id).first();
      if (agent) agent_wallet = agent.agent_wallet;
    }

    return Response.json({
      status: pr.status,
      tx_signature: pr.tx_signature,
      buyer_wallet: pr.buyer_wallet,
      agent_id: pr.agent_id,
      amount: pr.amount,
      agent_wallet,
    });
  }

  // POST — trigger immediate on-chain verification for a specific payment
  if (context.request.method === 'POST') {
    let body;
    try { body = await context.request.json(); } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { reference } = body;
    if (!reference) return Response.json({ error: 'Missing reference' }, { status: 400 });

    const pr = await db.prepare(
      'SELECT id, agent_id, amount, reference, recipient, spawn_cost FROM payment_requests WHERE reference = ? AND status = ?'
    ).bind(reference, 'pending').first();

    if (!pr) return Response.json({ error: 'No pending payment found' }, { status: 404 });

    const rpcUrl = context.env.RPC_URL;
    if (!rpcUrl) return Response.json({ error: 'RPC not configured' }, { status: 500 });

    // --- Try 1: Reference-based lookup ---
    let found = false;
    try {
      const sigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [pr.reference, { limit: 1 }]);
      if (sigs?.length > 0 && !sigs[0].err) {
        found = await verifyAndConfirm(context, db, rpcUrl, pr, sigs[0].signature);
      }
    } catch (e) {
      console.error('Reference lookup error:', e.message);
    }

    // --- Try 2: Amount-matching fallback (for manual senders) ---
    if (!found) {
      try {
        const protocolAddr = context.env.PROTOCOL_WALLET;
        const recentSigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [protocolAddr, { limit: 10 }]);

        // Get already-used tx signatures to prevent double-matching
        const usedTxs = await db.prepare(
          "SELECT tx_signature FROM payment_requests WHERE tx_signature IS NOT NULL"
        ).all();
        const usedSigs = new Set(usedTxs.results.map(r => r.tx_signature));

        if (recentSigs?.length > 0) {
          for (const sig of recentSigs) {
            if (sig.err || usedSigs.has(sig.signature)) continue;
            const tx = await rpcCall(rpcUrl, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
            if (!tx?.meta) continue;

            const accounts = tx.transaction.message.accountKeys;
            let protoIdx = -1;
            for (let i = 0; i < accounts.length; i++) {
              const pk = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].pubkey;
              if (pk === protocolAddr) { protoIdx = i; break; }
            }
            if (protoIdx < 0) continue;

            const solReceived = (tx.meta.postBalances[protoIdx] - tx.meta.preBalances[protoIdx]) / 1e9;
            if (solReceived < 0.3) continue; // skip micro amounts

            if (Math.abs(solReceived - pr.amount) <= pr.amount * 0.05) {
              found = await verifyAndConfirm(context, db, rpcUrl, pr, sig.signature);
              if (found) break;
            }
          }
        }
      } catch (e) {
        console.error('Amount-matching error:', e.message);
      }
    }

    if (found) {
      // Return confirmed status with agent wallet
      const agent = await db.prepare('SELECT agent_wallet FROM agents WHERE id = ?').bind(pr.agent_id).first();
      const updated = await db.prepare('SELECT status, amount, buyer_wallet, tx_signature FROM payment_requests WHERE id = ?').bind(pr.id).first();
      return Response.json({
        status: 'confirmed',
        agent_id: pr.agent_id,
        amount: updated.amount,
        buyer_wallet: updated.buyer_wallet,
        tx_signature: updated.tx_signature,
        agent_wallet: agent?.agent_wallet || null,
      });
    }

    // Check if token is missing for detailed status
    if (pr.spawn_cost && pr.spawn_cost > 0) {
      try {
        const { getTokenBalances } = await import('../_lib/solana.js');
        const SPAWN_MINT = context.env.SPAWN_MINT || '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump';
        const protocolWallet = context.env.PROTOCOL_WALLET;
        const tokens = await getTokenBalances(protocolWallet, rpcUrl);
        const spawnBal = tokens.find(t => t.mint === SPAWN_MINT)?.amount || 0;
        const hasToken = spawnBal >= pr.spawn_cost;
        return Response.json({ status: 'pending', message: 'Payment not found on-chain yet', checks: { token: hasToken, sol: false } });
      } catch {}
    }
    return Response.json({ status: 'pending', message: 'Payment not found on-chain yet' });
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// Verify a transaction and confirm the payment + claim agent
async function verifyAndConfirm(context, db, rpcUrl, pr, txSignature) {
  const tx = await rpcCall(rpcUrl, 'getTransaction', [txSignature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (!tx?.meta) return false;

  const accounts = tx.transaction.message.accountKeys;

  // Verify SOL received by recipient
  let recipientIdx = -1;
  for (let i = 0; i < accounts.length; i++) {
    const pk = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].pubkey;
    if (pk === pr.recipient) { recipientIdx = i; break; }
  }
  if (recipientIdx < 0) return false;

  const solReceived = (tx.meta.postBalances[recipientIdx] - tx.meta.preBalances[recipientIdx]) / 1e9;
  if (solReceived < pr.amount * 0.95) return false;

  // Check $SPAWN token balance if required
  if (pr.spawn_cost && pr.spawn_cost > 0) {
    const { getTokenBalances } = await import('../_lib/solana.js');
    const SPAWN_MINT = context.env.SPAWN_MINT || '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump';
    const protocolWallet = context.env.PROTOCOL_WALLET;
    const tokens = await getTokenBalances(protocolWallet, rpcUrl);
    const spawnBal = tokens.find(t => t.mint === SPAWN_MINT)?.amount || 0;
    if (spawnBal < pr.spawn_cost) return false; // wait for token
  }

  const buyer = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;

  // Update payment
  await db.prepare(
    "UPDATE payment_requests SET status = 'confirmed', buyer_wallet = ?, tx_signature = ?, confirmed_at = datetime('now') WHERE id = ?"
  ).bind(buyer, txSignature, pr.id).run();

  // Claim agent (same logic as verify-payments.js)
  const { generateKeypair, sendSol } = await import('../_lib/solana.js');

  const GENESIS_DNA = {
    "the-berserker": { degen: true, aggression: 0.95, patience: 0.05, risk_tolerance: 0.95, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 100, sell_loss_pct: 15, max_position_pct: 80, check_interval_min: 2 },
    "the-monk": { degen: true, aggression: 0.88, patience: 0.2, risk_tolerance: 0.9, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 200, sell_loss_pct: 12, max_position_pct: 60, check_interval_min: 3 },
    "the-gambler": { degen: true, aggression: 0.92, patience: 0.1, risk_tolerance: 0.99, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 250, sell_loss_pct: 50, max_position_pct: 85, check_interval_min: 2 },
    "the-turtle": { degen: true, aggression: 0.85, patience: 0.25, risk_tolerance: 0.88, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 150, sell_loss_pct: 10, max_position_pct: 50, check_interval_min: 3 },
    "the-beast": { degen: true, aggression: 0.98, patience: 0.05, risk_tolerance: 0.98, buy_threshold_holders: 50, buy_threshold_volume: 20000, sell_profit_pct: 120, sell_loss_pct: 30, max_position_pct: 85, check_interval_min: 2 },
    "the-wolf": { aggression: 0.75, patience: 0.35, risk_tolerance: 0.7, buy_threshold_holders: 300, buy_threshold_volume: 800, sell_profit_pct: 40, sell_loss_pct: 15, max_position_pct: 60, check_interval_min: 3 },
    "the-jackal": { aggression: 0.7, patience: 0.3, risk_tolerance: 0.65, buy_threshold_holders: 250, buy_threshold_volume: 600, sell_profit_pct: 30, sell_loss_pct: 18, max_position_pct: 55, check_interval_min: 4 },
    "the-viper": { aggression: 0.8, patience: 0.25, risk_tolerance: 0.75, buy_threshold_holders: 200, buy_threshold_volume: 500, sell_profit_pct: 22, sell_loss_pct: 20, max_position_pct: 65, check_interval_min: 3 },
    "the-sniper": { aggression: 0.3, patience: 0.85, risk_tolerance: 0.4, buy_threshold_holders: 1500, buy_threshold_volume: 5000, sell_profit_pct: 50, sell_loss_pct: 8, max_position_pct: 35, check_interval_min: 10 },
    "the-surgeon": { aggression: 0.45, patience: 0.7, risk_tolerance: 0.3, buy_threshold_holders: 1000, buy_threshold_volume: 3000, sell_profit_pct: 25, sell_loss_pct: 6, max_position_pct: 30, check_interval_min: 5 },
    "the-oracle": { aggression: 0.25, patience: 0.88, risk_tolerance: 0.25, buy_threshold_holders: 2500, buy_threshold_volume: 8000, sell_profit_pct: 70, sell_loss_pct: 5, max_position_pct: 20, check_interval_min: 12 },
    "the-hawk": { aggression: 0.6, patience: 0.5, risk_tolerance: 0.5, buy_threshold_holders: 500, buy_threshold_volume: 2000, sell_profit_pct: 35, sell_loss_pct: 10, max_position_pct: 45, check_interval_min: 5 },
    "the-phantom": { aggression: 0.4, patience: 0.75, risk_tolerance: 0.35, buy_threshold_holders: 1200, buy_threshold_volume: 4000, sell_profit_pct: 45, sell_loss_pct: 7, max_position_pct: 25, check_interval_min: 8 },
    "the-specter": { aggression: 0.35, patience: 0.8, risk_tolerance: 0.3, buy_threshold_holders: 1800, buy_threshold_volume: 6000, sell_profit_pct: 55, sell_loss_pct: 6, max_position_pct: 22, check_interval_min: 10 },
    "the-colossus": { aggression: 0.5, patience: 0.6, risk_tolerance: 0.5, buy_threshold_holders: 800, buy_threshold_volume: 2500, sell_profit_pct: 40, sell_loss_pct: 10, max_position_pct: 40, check_interval_min: 6 },
  };

  const existingAgent = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(pr.agent_id).first();
  if (existingAgent && existingAgent.status !== 'dead' && existingAgent.status !== 'unclaimed') return true; // already claimed
  const reclaimExisting = existingAgent && (existingAgent.status === 'dead' || existingAgent.status === 'unclaimed');

  const dna = GENESIS_DNA[pr.agent_id];
  if (!dna) return true;

  const keypair = await generateKeypair();
  const kv = context.env.AGENT_KEYS;
  if (kv) await kv.put(`agent:${pr.agent_id}:secret`, keypair.secretKey);

  const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.05');
  const tradingCapital = pr.amount * (1 - feePct);
  const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;

  if (!protocolSecret) {
    await db.prepare("UPDATE payment_requests SET status = 'funding_failed' WHERE id = ?").bind(pr.id).run();
    return false;
  }

  try {
    const fundingTx = await sendSol(protocolSecret, keypair.publicKey, tradingCapital, rpcUrl);
    if (reclaimExisting) {
      await db.prepare(
        "UPDATE agents SET owner_wallet = ?, agent_wallet = ?, dna = ?, status = 'alive', initial_capital = ?, total_pnl = 0, total_trades = 0, total_royalties_paid = 0 WHERE id = ?"
      ).bind(buyer, keypair.publicKey, JSON.stringify(dna), tradingCapital, pr.agent_id).run();
    } else {
      await db.prepare(
        "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital) VALUES (?, NULL, 0, ?, ?, ?, 'alive', ?)"
      ).bind(pr.agent_id, buyer, keypair.publicKey, JSON.stringify(dna), tradingCapital).run();
    }
    await db.prepare(
      "INSERT INTO events (agent_id, type, data) VALUES (?, 'genesis_claimed', ?)"
    ).bind(pr.agent_id, JSON.stringify({
      buyer, amount: pr.amount, tx: txSignature,
      agent_wallet: keypair.publicKey, trading_capital: tradingCapital,
      funding_tx: fundingTx,
    })).run();
    return true;
  } catch (e) {
    await db.prepare(
      "UPDATE payment_requests SET status = 'funding_failed', buyer_wallet = ?, tx_signature = ? WHERE id = ?"
    ).bind(buyer, txSignature, pr.id).run();
    if (kv) await kv.put(`funding:${pr.id}:pubkey`, keypair.publicKey);
    console.error('Funding failed:', e.message);
    return false;
  }
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
