import { getTokenBalances, generateKeypair, sendSol } from '../_lib/solana.js';
import { mutate } from '../_lib/mutator.js';

const SPAWN_MINT = '4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump';

export async function onRequest(context) {
  if (context.request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;
  const protocolWallet = context.env.PROTOCOL_WALLET;

  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { spawn_id } = body;
  if (!spawn_id) return Response.json({ error: 'Missing spawn_id' }, { status: 400 });

  const pending = await db.prepare("SELECT * FROM pending_spawns WHERE id = ? AND status = 'pending'").bind(spawn_id).first();
  if (!pending) return Response.json({ error: 'Spawn request not found or already processed' }, { status: 404 });

  // Expire after 30 min
  const ageMin = (Date.now() - new Date(pending.created_at + 'Z').getTime()) / 60000;
  if (ageMin > 30) {
    await db.prepare("UPDATE pending_spawns SET status = 'expired' WHERE id = ?").bind(spawn_id).run();
    return Response.json({ status: 'expired', reason: 'Spawn request expired (30 min)' });
  }

  // === VERIFY $SPAWN TOKEN PAYMENT ===
  const protocolTokens = await getTokenBalances(protocolWallet, rpcUrl).catch(() => []);
  const spawnToken = protocolTokens.find(t => t.mint === SPAWN_MINT);
  const spawnBalance = spawnToken ? spawnToken.amount : 0;

  if (spawnBalance < pending.spawn_cost) {
    return Response.json({
      status: 'pending',
      checks: { token: false, sol: false },
      reason: `Waiting for $SPAWN tokens (need ${pending.spawn_cost.toLocaleString()}, wallet has ${Math.floor(spawnBalance).toLocaleString()})`,
    });
  }

  // === VERIFY SOL PAYMENT (micro-amount matching) ===
  let solVerified = false;
  let solTxSig = null;

  const recentSigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [protocolWallet, { limit: 15 }]);

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

      // Skip micro amounts from login/withdrawal (< 0.5 SOL)
      if (solReceived < 0.5) continue;

      // Match within 0.5% tolerance
      if (Math.abs(solReceived - pending.sol_amount) <= pending.sol_amount * 0.005) {
        const sender = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;

        // Verify sender is the owner
        if (sender === pending.owner_wallet) {
          solVerified = true;
          solTxSig = sig.signature;
          break;
        }
      }
    }
  }

  if (!solVerified) {
    return Response.json({
      status: 'pending',
      checks: { token: true, sol: false },
      reason: `$SPAWN verified. Waiting for SOL payment (${pending.sol_amount} SOL)`,
    });
  }

  // === BOTH VERIFIED — CREATE CHILD AGENT ===
  const parent = await db.prepare('SELECT * FROM agents WHERE id = ?').bind(pending.parent_id).first();
  if (!parent) {
    await db.prepare("UPDATE pending_spawns SET status = 'failed' WHERE id = ?").bind(spawn_id).run();
    return Response.json({ error: 'Parent no longer exists' }, { status: 400 });
  }

  const parentDna = JSON.parse(parent.dna);
  const { childDna, mutations } = mutate(parentDna);
  const childGen = parent.generation + 1;
  const childId = `agent_${crypto.randomUUID().slice(0, 8)}`;

  // Generate child wallet
  const keypair = await generateKeypair();
  const kv = context.env.AGENT_KEYS;
  if (kv) await kv.put(`agent:${childId}:secret`, keypair.secretKey);

  // Fund child wallet (SOL minus protocol fee)
  const feePct = parseFloat(context.env.GENESIS_FEE_PCT || '0.15');
  const tradingCapital = parseFloat((pending.sol_amount * (1 - feePct)).toFixed(6));

  const protocolSecret = context.env.PROTOCOL_PRIVATE_KEY;
  if (!protocolSecret) {
    await db.prepare("UPDATE pending_spawns SET status = 'failed' WHERE id = ?").bind(spawn_id).run();
    return Response.json({ error: 'Server funding error' }, { status: 500 });
  }

  let fundingTx;
  try {
    fundingTx = await sendSol(protocolSecret, keypair.publicKey, tradingCapital, rpcUrl);
  } catch (e) {
    await db.prepare("UPDATE pending_spawns SET status = 'funding_failed' WHERE id = ?").bind(spawn_id).run();
    return Response.json({ error: `Funding failed: ${e.message}` }, { status: 500 });
  }

  // Insert child agent + spawn record + event, update pending status
  await db.batch([
    db.prepare(
      "INSERT INTO agents (id, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital, spawn_cost_blood) VALUES (?, ?, ?, ?, ?, ?, 'alive', ?, ?)"
    ).bind(childId, pending.parent_id, childGen, pending.owner_wallet, keypair.publicKey, JSON.stringify(childDna), tradingCapital, pending.spawn_cost),
    db.prepare(
      "INSERT INTO spawns (parent_id, child_id, blood_burned, mutation_log) VALUES (?, ?, ?, ?)"
    ).bind(pending.parent_id, childId, pending.spawn_cost, JSON.stringify(mutations)),
    db.prepare(
      "INSERT INTO events (type, agent_id, data) VALUES ('spawn', ?, ?)"
    ).bind(childId, JSON.stringify({
      parent: pending.parent_id, generation: childGen, mutations,
      blood_fee: pending.spawn_cost, sol_deposit: pending.sol_amount,
      agent_wallet: keypair.publicKey, funding_tx: fundingTx, sol_tx: solTxSig,
    })),
    db.prepare("UPDATE pending_spawns SET status = 'confirmed' WHERE id = ?").bind(spawn_id),
  ]);

  return Response.json({
    status: 'confirmed',
    child: {
      id: childId,
      parent_id: pending.parent_id,
      generation: childGen,
      dna: childDna,
      mutations,
      agent_wallet: keypair.publicKey,
      trading_capital: tradingCapital,
    },
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
