#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Agent Alice — OpenClaw-powered Buyer Agent
// Autonomously monitors oracle prices and posts UCP buy intents
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from "dotenv";
import {
  Client, AccountId, PrivateKey, TopicId,
  TopicMessageSubmitTransaction, TopicMessageQuery
} from "@hashgraph/sdk";
import { buildIntent, MSG_TYPES } from "./ucp-types.js";

// ── Smart key parser (handles DER, raw hex, ED25519, ECDSA) ──────────────────
function parsePrivateKey(rawKey) {
  const clean = (rawKey || '').replace('0x', '').trim();
  const t = process.env.HEDERA_KEY_TYPE;
  const parsers = t === 'ECDSA'
    ? [() => PrivateKey.fromStringECDSA(clean), () => PrivateKey.fromString(clean)]
    : t === 'ED25519'
    ? [() => PrivateKey.fromStringED25519(clean), () => PrivateKey.fromStringDer(clean), () => PrivateKey.fromString(clean)]
    : [() => PrivateKey.fromStringDer(clean), () => PrivateKey.fromString(clean),
       () => PrivateKey.fromStringED25519(clean), () => PrivateKey.fromStringECDSA(clean)];
  for (const p of parsers) { try { return p(); } catch(e) {} }
  throw new Error('Cannot parse private key. Run: node scripts/fix-key.js to diagnose.');
}


dotenv.config();

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const BLUE   = "\x1b[34m";
const GRAY   = "\x1b[90m";
const RED    = "\x1b[31m";

// ── Alice's Portfolio Goal (AI-set strategy) ─────────────────────────────────
const ALICE_STRATEGY = {
  commodity: "WHEAT",
  targetQty: 500,           // tonnes
  maxPrice: 220.00,         // won't buy above $220/tonne
  minOracleConfidence: 90,  // require at least 90% confidence
  ttlSeconds: 300,          // intent expires in 5 minutes
  reputation_threshold: 3.5 // min counterparty reputation score
};

// ── Alice's State ─────────────────────────────────────────────────────────────
const alice = {
  agentId: null,
  client: null,
  latestOraclePrice: null,
  latestOracleAttestation: null,
  activeIntentId: null,
  tradesCompleted: 0,
  intentCount: 0,
};

// ── Subscribe to Oracle Prices ────────────────────────────────────────────────

function watchOraclePrices() {
  const priceTopicId = process.env.HCS_TOPIC_ORACLE_PRICES;
  if (!priceTopicId) return;

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(priceTopicId))
    .setStartTime(0);

  query.subscribe(
    Client.forTestnet(),
    (err) => { if (err) console.error("[Alice] Oracle subscription error:", err.message); },
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const msg = JSON.parse(text);
        if (msg.msgType === "UCP_PRICE_ATTESTATION" && msg.commodity?.id === "WHEAT") {
          const prev = alice.latestOraclePrice;
          alice.latestOraclePrice = msg.price;
          alice.latestOracleAttestation = msg;

          const arrow = prev ? (msg.price > prev ? "↑" : msg.price < prev ? "↓" : "→") : "•";
          console.log(
            `${BLUE}[Alice]${RESET} 📡 Oracle WHEAT: ${YELLOW}$${msg.price}${RESET} ${arrow} ` +
            `${GRAY}conf:${msg.confidence}% | ${new Date().toLocaleTimeString()}${RESET}`
          );

          // Evaluate if Alice should post a buy intent
          evaluateBuyOpportunity();
        }
      } catch (e) {}
    }
  );

  console.log(`${BLUE}[Alice]${RESET} Watching oracle prices on topic ${CYAN}${priceTopicId}${RESET}`);
}

// ── Watch for Match Proposals ──────────────────────────────────────────────────

