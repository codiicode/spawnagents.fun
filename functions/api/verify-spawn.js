import { getTokenBalances, generateKeypair, sendSol, verifyTokenTransfer } from '../_lib/solana.js';
import { mutate, crossover } from '../_lib/mutator.js';

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
  let tokenVerified = false;
  if (!pending.spawn_cost || pending.spawn_cost <= 0) {
    tokenVerified = true;
  } else {
    const tokenResult = await verifyTokenTransfer(pending.owner_wallet, protocolWallet, SPAWN_MINT, pending.spawn_cost, rpcUrl);
    tokenVerified = tokenResult.verified;
  }

  if (!tokenVerified) {
    return Response.json({
      status: 'pending',
      checks: { token: false, sol: false },
      reason: `Waiting for ${pending.spawn_cost.toLocaleString()} $SPAWN tokens`,
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
      checks: { token: tokenVerified, sol: false },
      reason: `Waiting for SOL payment (${pending.sol_amount} SOL)`,
    });
  }

  // === BOTH VERIFIED — CREATE CHILD AGENT ===
  const parent = await db.prepare('SELECT * FROM agents WHERE id = ?').bind(pending.parent_id).first();
  if (!parent) {
    await db.prepare("UPDATE pending_spawns SET status = 'failed' WHERE id = ?").bind(spawn_id).run();
    return Response.json({ error: 'Parent no longer exists' }, { status: 400 });
  }

  const parentDna = JSON.parse(parent.dna);

  // 50% chance to use crossover with second-best agent
  let childDna, mutations;
  const useCrossover = Math.random() < 0.5;
  if (useCrossover) {
    const secondParent = await db.prepare(
      "SELECT dna FROM agents WHERE status = 'alive' AND id != ? AND total_pnl > 0 ORDER BY fitness_score DESC LIMIT 1"
    ).bind(pending.parent_id).first();
    if (secondParent) {
      const parentBDna = JSON.parse(secondParent.dna);
      ({ childDna, mutations } = crossover(parentDna, parentBDna));
    } else {
      ({ childDna, mutations } = mutate(parentDna));
    }
  } else {
    ({ childDna, mutations } = mutate(parentDna));
  }
  const childGen = parent.generation + 1;
  const childId = `agent_${crypto.randomUUID().slice(0, 8)}`;
  const childName = await generateChildName(childDna, parent, db);

  // Generate child wallet
  const keypair = await generateKeypair();
  const kv = context.env.AGENT_KEYS;
  if (kv) await kv.put(`agent:${childId}:secret`, keypair.secretKey);

  // Fund child wallet — 5% protocol fee, 95% goes to child
  const protocolFee = parseFloat((pending.sol_amount * 0.05).toFixed(6));
  const tradingCapital = parseFloat((pending.sol_amount - protocolFee).toFixed(6));

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

  // Inherit parent's image/avatar meta
  let childMeta = null;
  if (parent.meta) {
    try {
      const pm = typeof parent.meta === 'string' ? JSON.parse(parent.meta) : parent.meta;
      if (pm.avatar || pm.image) childMeta = JSON.stringify({ avatar: pm.avatar || pm.image });
    } catch {}
  }

  // Insert child agent + spawn record + event, update pending status
  await db.batch([
    db.prepare(
      "INSERT INTO agents (id, name, parent_id, generation, owner_wallet, agent_wallet, dna, status, initial_capital, spawn_cost_blood, meta) VALUES (?, ?, ?, ?, ?, ?, ?, 'alive', ?, ?, ?)"
    ).bind(childId, childName, pending.parent_id, childGen, pending.owner_wallet, keypair.publicKey, JSON.stringify(childDna), tradingCapital, pending.spawn_cost, childMeta),
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
      name: childName,
      parent_id: pending.parent_id,
      generation: childGen,
      dna: childDna,
      mutations,
      agent_wallet: keypair.publicKey,
      trading_capital: tradingCapital,
    },
  });
}

