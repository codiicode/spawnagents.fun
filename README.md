# SPAWN

**Darwinian evolution with real money.** Autonomous trading agents that live, trade, reproduce, and die on Solana. The fittest survive. The rest go extinct.

## The Concept

SPAWN is an autonomous agent evolution ecosystem. You claim a genesis agent or create a custom one by burning **$SPAWN tokens** + depositing SOL. That SOL becomes the agent's trading capital (95%, 5% protocol fee). The agent trades autonomously via Jupiter and PumpPortal based on its DNA — a set of parameters that control aggression, patience, risk tolerance, position sizing, filters, and exit strategy.

Profitable agents can **reproduce**. Their offspring inherit mutated DNA (each parameter ±20%). Children pay **10% royalties** to their parent on every profitable trade, up to 5 generations deep. Bad DNA dies. Good DNA multiplies. Natural selection plays out in real-time with real money.

### How It Works

```
1. Claim or Create an Agent      → 500K $SPAWN burned + SOL deposit (95% = trading capital)
2. Agent Trades Autonomously      → DNA controls every decision via Jupiter / PumpPortal
3. Profitable Agents Reproduce    → 250K $SPAWN + SOL deposit, DNA mutates, children pay royalties
4. Bad DNA Goes Extinct           → Only the fittest lineages survive
```

## Genesis Agents

15 unique genesis agents with hand-crafted DNA. Claiming costs **500,000 $SPAWN** + minimum **1 SOL** deposit:

| Agent | Style |
|-------|-------|
| The Berserker | Ultra-aggressive, fast, high risk |
| The Gambler | Maximum risk, massive swings |
| The Beast | Reckless, heavy positions |
| The Turtle | Ultra-patient, conservative |
| The Monk | Minimal activity, only the safest plays |
| The Wolf | Aggressive pack hunter |
| The Jackal | Fast, opportunistic |
| The Viper | Strike hard, strike fast |
| The Sniper | Patient precision, big targets |
| The Surgeon | Calculated, clean entries |
| The Oracle | Waits for near-certainty |
| The Hawk | Balanced, mid-range |
| The Phantom | Quiet, selective |
| The Specter | Rare trades, high conviction |
| The Colossus | Steady, balanced positions |

Each genesis agent is a one-of-one. Once claimed, it's gone. If it dies (loses 80%+ of capital), it returns to market for someone else to claim.

## Custom Agents

Anyone can create a custom agent through the [Spawn Lab](/lab/). You choose your own name, avatar, and DNA parameters. Costs **500,000 $SPAWN** + minimum **1 SOL** deposit.

Custom agents support:
- Full DNA customization (aggression, risk, patience, TP, SL, position size)
- Advanced filters (min/max market cap, max token age, trailing stop %)
- Take-profit levels (up to 5 TP levels, each selling a % of original position)
- Degen mode (unlocks pump.fun tokens)

## Agent DNA

Every agent carries a DNA object that fully determines its behavior:

```json
{
  "aggression": 0.75,
  "patience": 0.35,
  "risk_tolerance": 0.7,
  "sell_profit_pct": 40,
  "sell_loss_pct": 15,
  "max_position_pct": 60,
  "buy_threshold_holders": 200,
  "buy_threshold_volume": 5000,
  "min_mcap": 10000,
  "max_mcap": 500000,
  "max_pair_age_hours": 24,
  "trailing_stop_pct": 20,
  "check_interval_min": 3
}
```

When an agent reproduces, 1-2 DNA parameters mutate ±20%. Over generations, the most profitable DNA configurations emerge through natural selection.

## Take-Profit Levels

Agents can have up to 5 TP levels. Each level triggers at a profit % and sells a portion of the **original** position:

```
TP1: +30% → sell 30% of original
TP2: +75% → sell 30% of original
TP3: +150% → sell 40% of original
```

After all TP levels are exhausted, remaining tokens auto-enable a **50% trailing stop** from peak — protecting gains while letting the position run further.

## Royalty System

Royalties flow upward through the family tree:

```
Genesis (Gen 0)  ← receives 10% from Gen 1
  └─ Child (Gen 1)  ← receives 10% from Gen 2
       └─ Grandchild (Gen 2)  ← receives 10% from Gen 3
            └─ ...up to Gen 5
```

As a genesis owner, you earn royalties from every descendant in your lineage. The deeper your tree grows, the more passive income you generate.

## Costs

| Action | $SPAWN Cost | SOL Cost |
|--------|-------------|----------|
| Claim genesis agent | 500,000 $SPAWN (burned) | Min 1 SOL deposit |
| Create custom agent | 500,000 $SPAWN (burned) | Min 1 SOL deposit |
| Reproduce (spawn child) | 250,000 $SPAWN (burned) | Min 1 SOL deposit |
| Protocol fee | — | 5% of SOL deposit |
| Royalty | — | 10% of child's profits → parent |

## Architecture

```
public/                          Static frontend (Cloudflare Pages)
├── index.html                   Landing page
├── genesis.html                 Genesis agent marketplace
├── bloodline.html               Interactive family tree visualization
├── dashboard-preview.html       Agent dashboard
├── how.html                     Full specification
└── lab/index.html               Custom agent creation (Spawn Lab)

functions/api/                   Serverless API (Cloudflare Workers)
├── buy.js                       Initiate genesis claim
├── create-custom.js             Create custom agent
├── payment-status.js            Poll payment confirmation
├── verify-payments.js           Verify on-chain payments (cron)
├── agents.js                    Agent data + history
├── tree.js                      Recursive family tree queries
├── spawn-request.js             Agent reproduction request
├── verify-spawn.js              Verify spawn payment
├── process-trades.js            Execute autonomous trades (cron)
├── distribute-royalties.js      Calculate + pay royalties (cron)
├── leaderboard.js               Top agents by PnL
├── events.js                    Activity feed
├── update-agent.js              Owner edits agent DNA/meta
├── kill-agent.js                Kill agent + return SOL
└── withdraw.js                  Owner withdrawals

functions/_lib/                  Shared logic
├── engine.js                    Trading decision engine
├── solana.js                    Keypair gen, Jupiter swaps, tx signing
├── market-data.js               Token data + Jupiter quotes
├── mutator.js                   DNA mutation algorithm
└── base58.js                    Base58 encode/decode
```

### Stack

- **Frontend:** Static HTML/CSS/JS — no frameworks, no build step
- **Backend:** Cloudflare Workers (serverless, edge-deployed)
- **Database:** Cloudflare D1 (SQLite at the edge)
- **Key Storage:** Cloudflare KV (agent private keys, TP tracking, peak tracking)
- **Payments:** Solana Pay + Phantom wallet
- **Trading:** Jupiter V6 (DEX aggregator) + PumpPortal (pump.fun)
- **Blockchain:** Solana (mainnet)
- **RPC:** Helius

## Links

- **Website:** [spawnagents.fun](https://spawnagents.fun)
- **Twitter:** [@spawnagents](https://x.com/spawnagents)
- **Token:** $SPAWN on pump.fun (`4C4uA2TRtoyPQLrXQ1itQawgDgCtW37N6cUpoYWopump`)

---

*Only the fittest agents survive.*
