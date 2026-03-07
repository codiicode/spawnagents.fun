import { encode, decode } from '../_lib/base58.js';
import { verifySignature, sendSol, getBalance } from '../_lib/solana.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const body = await context.request.json();
  const { agent_id, amount_sol, method } = body;

  if (!agent_id || !amount_sol || !method) {
    return Response.json({ error: 'Missing agent_id, amount_sol, or method' }, { status: 400 });
  }

  if (!['phantom', 'micro_tx'].includes(method)) {
    return Response.json({ error: 'Invalid method. Use phantom or micro_tx' }, { status: 400 });
  }

  if (amount_sol <= 0) {
    return Response.json({ error: 'Amount must be positive' }, { status: 400 });
  }

  const db = context.env.DB;
  const rpcUrl = context.env.RPC_URL;

  // Fetch agent
  const agent = await db.prepare(
    'SELECT id, owner_wallet, agent_wallet, status FROM agents WHERE id = ?'
  ).bind(agent_id).first();

  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (agent.status !== 'alive') return Response.json({ error: 'Agent is not alive' }, { status: 400 });

  // Check agent balance
  const balance = await getBalance(agent.agent_wallet, rpcUrl);
  const minRent = 0.003; // Keep rent-exempt minimum
  if (amount_sol > balance - minRent) {
    return Response.json({
      error: `Insufficient balance. Agent has ${balance.toFixed(4)} SOL (${(balance - minRent).toFixed(4)} withdrawable)`,
    }, { status: 400 });
  }

  // === PHANTOM METHOD ===
  if (method === 'phantom') {
    const { signature, message } = body;
    if (!signature || !message) {
      return Response.json({ error: 'Phantom method requires signature and message' }, { status: 400 });
    }

    // Decode signature from base64
    const sigBytes = base64ToBytes(signature);
    const msgBytes = new TextEncoder().encode(message);

    // Verify the message format: "withdraw:AGENT_ID:AMOUNT:NONCE"
    const parts = message.split(':');
    if (parts.length !== 4 || parts[0] !== 'withdraw' || parts[1] !== agent_id) {
      return Response.json({ error: 'Invalid message format' }, { status: 400 });
    }

    const msgAmount = parseFloat(parts[2]);
    if (Math.abs(msgAmount - amount_sol) > 0.0001) {
      return Response.json({ error: 'Amount in message does not match' }, { status: 400 });
    }

    // Verify signature against owner wallet
    const valid = await verifySignature(agent.owner_wallet, sigBytes, msgBytes);
    if (!valid) {
      return Response.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Execute withdrawal immediately
    const kv = context.env.AGENT_KEYS;
    const agentSecret = await kv.get(`agent:${agent_id}:secret`);
    if (!agentSecret) {
      return Response.json({ error: 'Agent key not found' }, { status: 500 });
    }

    try {
      const txSig = await sendSol(agentSecret, agent.owner_wallet, amount_sol, rpcUrl);

      // Log withdrawal + track total withdrawn
      await db.batch([
        db.prepare("INSERT INTO withdrawal_requests (id, agent_id, owner_wallet, amount_sol, method, status, tx_signature) VALUES (?, ?, ?, ?, 'phantom', 'completed', ?)").bind(crypto.randomUUID(), agent_id, agent.owner_wallet, amount_sol, txSig),
        db.prepare("UPDATE agents SET total_withdrawn = total_withdrawn + ? WHERE id = ?").bind(amount_sol, agent_id),
      ]);

      return Response.json({ status: 'completed', tx_signature: txSig });
    } catch (e) {
      return Response.json({ error: 'Withdrawal failed: ' + e.message }, { status: 500 });
    }
  }

  // === MICRO-TX METHOD ===
  if (method === 'micro_tx') {
    // Generate unique reference and micro amount
    const refBytes = new Uint8Array(32);
    crypto.getRandomValues(refBytes);
    const reference = encode(refBytes);

    // 0.001 + random 0.000001-0.000999
    const microAmount = 0.001 + Math.floor(Math.random() * 999) * 0.000001;
    const roundedMicro = parseFloat(microAmount.toFixed(6));

    const withdrawalId = crypto.randomUUID();

    await db.prepare(
      "INSERT INTO withdrawal_requests (id, agent_id, owner_wallet, amount_sol, method, micro_amount, reference, status) VALUES (?, ?, ?, ?, 'micro_tx', ?, ?, 'pending')"
    ).bind(withdrawalId, agent_id, agent.owner_wallet, amount_sol, roundedMicro, reference).run();

    return Response.json({
      withdrawal_id: withdrawalId,
      micro_amount: roundedMicro,
      reference,
      send_to: context.env.PROTOCOL_WALLET,
      owner_wallet: agent.owner_wallet,
    });
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
