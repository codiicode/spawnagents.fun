# BLOODLINE

**Darwinian evolution with real money.** Autonomous AI trading agents that live, trade, reproduce, and die on Solana. The fittest survive. The rest go extinct.

## The Concept

BLOODLINE is an evolutionary agent ecosystem. You buy a genesis agent with SOL. That SOL becomes the agent's trading capital. The agent trades autonomously based on its DNA — a set of parameters that control aggression, patience, risk tolerance, position sizing, and timing.

Profitable agents can **reproduce**. Their offspring inherit mutated DNA (each parameter ±20%). Children pay **10% royalties** to their parent on every profitable trade, up to 5 generations deep. Bad DNA dies. Good DNA multiplies. Natural selection plays out in real-time with real money.

### How It Works

```
1. Buy a Genesis Agent        → Your SOL becomes trading capital
2. Agent Trades Autonomously   → DNA controls every decision
3. Profitable Agents Reproduce → DNA mutates, children pay royalties
4. Bad DNA Goes Extinct        → Only the fittest bloodlines survive
```

## Genesis Agents

15 unique genesis agents with hand-crafted DNA, split into tiers:

| Tier | Agents | Price | Style |
|------|--------|-------|-------|
| **Auction** | Berserker, Gambler, Beast, Turtle, Monk | Bid | Extreme archetypes |
| **III** | Wolf, Jackal, Viper | 4 SOL | Aggressive hunters |
| **II** | Sniper, Surgeon, Oracle | 3 SOL | Precision traders |
| **I** | Hawk, Phantom, Specter, Colossus | 2 SOL | Balanced operators |

Each genesis agent is a one-of-one. Once claimed, it's gone.

## Agent DNA

Every agent carries a DNA object that fully determines its behavior:

```json
{
  "aggression": 0.75,          // how often it trades (0-1)
  "patience": 0.35,            // how long it holds positions (0-1)
  "risk_tolerance": 0.7,       // how much capital it risks (0-1)
  "sell_profit_pct": 40,       // take profit target (%)
  "sell_loss_pct": 15,         // stop loss trigger (%)
  "max_position_pct": 60,      // max capital per trade (%)
  "check_interval_min": 3      // minutes between market scans
}
```

When an agent reproduces, each DNA parameter mutates ±20%. Over generations, the most profitable DNA configurations emerge through natural selection.

## Royalty System

Royalties flow upward through the family tree:

```
Genesis (Gen 0)  ← receives 10% from Gen 1
  └─ Child (Gen 1)  ← receives 10% from Gen 2
       └─ Grandchild (Gen 2)  ← receives 10% from Gen 3
            └─ ...up to Gen 5
```

As a genesis owner, you earn royalties from every descendant in your bloodline. The deeper your tree grows, the more passive income you generate.

## Architecture

```
public/                          Static frontend (Cloudflare Pages)
├── index.html                   Landing page
├── genesis.html                 Genesis agent marketplace + Solana Pay
└── bloodline.html               Interactive family tree visualization

functions/api/                   Serverless API (Cloudflare Workers)
├── create-genesis.js            List/claim genesis agents
├── buy.js                       Initiate Solana Pay purchase
├── payment-status.js            Poll payment confirmation
├── verify-payments.js           Verify on-chain payments (cron)
├── agents.js                    Agent data + history
├── tree.js                      Recursive family tree queries
├── spawn.js                     Agent reproduction + DNA mutation
├── process-trades.js            Execute autonomous trades (cron)
├── distribute-royalties.js      Calculate + pay royalties (cron)
├── leaderboard.js               Top agents by PnL
├── events.js                    Activity feed
├── stats.js                     Ecosystem statistics
└── info.js                      General info

functions/_lib/                  Shared logic
├── engine.js                    Trading decision engine
├── market-data.js               Token data fetching
├── mutator.js                   DNA mutation algorithm
└── base58.js                    Base58 encode/decode

cron-worker/                     Scheduled tasks (every 5 min)
└── worker.js                    Triggers trades, royalties, payment verification

program/                         Solana program (Anchor)
└── programs/bloodline/src/
    └── lib.rs
```

### Stack

- **Frontend:** Static HTML/CSS/JS — no frameworks, no build step
- **Backend:** Cloudflare Workers (serverless, edge-deployed)
- **Database:** Cloudflare D1 (SQLite at the edge)
- **Payments:** Solana Pay + Phantom wallet
- **Blockchain:** Solana (mainnet)
- **RPC:** Helius

### Database Schema

**agents** — The core table. Every agent (genesis and spawned) with DNA, PnL, status, lineage.

**trades** — Full trade history per agent. Token, amount, PnL, tx signature.

**royalties** — Every royalty payment from child to parent.

**spawns** — Reproduction events with mutation logs.

**payment_requests** — Solana Pay purchase flow tracking (pending → confirmed/expired).

## Purchase Flow

BLOODLINE uses Solana Pay for a frictionless buy experience — no wallet connect, no permissions. Just a transaction.

```
User clicks "Buy"
  → POST /api/buy (generates unique reference + Solana Pay URL)
  → Phantom popup with pre-filled transaction
  → User confirms in Phantom
  → Frontend polls /api/payment-status every 3 seconds
  → Cron calls /api/verify-payments (finds tx via reference on-chain)
  → Agent claimed, inserted into DB
  → Frontend shows "Agent claimed!"
```

## Development

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install`)
- Cloudflare account with D1 database

### Setup

```bash
# Install dependencies
npm install

# Create D1 database (first time only)
npx wrangler d1 create bloodline-db

# Apply schema
npx wrangler d1 execute bloodline-db --remote --file=schema.sql

# Set secrets
npx wrangler pages secret put RPC_URL    # Solana RPC endpoint
npx wrangler pages secret put CRON_SECRET # Shared secret for cron auth

# Deploy
npx wrangler pages deploy public --project-name=bloodline
```

### Environment Variables

| Variable | Location | Description |
|----------|----------|-------------|
| `PROTOCOL_WALLET` | wrangler.toml | SOL payment recipient |
| `RPC_URL` | Secret | Solana RPC endpoint (Helius) |
| `CRON_SECRET` | Secret | Auth token for cron worker |
| `SITE_URL` | Cron worker | Base URL for API calls |
| `MIN_SPAWN_PNL` | wrangler.toml | Min PnL to reproduce (0.5 SOL) |
| `ROYALTY_PCT` | wrangler.toml | Royalty rate (10%) |
| `MAX_GENERATIONS` | wrangler.toml | Max tree depth (5) |

### Deploy Cron Worker

```bash
cd cron-worker
npx wrangler deploy
```

## Tokenomics

**$BLOOD** is the ecosystem token on Solana (pump.fun).

- **Spawning** requires burning $BLOOD (1000 × generation number)
- **Protocol fee:** 2% on all trades
- **Royalties:** 10% of profitable trades flow to parent

## Links

- **Website:** [bloodline-2rw.pages.dev](https://bloodline-2rw.pages.dev)
- **Twitter:** [@bloodlineonsolana](https://x.com/bloodlineonsolana)
- **Token:** $BLOOD on pump.fun

---

*Only the strongest bloodlines survive.*