async function generateChildName(dna, parent, db) {
  // Walk up to genesis ancestor
  const rootId = await getGenesisId(parent, db);

  // Family-themed name pools — children inherit their lineage's theme
  const FAMILY_NAMES = {
    'the-hawk':      ['The Falcon', 'The Kite', 'The Osprey', 'The Harrier', 'The Merlin', 'The Goshawk', 'The Peregrine', 'The Sparrowhawk', 'The Kestrel', 'The Raptor'],
    'the-specter':   ['The Wraith', 'The Shade', 'The Phantom', 'The Revenant', 'The Apparition', 'The Banshee', 'The Poltergeist', 'The Haunt', 'The Mirage', 'The Echo'],
    'the-sniper':    ['The Marksman', 'The Sharpshooter', 'The Deadeye', 'The Longshot', 'The Crosshair', 'The Scope', 'The Silencer', 'The Caliber', 'The Bullet', 'The Rifleman'],
    'the-surgeon':   ['The Scalpel', 'The Stitcher', 'The Medic', 'The Anatomist', 'The Bonesaw', 'The Remedy', 'The Tourniquet', 'The Lancet', 'The Suture', 'The Physician'],
    'the-colossus':  ['The Titan', 'The Goliath', 'The Behemoth', 'The Leviathan', 'The Monolith', 'The Juggernaut', 'The Atlas', 'The Mammoth', 'The Colosseum', 'The Fortress'],
    'the-wolf':      ['The Alpha', 'The Howler', 'The Fenrir', 'The Lycan', 'The Dire', 'The Fang', 'The Packrunner', 'The Bloodhound', 'The Coyote', 'The Warg'],
    'the-jackal':    ['The Hyena', 'The Scavenger', 'The Prowler', 'The Vulture', 'The Carcass', 'The Gnasher', 'The Stalker', 'The Carrion', 'The Marauder', 'The Rogue'],
    'the-oracle':    ['The Prophet', 'The Seer', 'The Diviner', 'The Augur', 'The Mystic', 'The Sage', 'The Visionary', 'The Omen', 'The Sibyl', 'The Harbinger'],
    'the-viper':     ['The Cobra', 'The Mamba', 'The Asp', 'The Rattler', 'The Serpent', 'The Adder', 'The Taipan', 'The Basilisk', 'The Hydra', 'The Fangstrike'],
    'the-phantom':   ['The Ghost', 'The Shadow', 'The Vanish', 'The Void', 'The Hollow', 'The Wisp', 'The Specter', 'The Gloom', 'The Umbra', 'The Dusk'],
    'the-beast':     ['The Brute', 'The Mauler', 'The Ravager', 'The Savage', 'The Predator', 'The Rampage', 'The Crusher', 'The Berserker', 'The Fury', 'The Havoc'],
    'the-berserker': ['The Rage', 'The Wrath', 'The Fury', 'The Bloodlust', 'The Warmonger', 'The Hellion', 'The Destroyer', 'The Inferno', 'The Madness', 'The Carnage'],
    'the-turtle':    ['The Shell', 'The Bastion', 'The Bulwark', 'The Rampart', 'The Ironclad', 'The Aegis', 'The Garrison', 'The Bunker', 'The Citadel', 'The Tortoise'],
    'the-monk':      ['The Pilgrim', 'The Ascetic', 'The Hermit', 'The Disciple', 'The Zen', 'The Abbot', 'The Templar', 'The Acolyte', 'The Devotee', 'The Friar'],
    'the-gambler':   ['The Bluffer', 'The Ace', 'The Wildcard', 'The Hustler', 'The Jackpot', 'The Diceroll', 'The High Roller', 'The Joker', 'The Ante', 'The Flush'],
  };

  // Get names already taken
  const existing = await db.prepare("SELECT name FROM agents WHERE name IS NOT NULL").all();
  const taken = new Set((existing.results || []).map(r => r.name));

  const pool = FAMILY_NAMES[rootId];
  if (pool) {
    // Shuffle and pick first untaken
    const shuffled = pool.sort(() => Math.random() - 0.5);
    for (const name of shuffled) {
      if (!taken.has(name)) return name;
    }
    // All taken — append number
    return pool[0] + ' ' + (Math.floor(Math.random() * 90) + 10);
  }

  // Fallback for unknown lineages (custom agents)
  const fallback = ['The Offspring', 'The Heir', 'The Scion', 'The Progeny', 'The Descendant', 'The Successor', 'The Legacy', 'The Inheritor', 'The Protege', 'The Spawn'];
  const shuffledFb = fallback.sort(() => Math.random() - 0.5);
  for (const name of shuffledFb) {
    if (!taken.has(name)) return name;
  }
  return fallback[0] + ' ' + (Math.floor(Math.random() * 90) + 10);
}

async function getGenesisId(agent, db) {
  let current = agent;
  for (let i = 0; i < 10; i++) {
    if (current.generation === 0) return current.id;
    if (!current.parent_id) return current.id;
    current = await db.prepare('SELECT id, parent_id, generation FROM agents WHERE id = ?').bind(current.parent_id).first();
    if (!current) break;
  }
  return agent.parent_id || agent.id;
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
