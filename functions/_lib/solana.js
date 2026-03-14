import { encode, decode } from './base58.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://api.jup.ag/swap/v1';

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

// --- Balance cache (populated by prefetchAllBalances, used by getBalance/getTokenBalances) ---
const _balanceCache = new Map();
const _tokenBalanceCache = new Map();

// Load pre-fetched balance data into cache (called from process-trades with data from Hetzner)
export function loadBalanceCache(data) {
  _balanceCache.clear();
  _tokenBalanceCache.clear();
  for (const [pubkey, info] of Object.entries(data)) {
    _balanceCache.set(pubkey, info.sol);
    const tokens = info.tokens || [];
    _tokenBalanceCache.set(pubkey, tokens);
    if (tokens.length > 0) {
      console.log(`[cache] ${pubkey.substring(0,8)}: ${tokens.length} token(s) - ${tokens.map(t=>t.mint.substring(0,12)+'='+t.amount).join(', ')}`);
    }
  }
}

// Get SOL balance in SOL (not lamports) — uses cache if available
export async function getBalance(pubkeyB58, rpcUrl) {
  if (_balanceCache.has(pubkeyB58)) return _balanceCache.get(pubkeyB58);
  const data = await rpcCall(rpcUrl, 'getBalance', [pubkeyB58, { commitment: 'confirmed' }]);
  return (data?.value || 0) / 1e9;
}

// Check holder distribution — returns number of holders with >1.1% of TOTAL supply
export async function getHolderConcentration(mintAddress, rpcUrl) {
  const [data, supplyData] = await Promise.all([
    rpcCall(rpcUrl, 'getTokenLargestAccounts', [mintAddress, { commitment: 'confirmed' }]),
    rpcCall(rpcUrl, 'getTokenSupply', [mintAddress, { commitment: 'confirmed' }]),
  ]);
  const accounts = data?.value || [];
  if (accounts.length === 0) return { bigHolders: 0, topHolders: [] };

  // Use actual total supply, not sum of top 20
  const totalSupply = parseFloat(supplyData?.value?.uiAmountString || '0');
  if (totalSupply <= 0) return { bigHolders: 0, topHolders: [] };

  const topHolders = accounts
    .map(a => ({ amount: parseFloat(a.uiAmountString || '0'), pct: (parseFloat(a.uiAmountString || '0') / totalSupply) * 100 }))
    .filter(h => h.pct > 1.1)
    .sort((a, b) => b.pct - a.pct);

  return { bigHolders: topHolders.length, topHolders };
}

// Verify that a specific wallet sent tokens to the treasury
export async function verifyTokenTransfer(senderWallet, recipientWallet, mint, expectedAmount, rpcUrl) {
  // Get the recipient's token account for this mint
  // Try both Token programs (legacy + Token-2022) since getTokenAccountsByOwner only searches one at a time
  let ataAddress = null;
  for (const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const ata = await rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
      recipientWallet, { programId: prog }, { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]).catch(() => ({ value: [] }));
    const match = (ata?.value || []).find(a => a.account?.data?.parsed?.info?.mint === mint);
    if (match) { ataAddress = match.pubkey; break; }
  }
  if (!ataAddress) return { verified: false, reason: 'no token account' };

  // Check recent transactions to this token account
  const sigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [ataAddress, { limit: 15 }]);
  if (!sigs?.length) return { verified: false, reason: 'no recent txs' };

  for (const sig of sigs) {
    if (sig.err) continue;
    const tx = await rpcCall(rpcUrl, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta) continue;

    // Check sender is the expected wallet
    const accounts = tx.transaction.message.accountKeys;
    const sender = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].pubkey;
    if (sender !== senderWallet) continue;

    // Check token balance change for the recipient
    const pre = (tx.meta.preTokenBalances || []).find(b => b.mint === mint && b.owner === recipientWallet);
    const post = (tx.meta.postTokenBalances || []).find(b => b.mint === mint && b.owner === recipientWallet);
    const preAmt = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
    const postAmt = post ? parseFloat(post.uiTokenAmount.uiAmountString || '0') : 0;
    const delta = postAmt - preAmt;

    if (delta >= expectedAmount * 0.95) {
      return { verified: true, txSignature: sig.signature, amount: delta };
    }
  }
  return { verified: false, reason: 'no matching transfer' };
}

// Get SPL token balances for a wallet — uses cache if available
export async function getTokenBalances(pubkeyB58, rpcUrl) {
  if (_tokenBalanceCache.has(pubkeyB58)) return _tokenBalanceCache.get(pubkeyB58);
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

  const [data1, data2] = await Promise.all([
    rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
      pubkeyB58, { programId: TOKEN_PROGRAM },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]).catch(() => ({ value: [] })),
    rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
      pubkeyB58, { programId: TOKEN_2022 },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]).catch(() => ({ value: [] })),
  ]);

  const allAccounts = [...(data1?.value || []), ...(data2?.value || [])];

  return allAccounts
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

