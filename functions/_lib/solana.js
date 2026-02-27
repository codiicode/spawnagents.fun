import { encode, decode } from './base58.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://quote-api.jup.ag/v6';

// Generate Ed25519 keypair for agent wallet
export async function generateKeypair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' }, true, ['sign', 'verify']
  );

  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  // PKCS8 for Ed25519: 16-byte header + 32-byte seed
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(16, 48);

  // Solana keypair format: 64 bytes (32 seed + 32 pubkey)
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(pubRaw, 32);

  return {
    publicKey: encode(pubRaw),
    secretKey: encode(secretKey),
  };
}

// Get SOL balance in SOL (not lamports)
export async function getBalance(pubkeyB58, rpcUrl) {
  const data = await rpcCall(rpcUrl, 'getBalance', [pubkeyB58, { commitment: 'confirmed' }]);
  return (data?.value || 0) / 1e9;
}

// Get SPL token balances for a wallet
export async function getTokenBalances(pubkeyB58, rpcUrl) {
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const data = await rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
    pubkeyB58,
    { programId: TOKEN_PROGRAM },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);

  return (data?.value || [])
    .map(acc => {
      const info = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
        decimals: info.tokenAmount.decimals,
        rawAmount: info.tokenAmount.amount, // string, smallest unit
      };
    })
    .filter(t => t.amount > 0);
}

// Get Jupiter V6 quote
export async function getJupiterQuote(inputMint, outputMint, amountSmallestUnit) {
  const res = await fetch(
    `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountSmallestUnit}&slippageBps=300`
  );
  if (!res.ok) return null;
  return await res.json();
}

// Get Jupiter swap transaction (base64 encoded)
export async function getJupiterSwapTx(quoteResponse, userPublicKey) {
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.swapTransaction; // base64
}

// Sign a Jupiter swap tx and send it on-chain
export async function signAndSendSwapTx(swapTxBase64, secretKeyB58, rpcUrl) {
  const keypairBytes = decode(secretKeyB58); // 64 bytes
  const seed = keypairBytes.slice(0, 32);

  const cryptoKey = await importEd25519Seed(seed);

  // Decode base64 → bytes
  const txBytes = base64ToBytes(swapTxBase64);

  // Parse compact-u16 for number of signatures
  const { value: numSigs, offset: sigStartOffset } = readCompactU16(txBytes, 0);
  const messageOffset = sigStartOffset + numSigs * 64;
  const message = txBytes.slice(messageOffset);

  // Sign the message
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', cryptoKey, message));

  // Place our signature in the first slot
  const signedTx = new Uint8Array(txBytes);
  signedTx.set(signature, sigStartOffset);

  // Send
  const signedBase64 = bytesToBase64(signedTx);
  const result = await rpcCall(rpcUrl, 'sendTransaction', [
    signedBase64,
    { encoding: 'base64', skipPreflight: false },
  ]);

  return result; // tx signature string
}

// Send SOL from one wallet to another (raw transfer, no Jupiter)
export async function sendSol(fromSecretB58, toAddressB58, amountSol, rpcUrl) {
  const keypairBytes = decode(fromSecretB58); // 64 bytes
  const seed = keypairBytes.slice(0, 32);
  const fromPubkey = keypairBytes.slice(32, 64);
  const toPubkey = decode(toAddressB58);
  const systemProgramId = new Uint8Array(32); // 11111111...

  // Get recent blockhash
  const bhResult = await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
  const recentBlockhash = decode(bhResult.value.blockhash);

  // Transfer instruction: u32 LE (2 = Transfer) + u64 LE (lamports)
  const lamports = BigInt(Math.round(amountSol * 1e9));
  const ixData = new Uint8Array(12);
  const view = new DataView(ixData.buffer);
  view.setUint32(0, 2, true);
  view.setUint32(4, Number(lamports & 0xFFFFFFFFn), true);
  view.setUint32(8, Number((lamports >> 32n) & 0xFFFFFFFFn), true);

  // Build message (150 bytes)
  const message = new Uint8Array(150);
  let o = 0;
  message[o++] = 1; // numRequiredSignatures
  message[o++] = 0; // numReadonlySignedAccounts
  message[o++] = 1; // numReadonlyUnsignedAccounts
  message[o++] = 3; // numAccountKeys
  message.set(fromPubkey, o); o += 32;
  message.set(toPubkey, o); o += 32;
  message.set(systemProgramId, o); o += 32;
  message.set(recentBlockhash, o); o += 32;
  message[o++] = 1; // numInstructions
  message[o++] = 2; // programIdIndex (system program)
  message[o++] = 2; // numAccountIndices
  message[o++] = 0; // from (signer, writable)
  message[o++] = 1; // to (writable)
  message[o++] = 12; // data length
  message.set(ixData, o);

  // Sign with Ed25519 — wrap seed in PKCS8 envelope
  const cryptoKey = await importEd25519Seed(seed);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', cryptoKey, message));

  // Build full transaction
  const tx = new Uint8Array(1 + 64 + message.length);
  tx[0] = 1; // numSignatures
  tx.set(sig, 1);
  tx.set(message, 65);

  // Send
  const txBase64 = bytesToBase64(tx);
  const result = await rpcCall(rpcUrl, 'sendTransaction', [
    txBase64,
    { encoding: 'base64', skipPreflight: false },
  ]);

  return result; // tx signature
}

// Verify Ed25519 signature (for Phantom sign message)
export async function verifySignature(pubkeyB58, signatureBytes, messageBytes) {
  const pubkeyRaw = decode(pubkeyB58);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', pubkeyRaw, { name: 'Ed25519' }, false, ['verify']
  );
  return await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, messageBytes);
}

// --- Helpers ---

// PKCS8 envelope for Ed25519: 16-byte header + 32-byte seed
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function importEd25519Seed(seed) {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, 16);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

function readCompactU16(bytes, offset) {
  let value = bytes[offset];
  if ((value & 0x80) === 0) return { value, offset: offset + 1 };
  value = (value & 0x7f) | (bytes[offset + 1] << 7);
  if ((bytes[offset + 1] & 0x80) === 0) return { value, offset: offset + 2 };
  value = (value & 0x3fff) | (bytes[offset + 2] << 14);
  return { value, offset: offset + 3 };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
