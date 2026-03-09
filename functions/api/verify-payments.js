import { decode } from '../_lib/base58.js';
import { generateKeypair, sendSol, getTokenBalances, verifyTokenTransfer } from '../_lib/solana.js';

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

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  // Auth check
  const cronSecret = context.request.headers.get('X-Cron-Secret');
  if (cronSecret !== context.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;

  if (!rpcUrl) {
    return Response.json({ error: 'RPC_URL not configured' }, { status: 500 });
  }

  // Re-activate expired payment requests for any unclaimed/dead agents (can still be purchased)
  // Only re-activate the LATEST expired request per agent (not all of them)
  const allGenesis = Object.keys(GENESIS_DNA);
  for (const agentId of allGenesis) {
    const existing = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(agentId).first();
    if (!existing || existing.status === 'dead' || existing.status === 'unclaimed') {
      const latestExpired = await db.prepare(
        "SELECT id FROM payment_requests WHERE agent_id = ? AND status = 'expired' ORDER BY created_at DESC LIMIT 1"
      ).bind(agentId).first();
      if (latestExpired) {
        await db.prepare(
          "UPDATE payment_requests SET status = 'pending' WHERE id = ?"
        ).bind(latestExpired.id).run();
      }
    }
  }

  // Expire old pending payments (>30 min) — but not for unclaimed/dead agents
  const aliveAgents = await db.prepare(
    "SELECT id FROM agents WHERE status = 'alive'"
  ).all();
  const aliveIds = new Set(aliveAgents.results.map(a => a.id));

  const pendingToExpire = await db.prepare(
    "SELECT id, agent_id FROM payment_requests WHERE status = 'pending' AND created_at < datetime('now', '-30 minutes')"
  ).all();

  for (const pr of pendingToExpire.results) {
    // Only expire if agent is alive (already claimed) — keep pending for unclaimed/dead/new
    if (aliveIds.has(pr.agent_id)) {
      await db.prepare("UPDATE payment_requests SET status = 'expired' WHERE id = ?").bind(pr.id).run();
    }
  }

  // Get active pending payments
  const pending = await db.prepare(
    "SELECT id, agent_id, amount, reference, recipient, spawn_cost FROM payment_requests WHERE status = 'pending'"
  ).all();

  let confirmed = 0;
  let errors = 0;

  for (const pr of pending.results) {
    try {
      // Convert base58 reference to check for signatures
      const sigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [pr.reference, { limit: 1 }]);

      if (!sigs || sigs.length === 0) continue;

      const sig = sigs[0];
      if (sig.err) continue; // Failed transaction

      // Get transaction details to verify amount
      const tx = await rpcCall(rpcUrl, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);

      if (!tx || !tx.meta) continue;

      // Find SOL transfer to recipient
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;
      const accounts = tx.transaction.message.accountKeys;

      let recipientIdx = -1;
      for (let i = 0; i < accounts.length; i++) {
        const pubkey = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].pubkey;
        if (pubkey === pr.recipient) {
          recipientIdx = i;
          break;
        }
      }

      if (recipientIdx < 0) continue;

      const lamportsReceived = postBalances[recipientIdx] - preBalances[recipientIdx];
      const solReceived = lamportsReceived / 1_000_000_000;

      // Allow 5% tolerance (users may round or send slightly different amount)
      if (solReceived < pr.amount * 0.95) continue;

      // Find buyer wallet (first signer)
      const buyer = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;

      // Verify $SPAWN token transfer if required
      if (pr.spawn_cost && pr.spawn_cost > 0) {
        const SPAWN_MINT = context.env.SPAWN_MINT || '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump';
        const tokenResult = await verifyTokenTransfer(buyer, context.env.PROTOCOL_WALLET, SPAWN_MINT, pr.spawn_cost, rpcUrl);
        if (!tokenResult.verified) continue; // wait for token transfer
      }

      // Update payment request
      await db.prepare(
        "UPDATE payment_requests SET status = 'confirmed', buyer_wallet = ?, tx_signature = ?, confirmed_at = datetime('now') WHERE id = ?"
      ).bind(buyer, sig.signature, pr.id).run();

      // Check if agent already claimed (race condition guard)
      const existingAgent = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(pr.agent_id).first();
      if (existingAgent && existingAgent.status !== 'dead' && existingAgent.status !== 'unclaimed') continue;

      // If agent was dead/unclaimed, we'll UPDATE instead of INSERT below
      const reclaimExisting = existingAgent && (existingAgent.status === 'dead' || existingAgent.status === 'unclaimed');

      // Claim agent — genesis DNA or custom DNA from KV
      const kv = context.env.AGENT_KEYS;
      let dna = GENESIS_DNA[pr.agent_id];
      let agentName = null;
      let customOwner = null;
      const isCustom = !dna && kv;

      let agentMeta = null;
      if (isCustom) {
        // Custom agent — DNA stored in KV by create-custom endpoint
        const customDnaStr = await kv.get(`custom:${pr.agent_id}:dna`);
        if (!customDnaStr) continue; // no custom DNA found, skip
        dna = JSON.parse(customDnaStr);
        agentName = await kv.get(`custom:${pr.agent_id}:name`);
        customOwner = await kv.get(`custom:${pr.agent_id}:owner`);
        agentMeta = await kv.get(`custom:${pr.agent_id}:meta`);
      }

      if (!dna) continue;

      // Generate dedicated trading wallet for the agent
      const keypair = await generateKeypair();

      // Save secret key in KV
      if (kv) {
        await kv.put(`agent:${pr.agent_id}:secret`, keypair.secretKey);
      }

      // Send 95% of purchase price to agent wallet as trading capital
      const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.05');
      const tradingCapital = pr.amount * (1 - feePct);

      const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;
      if (!protocolSecret) {
        await db.prepare("UPDATE payment_requests SET status = 'funding_failed' WHERE id = ?").bind(pr.id).run();
        console.error(`No PROTOCOL_PRIVATE_KEY for ${pr.agent_id}`);
        continue;
      }

      let fundingTx;
      try {
        fundingTx = await sendSol(protocolSecret, keypair.publicKey, tradingCapital, rpcUrl);
        console.log(`Funded ${pr.agent_id} with ${tradingCapital} SOL, tx: ${fundingTx}`);
      } catch (e) {
        // Funding failed — do NOT create agent, mark for retry
        await db.prepare(
          "UPDATE payment_requests SET status = 'funding_failed', buyer_wallet = ?, tx_signature = ? WHERE id = ?"
        ).bind(buyer, sig.signature, pr.id).run();
        // Save wallet info so retry can use same keypair
        if (kv) await kv.put(`funding:${pr.id}:pubkey`, keypair.publicKey);
        console.error(`Failed to fund ${pr.agent_id}, will retry:`, e.message);
        errors++;
        continue;
      }

      // Use custom owner if it's a real wallet, otherwise fall back to on-chain sender
      const ownerWallet = (customOwner && customOwner !== 'manual') ? customOwner : buyer;

      // Funding succeeded — create or reclaim agent
      if (reclaimExisting) {
        await db.prepare(
          "UPDATE agents SET owner_wallet = ?, agent_wallet = ?, dna = ?, status = 'alive', initial_capital = ?, total_pnl = 0, total_trades = 0, name = COALESCE(?, name), meta = ? WHERE id = ?"
        ).bind(ownerWallet, keypair.publicKey, JSON.stringify(dna), tradingCapital, agentName, agentMeta, pr.agent_id).run();
      } else {
        await db.prepare(
          "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital, name, meta) VALUES (?, NULL, 0, ?, ?, ?, 'alive', ?, ?, ?)"
        ).bind(pr.agent_id, ownerWallet, keypair.publicKey, JSON.stringify(dna), tradingCapital, agentName, agentMeta).run();
      }

      // Clean up custom KV keys
      if (isCustom && kv) {
        await kv.delete(`custom:${pr.agent_id}:dna`);
        await kv.delete(`custom:${pr.agent_id}:name`);
        await kv.delete(`custom:${pr.agent_id}:owner`);
        await kv.delete(`custom:${pr.agent_id}:meta`);
      }

      // Log event
      const eventType = isCustom ? 'custom_agent_created' : 'genesis_claimed';
      await db.prepare(
        "INSERT INTO events (agent_id, type, data) VALUES (?, ?, ?)"
      ).bind(pr.agent_id, eventType, JSON.stringify({
        buyer: ownerWallet, amount: pr.amount, tx: sig.signature,
        agent_wallet: keypair.publicKey,
        trading_capital: tradingCapital,
        funding_tx: fundingTx,
        ...(agentName ? { name: agentName } : {}),
      })).run();

      confirmed++;
    } catch (e) {
      console.error(`Error verifying payment ${pr.id}:`, e);
      errors++;
    }
  }

  // === FALLBACK: AMOUNT-MATCHING FOR MANUAL PAYMENTS ===
  // If reference-based search missed manual payments, try matching by unique amount
  const stillPending = await db.prepare(
    "SELECT id, agent_id, amount, recipient, spawn_cost FROM payment_requests WHERE status = 'pending'"
  ).all();

  if (stillPending.results.length > 0) {
    try {
      const protocolAddr = context.env.PROTOCOL_WALLET;
      const recentSigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [protocolAddr, { limit: 30 }]);
      const amountMatched = new Set();

      // Get already-used tx signatures to prevent double-matching
      const usedTxs = await db.prepare(
        "SELECT tx_signature FROM payment_requests WHERE tx_signature IS NOT NULL"
      ).all();
      const usedSigs = new Set(usedTxs.results.map(r => r.tx_signature));

      // Also exclude tx signatures used by spawn events and claim events
      const excludeEvents = await db.prepare(
        "SELECT data FROM events WHERE type IN ('spawn', 'genesis_claimed', 'custom_agent_created') AND created_at > datetime('now', '-24 hours')"
      ).all();
      for (const se of excludeEvents.results) {
        try {
          const d = JSON.parse(se.data);
          if (d.sol_tx) usedSigs.add(d.sol_tx);
          if (d.tx) usedSigs.add(d.tx);
        } catch {}
      }

      if (recentSigs?.length > 0) {
        for (const sig of recentSigs) {
          if (sig.err || amountMatched.size >= stillPending.results.length) break;
          if (usedSigs.has(sig.signature)) continue; // skip already-matched txs

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

          // Skip micro amounts (login range) — only match agent purchases (≥0.3 SOL)
          if (solReceived < 0.3) continue;

          for (const pr of stillPending.results) {
            if (amountMatched.has(pr.id)) continue;

            // Skip payment requests for agents that are already alive with a confirmed payment
            const agentCheck = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(pr.agent_id).first();
            if (agentCheck && agentCheck.status === 'alive') {
              amountMatched.add(pr.id);
              continue;
            }

            // Match within 5% tolerance (users may round amounts)
            if (Math.abs(solReceived - pr.amount) <= pr.amount * 0.05) {
              const buyer = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;

              // Verify $SPAWN token transfer if required
              if (pr.spawn_cost && pr.spawn_cost > 0) {
                const SPAWN_MINT = context.env.SPAWN_MINT || '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump';
                const tokenResult = await verifyTokenTransfer(buyer, protocolAddr, SPAWN_MINT, pr.spawn_cost, rpcUrl);
                if (!tokenResult.verified) continue; // wait for token transfer
              }

              // Update payment request
              await db.prepare(
                "UPDATE payment_requests SET status = 'confirmed', buyer_wallet = ?, tx_signature = ?, confirmed_at = datetime('now') WHERE id = ?"
              ).bind(buyer, sig.signature, pr.id).run();

              // Check if agent already claimed
              const existingAgent = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(pr.agent_id).first();
              if (existingAgent && existingAgent.status !== 'dead' && existingAgent.status !== 'unclaimed') {
                amountMatched.add(pr.id);
                continue;
              }
              const reclaimExisting2 = existingAgent && (existingAgent.status === 'dead' || existingAgent.status === 'unclaimed');

              const kv = context.env.AGENT_KEYS;
              let dna = GENESIS_DNA[pr.agent_id];
              let agentName = null;
              let agentMeta = null;
              let customOwner = null;
              const isCustom = !dna && kv;

              if (isCustom) {
                const customDnaStr = await kv.get(`custom:${pr.agent_id}:dna`);
                if (!customDnaStr) { amountMatched.add(pr.id); continue; }
                dna = JSON.parse(customDnaStr);
                agentName = await kv.get(`custom:${pr.agent_id}:name`);
                agentMeta = await kv.get(`custom:${pr.agent_id}:meta`);
                customOwner = await kv.get(`custom:${pr.agent_id}:owner`);
              }
              if (!dna) { amountMatched.add(pr.id); continue; }

              const ownerWallet = (customOwner && customOwner !== 'manual') ? customOwner : buyer;

              const keypair = await generateKeypair();
              if (kv) await kv.put(`agent:${pr.agent_id}:secret`, keypair.secretKey);

              const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.05');
              const tradingCapital = pr.amount * (1 - feePct);
              const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;

              if (protocolSecret) {
                try {
                  const fundingTx = await sendSol(protocolSecret, keypair.publicKey, tradingCapital, rpcUrl);
                  if (reclaimExisting2) {
                    await db.prepare(
                      "UPDATE agents SET owner_wallet = ?, agent_wallet = ?, dna = ?, status = 'alive', initial_capital = ?, total_pnl = 0, total_trades = 0, name = COALESCE(?, name), meta = ? WHERE id = ?"
                    ).bind(ownerWallet, keypair.publicKey, JSON.stringify(dna), tradingCapital, agentName, agentMeta, pr.agent_id).run();
                  } else {
                    await db.prepare(
                      "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital, name, meta) VALUES (?, NULL, 0, ?, ?, ?, 'alive', ?, ?, ?)"
                    ).bind(pr.agent_id, ownerWallet, keypair.publicKey, JSON.stringify(dna), tradingCapital, agentName, agentMeta).run();
                  }
                  if (isCustom && kv) {
                    await kv.delete(`custom:${pr.agent_id}:dna`);
                    await kv.delete(`custom:${pr.agent_id}:name`);
                    await kv.delete(`custom:${pr.agent_id}:owner`);
                    await kv.delete(`custom:${pr.agent_id}:meta`);
                  }
                  const eventType = isCustom ? 'custom_agent_created' : 'genesis_claimed';
                  await db.prepare(
                    "INSERT INTO events (agent_id, type, data) VALUES (?, ?, ?)"
                  ).bind(pr.agent_id, eventType, JSON.stringify({
                    buyer: ownerWallet, amount: pr.amount, tx: sig.signature,
                    agent_wallet: keypair.publicKey, trading_capital: tradingCapital,
                    funding_tx: fundingTx, matched_by: 'amount',
                    ...(agentName ? { name: agentName } : {}),
                  })).run();
                  confirmed++;
                  console.log(`Amount-matched ${pr.agent_id} from ${ownerWallet}, funded ${tradingCapital} SOL`);
                } catch (e) {
                  await db.prepare(
                    "UPDATE payment_requests SET status = 'funding_failed', buyer_wallet = ?, tx_signature = ? WHERE id = ?"
                  ).bind(buyer, sig.signature, pr.id).run();
                  if (kv) await kv.put(`funding:${pr.id}:pubkey`, keypair.publicKey);
                  console.error(`Amount-match funding failed for ${pr.agent_id}:`, e.message);
                  errors++;
                }
              }

              amountMatched.add(pr.id);
              usedSigs.add(sig.signature); // prevent this tx from matching another agent
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error('Error in amount-matching fallback:', e);
    }
  }

  // === RETRY FAILED FUNDING ===
  let retried = 0;
  const failedFunding = await db.prepare(
    "SELECT id, agent_id, amount, buyer_wallet, tx_signature FROM payment_requests WHERE status = 'funding_failed' AND created_at > datetime('now', '-24 hours')"
  ).all();

  for (const pf of failedFunding.results) {
    try {
      const dna = GENESIS_DNA[pf.agent_id];
      if (!dna) continue;

      const kv = context.env.AGENT_KEYS;
      const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;
      if (!protocolSecret || !kv) continue;

      // Check if agent already exists and is alive (another retry might have succeeded)
      const existing = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(pf.agent_id).first();
      if (existing && existing.status !== 'dead' && existing.status !== 'unclaimed') {
        await db.prepare("UPDATE payment_requests SET status = 'confirmed' WHERE id = ?").bind(pf.id).run();
        continue;
      }
      const reclaimRetry = existing && (existing.status === 'dead' || existing.status === 'unclaimed');

      // Get the saved keypair or generate new one
      let agentPubkey = await kv.get(`funding:${pf.id}:pubkey`);
      if (!agentPubkey) {
        // No saved pubkey — keypair might be lost, generate new
        const keypair = await generateKeypair();
        await kv.put(`agent:${pf.agent_id}:secret`, keypair.secretKey);
        agentPubkey = keypair.publicKey;
      }

      const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.05');
      const tradingCapital = pf.amount * (1 - feePct);

      const fundingTx = await sendSol(protocolSecret, agentPubkey, tradingCapital, rpcUrl);
      console.log(`Retry funded ${pf.agent_id} with ${tradingCapital} SOL, tx: ${fundingTx}`);

      // Create or reclaim agent now that funding succeeded
      if (reclaimRetry) {
        await db.prepare(
          "UPDATE agents SET owner_wallet = ?, agent_wallet = ?, dna = ?, status = 'alive', initial_capital = ?, total_pnl = 0, total_trades = 0, total_royalties_paid = 0 WHERE id = ?"
        ).bind(pf.buyer_wallet, agentPubkey, JSON.stringify(dna), tradingCapital, pf.agent_id).run();
      } else {
        await db.prepare(
          "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital) VALUES (?, NULL, 0, ?, ?, ?, 'alive', ?)"
        ).bind(pf.agent_id, pf.buyer_wallet, agentPubkey, JSON.stringify(dna), tradingCapital).run();
      }

      await db.prepare("UPDATE payment_requests SET status = 'confirmed' WHERE id = ?").bind(pf.id).run();

      // Clean up temp KV key
      await kv.delete(`funding:${pf.id}:pubkey`);

      await db.prepare(
        "INSERT INTO events (agent_id, type, data) VALUES (?, 'genesis_claimed', ?)"
      ).bind(pf.agent_id, JSON.stringify({
        buyer: pf.buyer_wallet, amount: pf.amount, tx: pf.tx_signature,
        agent_wallet: agentPubkey, trading_capital: tradingCapital, funding_tx: fundingTx,
        retried: true,
      })).run();

      retried++;
    } catch (e) {
      console.error(`Retry funding failed for ${pf.agent_id}:`, e.message);
    }
  }

  // === VERIFY PENDING WITHDRAWALS (micro_tx) ===
  let wConfirmed = 0;
  let wErrors = 0;

  // Expire old pending withdrawals (>30 min)
  await db.prepare(
    "UPDATE withdrawal_requests SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-30 minutes')"
  ).run();

  const pendingWithdrawals = await db.prepare(
    "SELECT id, agent_id, owner_wallet, amount_sol, micro_amount, reference FROM withdrawal_requests WHERE status = 'pending' AND method = 'micro_tx'"
  ).all();

  for (const wr of pendingWithdrawals.results) {
    try {
      const sigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [wr.reference, { limit: 1 }]);
      if (!sigs || sigs.length === 0) continue;

      const sig = sigs[0];
      if (sig.err) continue;

      const tx = await rpcCall(rpcUrl, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!tx || !tx.meta) continue;

      // Verify sender is owner_wallet (first signer)
      const accounts = tx.transaction.message.accountKeys;
      const sender = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;

      if (sender !== wr.owner_wallet) {
        await db.prepare("UPDATE withdrawal_requests SET status = 'expired' WHERE id = ?").bind(wr.id).run();
        continue;
      }

      // Verify micro amount was sent to PROTOCOL_WALLET
      const protocolWallet = context.env.PROTOCOL_WALLET;
      let recipientIdx = -1;
      for (let i = 0; i < accounts.length; i++) {
        const pubkey = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].pubkey;
        if (pubkey === protocolWallet) { recipientIdx = i; break; }
      }

      if (recipientIdx < 0) continue;

      const lamportsReceived = tx.meta.postBalances[recipientIdx] - tx.meta.preBalances[recipientIdx];
      const solReceived = lamportsReceived / 1e9;

      // Verify micro amount matches (0.5% tolerance)
      if (Math.abs(solReceived - wr.micro_amount) > wr.micro_amount * 0.05) continue;

      // Verified — execute withdrawal from agent wallet
      const kv = context.env.AGENT_KEYS;
      const agentSecret = await kv.get(`agent:${wr.agent_id}:secret`);
      if (!agentSecret) {
        console.error(`No secret key for agent ${wr.agent_id}`);
        continue;
      }

      const withdrawTx = await sendSol(agentSecret, wr.owner_wallet, wr.amount_sol, rpcUrl);

      await db.batch([
        db.prepare("UPDATE withdrawal_requests SET status = 'completed', tx_signature = ? WHERE id = ?").bind(withdrawTx, wr.id),
        db.prepare("UPDATE agents SET total_withdrawn = total_withdrawn + ? WHERE id = ?").bind(wr.amount_sol, wr.agent_id),
        db.prepare("INSERT INTO events (agent_id, type, data) VALUES (?, 'withdrawal', ?)").bind(wr.agent_id, JSON.stringify({
          amount: wr.amount_sol,
          method: 'micro_tx',
          owner: wr.owner_wallet,
          tx: withdrawTx,
        })),
      ]);

      console.log(`Withdrawal ${wr.id}: sent ${wr.amount_sol} SOL to ${wr.owner_wallet}, tx: ${withdrawTx}`);
      wConfirmed++;
    } catch (e) {
      console.error(`Error verifying withdrawal ${wr.id}:`, e);
      wErrors++;
    }
  }

  // === VERIFY PENDING LOGIN REQUESTS (micro_tx amount-matching) ===
  let loginVerified = 0;

  await db.prepare(
    "UPDATE login_requests SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')"
  ).run();

  const pendingLogins = await db.prepare(
    "SELECT id, micro_amount FROM login_requests WHERE status = 'pending'"
  ).all();

  const protocolWallet = context.env.PROTOCOL_WALLET;

  if (pendingLogins.results.length > 0 && protocolWallet) {
    try {
      // Get recent transactions TO protocol wallet
      const recentSigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [protocolWallet, { limit: 10 }]);
      const matched = new Set();

      if (recentSigs?.length > 0) {
        for (const sig of recentSigs) {
          if (sig.err || matched.size >= pendingLogins.results.length) break;

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

          // Only consider micro amounts (login range: 0.001–0.002 SOL)
          if (solReceived < 0.0005 || solReceived > 0.003) continue;

          // Match against pending login requests by amount
          for (const lr of pendingLogins.results) {
            if (matched.has(lr.id)) continue;
            if (Math.abs(solReceived - lr.micro_amount) <= lr.micro_amount * 0.05) {
              const sender = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;
              await db.prepare(
                "UPDATE login_requests SET status = 'verified', verified_wallet = ? WHERE id = ?"
              ).bind(sender, lr.id).run();
              matched.add(lr.id);
              loginVerified++;
              console.log(`Login verified for wallet ${sender}, request ${lr.id}`);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error('Error verifying logins:', e);
    }
  }

  return Response.json({
    pending: pending.results.length,
    confirmed,
    errors,
    retried,
    withdrawals: { pending: pendingWithdrawals.results.length, confirmed: wConfirmed, errors: wErrors },
    logins: { pending: pendingLogins.results.length, verified: loginVerified },
  });
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
