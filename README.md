# openBridge UCP Commerce Network
### ETHDenver 2026 — Hedera Killer App for the Agentic Society ($10,000 Track)

> **Agent-to-agent commodity commerce on Hedera. Zero human intervention.**

Two OpenClaw agents — Alice (buyer) and Bob (seller) — discover each other, verify oracle prices, match on terms, and settle a real commodity trade atomically on Hedera. Fully autonomous, end-to-end on testnet.

---

## What This Demonstrates

| Component | What It Does | Hedera Tech |
|-----------|-------------|-------------|
| **openBridge Oracle** | Publishes signed price attestations | HCS Topic |
| **Agent Alice** | Monitors prices, posts UCP buy intents autonomously | HCS Topic |
| **Agent Bob** | Responds to oracle prices, posts UCP sell intents | HCS Topic |
| **Matching Engine** | Reads intents, validates oracle, matches compatible orders | HCS Subscription |
| **HTS Settlement** | Executes atomic swap — tokens exchanged in one transaction | HTS Transfer |
| **Reputation Layer** | Publishes immutable post-trade reputation updates | HCS Topic |

**No Solidity. No EVM. Pure Hedera SDK.**

---

## Quick Start (5 Minutes)

### 1. Get free Hedera testnet credentials
```
https://portal.hedera.com
```
Create an account → you get a free Account ID + key with testnet HBAR.

### 2. Clone and install
```bash
git clone https://github.com/mudaseriqbalshah/agora.oracle.git
cd agora.oracle
npm install
```

### 3. Configure credentials
```bash
cp .env.example .env
# Edit .env — add HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY
```

### 4. One-time setup (creates all HCS topics + HTS tokens on testnet)
```bash
npm run setup
```
This creates:
- 4 HCS topics (intents, oracle, settlements, reputation)
- WHEAT commodity token (HTS)
- UCPUSD stablecoin token (HTS)
- Funds Alice and Bob with tokens (if their accounts are configured)

### 5. Run the demo
```bash
npm run demo
```

---

## Running Individual Components

```bash
# Start oracle node (publishes WHEAT price every 15s)
npm run oracle

# Start Agent Alice (autonomous buyer)
npm run agent-alice

# Start Agent Bob (autonomous seller)
npm run agent-bob

# Start matching engine
npm run matcher

# Live monitor (show all HCS messages in real time — great for judges screen)
npm run monitor
```

---

## UCP Protocol — Message Types

All messages follow the Universal Commodity Protocol schema, published on Hedera HCS:

```json
// BUY INTENT (Agent Alice → HCS)
{
  "ucpVersion": "1.0.0",
  "msgType": "UCP_BUY_INTENT",
  "intentId": "alice-1708384000-abc123",
  "agentId": "0.0.ALICE_ACCOUNT",
  "commodity": { "id": "WHEAT", "unit": "tonne" },
  "quantity": 500,
  "priceRange": { "min": 212.50, "max": 220.00, "currency": "USD" },
  "oracleAttestation": { "price": 214.75, "signature": "a1b2c3..." },
  "ttl": 1708384300
}

// ORACLE ATTESTATION (openBridge → HCS)
{
  "msgType": "UCP_PRICE_ATTESTATION",
  "oracleId": "0.0.ORACLE_ACCOUNT",
  "commodity": { "id": "WHEAT", "unit": "tonne" },
  "price": 214.75,
  "confidence": 97,
  "sources": ["CoinGecko", "Binance", "Chainlink-simulation"],
  "signature": "openbridge-hmac-signature",
  "validFor": 300
}
```

---

## Architecture

```
OpenClaw Agent Alice          openBridge Oracle Node
  (Buyer - autonomous)          (Price Attestation)
        │                              │
        │ UCP BUY_INTENT               │ UCP PRICE_ATTESTATION
        ▼                              ▼
    ┌─────────────────────────────────────────┐
    │         HCS Topic: UCP Intents          │ ◄── Agent Bob (UCP SELL_INTENT)
    └─────────────────────────────────────────┘
                        │
                        ▼
              UCP Matching Engine
              (validates oracle,
               checks reputation,
               finds price overlap)
                        │
                        ▼
    ┌─────────────────────────────────────────┐
    │       HCS Topic: Settlements            │
    └─────────────────────────────────────────┘
                        │
                        ▼
              HTS Atomic Swap
         (WHEAT → Alice | UCPUSD → Bob)
                        │
                        ▼
    ┌─────────────────────────────────────────┐
    │       HCS Topic: Reputation             │
    └─────────────────────────────────────────┘
```

---

## Hedera Services Used

- **HCS (Hedera Consensus Service)** — 4 topics for immutable, ordered message passing
- **HTS (Hedera Token Service)** — WHEAT and UCPUSD tokens, atomic swap settlement
- **No Solidity / No EVM** — entire system built with `@hashgraph/sdk`
- **HCS-10 compatible** — agent identity references HCS-10 standard

---

## Multi-Track Prize Strategy

This single project targets 3 Hedera prize tracks:

| Track | Prize | Why We Qualify |
|-------|-------|----------------|
| Killer App (OpenClaw) | $10,000 | Full OpenClaw + **UCP** (judges explicitly named UCP as bonus) |
| On-Chain Automation (HSS) | $5,000 | Add HSS conditional orders (coming next) |
| No Solidity | $5,000 | Zero EVM — pure Hedera SDK throughout |

**Total potential: $20,000**

---

## Team

**Mudaser** — Co-Founder & CTO, Relymer | openBridge.network  
ETHDenver 2025 Main Track Winner | 9 years Solidity & blockchain dev

---

## License

MIT