// Set Jupiter API key (call once from request handler)
let _jupiterApiKey = '';
export function setJupiterApiKey(key) { _jupiterApiKey = key; }

// Get Jupiter quote
export async function getJupiterQuote(inputMint, outputMint, amountSmallestUnit, slippageBps = 100) {
  const headers = {};
  if (_jupiterApiKey) headers['x-api-key'] = _jupiterApiKey;
  const res = await fetch(
    `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountSmallestUnit}&slippageBps=${slippageBps}`,
    { headers }
  );
  if (!res.ok) return null;
  return await res.json();
}

// Get Jupiter swap transaction (base64 encoded)
export async function getJupiterSwapTx(quoteResponse, userPublicKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (_jupiterApiKey) headers['x-api-key'] = _jupiterApiKey;
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 50000,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.swapTransaction; // base64
}

// PumpPortal: get a serialized swap tx for pump.fun bonding curve (or auto-routed)
// Returns base64-encoded tx, same format as Jupiter — sign with signAndSendSwapTx
export async function getPumpPortalTx(publicKey, action, mint, amount, opts = {}) {
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      action,           // "buy" or "sell"
      mint,
      amount,           // SOL amount (if denominatedInSol) or token amount
      denominatedInSol: opts.denominatedInSol !== undefined ? opts.denominatedInSol : (action === 'buy'),
      slippage: opts.slippage || 10,
      priorityFee: opts.priorityFee || 0.0003,
      pool: opts.pool || 'auto',
    }),
  });
  if (!res.ok) return null;
  // Response is raw bytes of the serialized transaction
  const buf = await res.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
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
  const txSig = await rpcCall(rpcUrl, 'sendTransaction', [
    signedBase64,
    { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed' },
  ]);

  // Fire and forget — confirmation checked in next cycle by recalc-pnl
  return txSig;
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


// Count unique wallets that traded a token recently (rug detection)
export async function getUniqueTraders(tokenMint, rpcUrl, limit = 20) {
  try {
    const sigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [tokenMint, { limit }]);
    if (!sigs || sigs.length === 0) return { unique: 0, total: 0 };

    const signers = new Set();
    // Check first 10 txs for unique signers (rate limit friendly)
    const toCheck = sigs.filter(s => !s.err).slice(0, 10);
    for (const sig of toCheck) {
      try {
        const tx = await rpcCall(rpcUrl, 'getTransaction', [
          sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
        ]);
        if (tx?.transaction?.message?.accountKeys) {
          // First account key is the fee payer (= the trader)
          const keys = tx.transaction.message.accountKeys;
          const signer = typeof keys[0] === 'string' ? keys[0] : keys[0].pubkey;
          signers.add(signer);
        }
      } catch {}
    }
    return { unique: signers.size, total: toCheck.length };
  } catch {
    return { unique: 0, total: 0 };
  }
}

// Batch JSON-RPC: send multiple calls in ONE HTTP request
async function batchRpcCall(url, calls) {
  const body = calls.map((c, i) => ({
    jsonrpc: '2.0', id: i, method: c.method, params: c.params,
  }));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(tid);
      const text = await res.text();
      if (!text) { await sleep(500 * (attempt + 1)); continue; }
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('batch RPC: expected array response');
      data.sort((a, b) => a.id - b.id);
      return data.map(r => r.result);
    } catch (e) {
      if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error('batch RPC failed after 3 attempts');
}

const RPC_FALLBACKS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];

async function rpcCall(url, method, params) {
  const endpoints = [url, ...RPC_FALLBACKS];
  let lastErr;
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
          signal: controller.signal,
        });
        clearTimeout(tid);
        if (res.status === 429) {
          lastErr = new Error(`RPC ${method}: rate limited`);
          break;
        }
        const text = await res.text();
        if (!text) {
          if (attempt < 1) { await sleep(300); continue; }
          lastErr = new Error(`RPC ${method}: empty response`);
          break;
        }
        const data = JSON.parse(text);
        if (data.error) {
          if (data.error.code === -32429 || data.error.code === 429 || (data.error.message && data.error.message.includes('blocked'))) {
            lastErr = new Error(`RPC ${method}: ${data.error.message}`);
            break;
          }
          throw new Error(`RPC ${method}: ${data.error.message}`);
        }
        return data.result;
      } catch (e) {
        lastErr = e;
        if (e.name === 'AbortError' && attempt < 1) { continue; }
        break;
      }
    }
  }
  throw lastErr || new Error(`RPC ${method}: all endpoints failed`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