function watchForMatches() {
  const settleTopicId = process.env.HCS_TOPIC_SETTLEMENTS;
  if (!settleTopicId) return;

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(settleTopicId))
    .setStartTime(0);

  query.subscribe(
    Client.forTestnet(),
    null,
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const msg = JSON.parse(text);
        if (msg.msgType === "UCP_MATCH_PROPOSAL" && msg.buyerAgentId === alice.agentId) {
          console.log(`\n${GREEN}${BOLD}[Alice] 🎯 MATCH FOUND!${RESET}`);
          console.log(`  Match ID:    ${CYAN}${msg.matchId}${RESET}`);
          console.log(`  Seller:      ${msg.sellerAgentId}`);
          console.log(`  Agreed Price:${YELLOW} $${msg.agreedPrice}/tonne${RESET}`);
          console.log(`  Quantity:    ${msg.quantity} tonnes`);
          console.log(`  Total Value: ${YELLOW}$${(msg.agreedPrice * msg.quantity).toFixed(2)}${RESET}`);

          // Auto-accept the match (Alice's AI logic)
          acceptMatch(msg);
        }
        if (msg.msgType === "UCP_SETTLEMENT_DONE" && msg.buyerAgentId === alice.agentId) {
          alice.tradesCompleted++;
          console.log(`\n${GREEN}${BOLD}[Alice] ✅ TRADE SETTLED ON-CHAIN!${RESET}`);
          console.log(`  Hedera TX:   ${CYAN}${msg.hederaTxId}${RESET}`);
          console.log(`  WHEAT received: ${msg.quantity} tonnes`);
          console.log(`  USD paid:       $${msg.totalValue}`);
          console.log(`  Trades done:    ${alice.tradesCompleted}`);
          alice.activeIntentId = null;
        }
      } catch (e) {}
    }
  );
}

// ── Core Logic: Evaluate Buy Opportunity ─────────────────────────────────────

function evaluateBuyOpportunity() {
  if (!alice.latestOraclePrice) return;
  if (alice.activeIntentId) return; // already have active intent

  const price = alice.latestOraclePrice;
  const confidence = alice.latestOracleAttestation?.confidence ?? 0;

  if (price <= ALICE_STRATEGY.maxPrice && confidence >= ALICE_STRATEGY.minOracleConfidence) {
    console.log(
      `${BLUE}${BOLD}[Alice]${RESET} 🧠 Price $${price} is under target $${ALICE_STRATEGY.maxPrice} — posting buy intent`
    );
    postBuyIntent(price);
  } else {
    const reasons = [];
    if (price > ALICE_STRATEGY.maxPrice) reasons.push(`price $${price} > max $${ALICE_STRATEGY.maxPrice}`);
    if (confidence < ALICE_STRATEGY.minOracleConfidence) reasons.push(`confidence ${confidence}% < threshold`);
    console.log(`${BLUE}[Alice]${RESET} ${GRAY}Holding — ${reasons.join(", ")}${RESET}`);
  }
}

// ── Post Buy Intent to HCS ────────────────────────────────────────────────────

