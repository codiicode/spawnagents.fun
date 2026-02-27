import { decode } from '../_lib/base58.js';
import { generateKeypair, sendSol } from '../_lib/solana.js';

const GENESIS_DNA = {
  "the-wolf": { aggression: 0.75, patience: 0.35, risk_tolerance: 0.7, focus: "memecoin", buy_threshold_holders: 300, buy_threshold_volume: 800, sell_profit_pct: 40, sell_loss_pct: 15, max_position_pct: 60, check_interval_min: 3 },
  "the-jackal": { aggression: 0.7, patience: 0.3, risk_tolerance: 0.65, focus: "memecoin", buy_threshold_holders: 250, buy_threshold_volume: 600, sell_profit_pct: 30, sell_loss_pct: 18, max_position_pct: 55, check_interval_min: 4 },
  "the-viper": { aggression: 0.8, patience: 0.25, risk_tolerance: 0.75, focus: "memecoin", buy_threshold_holders: 200, buy_threshold_volume: 500, sell_profit_pct: 22, sell_loss_pct: 20, max_position_pct: 65, check_interval_min: 3 },
  "the-sniper": { aggression: 0.3, patience: 0.85, risk_tolerance: 0.4, focus: "memecoin", buy_threshold_holders: 1500, buy_threshold_volume: 5000, sell_profit_pct: 50, sell_loss_pct: 8, max_position_pct: 35, check_interval_min: 10 },
  "the-surgeon": { aggression: 0.45, patience: 0.7, risk_tolerance: 0.3, focus: "memecoin", buy_threshold_holders: 1000, buy_threshold_volume: 3000, sell_profit_pct: 25, sell_loss_pct: 6, max_position_pct: 30, check_interval_min: 5 },
  "the-oracle": { aggression: 0.25, patience: 0.88, risk_tolerance: 0.25, focus: "memecoin", buy_threshold_holders: 2500, buy_threshold_volume: 8000, sell_profit_pct: 70, sell_loss_pct: 5, max_position_pct: 20, check_interval_min: 12 },
  "the-hawk": { aggression: 0.6, patience: 0.5, risk_tolerance: 0.5, focus: "memecoin", buy_threshold_holders: 500, buy_threshold_volume: 2000, sell_profit_pct: 35, sell_loss_pct: 10, max_position_pct: 45, check_interval_min: 5 },
  "the-phantom": { aggression: 0.4, patience: 0.75, risk_tolerance: 0.35, focus: "memecoin", buy_threshold_holders: 1200, buy_threshold_volume: 4000, sell_profit_pct: 45, sell_loss_pct: 7, max_position_pct: 25, check_interval_min: 8 },
  "the-specter": { aggression: 0.35, patience: 0.8, risk_tolerance: 0.3, focus: "memecoin", buy_threshold_holders: 1800, buy_threshold_volume: 6000, sell_profit_pct: 55, sell_loss_pct: 6, max_position_pct: 22, check_interval_min: 10 },
  "the-colossus": { aggression: 0.5, patience: 0.6, risk_tolerance: 0.5, focus: "memecoin", buy_threshold_holders: 800, buy_threshold_volume: 2500, sell_profit_pct: 40, sell_loss_pct: 10, max_position_pct: 40, check_interval_min: 6 },
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

  // Expire old pending payments (>30 min)
  await db.prepare(
    "UPDATE payment_requests SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-30 minutes')"
  ).run();

  // Get active pending payments
  const pending = await db.prepare(
    "SELECT id, agent_id, amount, reference, recipient FROM payment_requests WHERE status = 'pending'"
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

      // Allow 0.5% tolerance for fees
      if (solReceived < pr.amount * 0.995) continue;

      // Find buyer wallet (first signer)
      const buyer = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;

      // Update payment request
      await db.prepare(
        "UPDATE payment_requests SET status = 'confirmed', buyer_wallet = ?, tx_signature = ?, confirmed_at = datetime('now') WHERE id = ?"
      ).bind(buyer, sig.signature, pr.id).run();

      // Check if agent already claimed (race condition guard)
      const existingAgent = await db.prepare('SELECT id, status FROM agents WHERE id = ?').bind(pr.agent_id).first();
      if (existingAgent && existingAgent.status !== 'dead') continue;

      // If agent was dead, remove old record so it can be re-claimed
      if (existingAgent && existingAgent.status === 'dead') {
        await db.prepare('DELETE FROM agents WHERE id = ? AND status = ?').bind(pr.agent_id, 'dead').run();
      }

      // Claim agent
      const dna = GENESIS_DNA[pr.agent_id];
      if (!dna) continue;

      // Generate dedicated trading wallet for the agent
      const keypair = await generateKeypair();

      // Save secret key in KV
      const kv = context.env.AGENT_KEYS;
      if (kv) {
        await kv.put(`agent:${pr.agent_id}:secret`, keypair.secretKey);
      }

      // Send 85% of purchase price to agent wallet as trading capital
      const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.15');
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
        await kv.put(`funding:${pr.id}:pubkey`, keypair.publicKey);
        console.error(`Failed to fund ${pr.agent_id}, will retry:`, e.message);
        errors++;
        continue;
      }

      // Funding succeeded — create agent
      await db.prepare(
        "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital) VALUES (?, NULL, 0, ?, ?, ?, 'alive', ?)"
      ).bind(pr.agent_id, buyer, keypair.publicKey, JSON.stringify(dna), tradingCapital).run();

      // Log event
      await db.prepare(
        "INSERT INTO events (agent_id, type, data) VALUES (?, 'genesis_claimed', ?)"
      ).bind(pr.agent_id, JSON.stringify({
        buyer, amount: pr.amount, tx: sig.signature,
        agent_wallet: keypair.publicKey,
        trading_capital: tradingCapital,
        funding_tx: fundingTx,
      })).run();

      confirmed++;
    } catch (e) {
      console.error(`Error verifying payment ${pr.id}:`, e);
      errors++;
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

      // Check if agent already exists (another retry might have succeeded)
      const existing = await db.prepare('SELECT id FROM agents WHERE id = ?').bind(pf.agent_id).first();
      if (existing) {
        await db.prepare("UPDATE payment_requests SET status = 'confirmed' WHERE id = ?").bind(pf.id).run();
        continue;
      }

      // Get the saved keypair or generate new one
      let agentPubkey = await kv.get(`funding:${pf.id}:pubkey`);
      if (!agentPubkey) {
        // No saved pubkey — keypair might be lost, generate new
        const keypair = await generateKeypair();
        await kv.put(`agent:${pf.agent_id}:secret`, keypair.secretKey);
        agentPubkey = keypair.publicKey;
      }

      const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.15');
      const tradingCapital = pf.amount * (1 - feePct);

      const fundingTx = await sendSol(protocolSecret, agentPubkey, tradingCapital, rpcUrl);
      console.log(`Retry funded ${pf.agent_id} with ${tradingCapital} SOL, tx: ${fundingTx}`);

      // Create agent now that funding succeeded
      await db.prepare(
        "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital) VALUES (?, NULL, 0, ?, ?, ?, 'alive', ?)"
      ).bind(pf.agent_id, pf.buyer_wallet, agentPubkey, JSON.stringify(dna), tradingCapital).run();

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

      await db.prepare(
        "UPDATE withdrawal_requests SET status = 'completed', tx_signature = ? WHERE id = ?"
      ).bind(withdrawTx, wr.id).run();

      // Log event
      await db.prepare(
        "INSERT INTO events (agent_id, type, data) VALUES (?, 'withdrawal', ?)"
      ).bind(wr.agent_id, JSON.stringify({
        amount: wr.amount_sol,
        method: 'micro_tx',
        owner: wr.owner_wallet,
        tx: withdrawTx,
      })).run();

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