async function postBuyIntent(currentPrice) {
  const intent = buildIntent(
    "buy",
    alice.agentId,
    ALICE_STRATEGY.commodity,
    ALICE_STRATEGY.targetQty,
    currentPrice * 0.99,   // bid slightly below oracle
    ALICE_STRATEGY.maxPrice,
    ALICE_STRATEGY.ttlSeconds
  );

  intent.oracleAttestation = {
    attestationId: alice.latestOracleAttestation?.attestationId,
    price: alice.latestOraclePrice,
    signature: alice.latestOracleAttestation?.signature,
  };

  intent.reputationRequirement = ALICE_STRATEGY.reputation_threshold;
  intent.htsTokenId = process.env.HTS_USD_TOKEN; // Alice pays in UCPUSD

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_UCP_INTENTS))
      .setMessage(JSON.stringify(intent))
      .execute(alice.client);

    const receipt = await tx.getReceipt(alice.client);
    alice.activeIntentId = intent.intentId;
    alice.intentCount++;

    console.log(
      `${BLUE}${BOLD}[Alice]${RESET} ${GREEN}✓ Buy intent posted!${RESET} ` +
      `ID: ${CYAN}${intent.intentId.slice(-12)}${RESET} ` +
      `qty: ${ALICE_STRATEGY.targetQty}T @ max $${ALICE_STRATEGY.maxPrice} ` +
      `[HCS seq:${receipt.topicSequenceNumber}]`
    );

    // Auto-expire after TTL
    setTimeout(() => {
      if (alice.activeIntentId === intent.intentId) {
        console.log(`${BLUE}[Alice]${RESET} ${GRAY}Intent ${intent.intentId.slice(-12)} expired${RESET}`);
        alice.activeIntentId = null;
      }
    }, ALICE_STRATEGY.ttlSeconds * 1000);

  } catch (err) {
    console.error(`${RED}[Alice] Failed to post intent:${RESET}`, err.message);
  }
}

// ── Accept a Match ────────────────────────────────────────────────────────────

async function acceptMatch(matchProposal) {
  const acceptance = {
    msgType: MSG_TYPES.MATCH_ACCEPT,
    matchId: matchProposal.matchId,
    buyerAgentId: alice.agentId,
    acceptedPrice: matchProposal.agreedPrice,
    timestamp: new Date().toISOString(),
  };

  try {
    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_SETTLEMENTS))
      .setMessage(JSON.stringify(acceptance))
      .execute(alice.client);

    console.log(`${BLUE}[Alice]${RESET} ${GREEN}✓ Match accepted${RESET} — awaiting settlement...`);
  } catch (err) {
    console.error(`${RED}[Alice] Failed to accept match:${RESET}`, err.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BLUE}${BOLD}
╔═══════════════════════════════════════════════════════╗
║     Agent Alice — OpenClaw Buyer Agent                ║
║     Commodity: WHEAT | Max: $220/tonne                ║
╚═══════════════════════════════════════════════════════╝${RESET}\n`);

  if (!process.env.HCS_TOPIC_UCP_INTENTS) {
    console.error(`${RED}ERROR: Topics not set. Run: npm run setup${RESET}`);
    process.exit(1);
  }

  // Use operator as Alice if no dedicated account
  alice.agentId = process.env.AGENT_ALICE_ID || process.env.HEDERA_OPERATOR_ID;
  const aliceKey = process.env.AGENT_ALICE_KEY || process.env.HEDERA_OPERATOR_KEY;

  alice.client = Client.forTestnet();
  alice.client.setOperator(
    AccountId.fromString(alice.agentId),
    PrivateKey.fromString(aliceKey)
  );

  console.log(`${CYAN}${BOLD}Agent ID:${RESET}  ${alice.agentId}`);
  console.log(`${CYAN}${BOLD}Strategy:${RESET}  Buy ${ALICE_STRATEGY.targetQty}T WHEAT @ max $${ALICE_STRATEGY.maxPrice}`);
  console.log(`${CYAN}${BOLD}Topics:${RESET}`);
  console.log(`  Intents:   ${CYAN}${process.env.HCS_TOPIC_UCP_INTENTS}${RESET}`);
  console.log(`  Prices:    ${CYAN}${process.env.HCS_TOPIC_ORACLE_PRICES}${RESET}`);
  console.log(`  Settle:    ${CYAN}${process.env.HCS_TOPIC_SETTLEMENTS}${RESET}`);
  console.log(`\n${BLUE}${BOLD}[Alice]${RESET} Agent active — watching for trading opportunities...\n`);

  watchOraclePrices();
  watchForMatches();
}

main().catch(err => {
  console.error(`${RED}Agent Alice crashed:${RESET}`, err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log(`\n${YELLOW}[Alice] Shutting down...${RESET}`);
  alice.client?.close();
  process.exit(0);
});
