#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Agent Bob — OpenClaw-powered Seller Agent
// Autonomously posts UCP sell intents and fulfills matched trades
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
const ORANGE = "\x1b[33m";
const GRAY   = "\x1b[90m";
const RED    = "\x1b[31m";
const MAGENTA= "\x1b[35m";

// ── Bob's Selling Strategy ─────────────────────────────────────────────────
const BOB_STRATEGY = {
  commodity: "WHEAT",
  availableQty: 10000,    // tonnes Bob has in inventory
  minPrice: 210.00,       // won't sell below $210/tonne
  targetMargin: 0.015,    // aim for 1.5% above oracle price
  ttlSeconds: 600,        // intent valid for 10 min
  maxConcurrentIntents: 3,
};

// ── Bob's State ───────────────────────────────────────────────────────────────
const bob = {
  agentId: null,
  client: null,
  latestOraclePrice: null,
  activeIntents: new Map(),
  tradesCompleted: 0,
  totalRevenue: 0,
  inventoryRemaining: BOB_STRATEGY.availableQty,
};

// ── Watch Oracle Prices ───────────────────────────────────────────────────────

function watchOraclePrices() {
  const priceTopicId = process.env.HCS_TOPIC_ORACLE_PRICES;
  if (!priceTopicId) return;

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(priceTopicId))
    .setStartTime(0);

  query.subscribe(
    Client.forTestnet(),
    null,
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const msg = JSON.parse(text);
        if (msg.msgType === "UCP_PRICE_ATTESTATION" && msg.commodity?.id === "WHEAT") {
          const prev = bob.latestOraclePrice;
          bob.latestOraclePrice = msg.price;

          const arrow = prev ? (msg.price > prev ? "↑" : msg.price < prev ? "↓" : "→") : "•";
          console.log(
            `${MAGENTA}[Bob]${RESET} 📡 Oracle WHEAT: ${YELLOW}$${msg.price}${RESET} ${arrow} ` +
            `${GRAY}| ${new Date().toLocaleTimeString()}${RESET}`
          );

          evaluateSellOpportunity(msg);
        }
      } catch (e) {}
    }
  );

  console.log(`${MAGENTA}[Bob]${RESET} Watching oracle prices on topic ${CYAN}${priceTopicId}${RESET}`);
}

// ── Watch Settlements (for completed trades) ──────────────────────────────────

function watchSettlements() {
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

        if (msg.msgType === "UCP_SETTLEMENT_DONE" && msg.sellerAgentId === bob.agentId) {
          bob.tradesCompleted++;
          bob.inventoryRemaining -= msg.quantity;
          bob.totalRevenue += parseFloat(msg.totalValue);

          console.log(`\n${GREEN}${BOLD}[Bob] ✅ TRADE SETTLED!${RESET}`);
          console.log(`  Hedera TX:      ${CYAN}${msg.hederaTxId}${RESET}`);
          console.log(`  WHEAT sold:     ${msg.quantity} tonnes @ $${msg.finalPrice}`);
          console.log(`  USD received:   ${YELLOW}$${msg.totalValue}${RESET}`);
          console.log(`  Inventory left: ${bob.inventoryRemaining} tonnes`);
          console.log(`  Total revenue:  ${YELLOW}$${bob.totalRevenue.toFixed(2)}${RESET}`);
        }
      } catch (e) {}
    }
  );
}

// ── Evaluate Sell Opportunity ─────────────────────────────────────────────────

function evaluateSellOpportunity(oracleMsg) {
  if (bob.inventoryRemaining <= 0) {
    console.log(`${MAGENTA}[Bob]${RESET} ${GRAY}No inventory left${RESET}`);
    return;
  }

  if (bob.activeIntents.size >= BOB_STRATEGY.maxConcurrentIntents) {
    console.log(`${MAGENTA}[Bob]${RESET} ${GRAY}Max concurrent intents reached (${bob.activeIntents.size})${RESET}`);
    return;
  }

  const oraclePrice = bob.latestOraclePrice;
  const askPrice = parseFloat((oraclePrice * (1 + BOB_STRATEGY.targetMargin)).toFixed(2));

  if (askPrice >= BOB_STRATEGY.minPrice) {
    console.log(
      `${MAGENTA}${BOLD}[Bob]${RESET} 🧠 Oracle $${oraclePrice} → ask $${askPrice} — posting sell intent`
    );
    postSellIntent(askPrice, oracleMsg);
  } else {
    console.log(`${MAGENTA}[Bob]${RESET} ${GRAY}Ask $${askPrice} below minimum $${BOB_STRATEGY.minPrice} — holding${RESET}`);
  }
}

// ── Post Sell Intent ──────────────────────────────────────────────────────────

async function postSellIntent(askPrice, oracleMsg) {
  const qty = Math.min(500, bob.inventoryRemaining); // offer up to 500 tonnes

  const intent = buildIntent(
    "sell",
    bob.agentId,
    BOB_STRATEGY.commodity,
    qty,
    askPrice,
    askPrice * 1.01, // max ask (1% above target)
    BOB_STRATEGY.ttlSeconds
  );

  intent.oracleAttestation = {
    attestationId: oracleMsg.attestationId,
    price: oracleMsg.price,
    signature: oracleMsg.signature,
  };

  intent.htsTokenId = process.env.HTS_WHEAT_TOKEN; // Bob provides WHEAT token
  intent.reputationScore = 4.7; // Bob's reputation (would be fetched from on-chain in prod)

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_UCP_INTENTS))
      .setMessage(JSON.stringify(intent))
      .execute(bob.client);

    const receipt = await tx.getReceipt(bob.client);
    bob.activeIntents.set(intent.intentId, intent);

    console.log(
      `${MAGENTA}${BOLD}[Bob]${RESET} ${GREEN}✓ Sell intent posted!${RESET} ` +
      `ID: ${CYAN}${intent.intentId.slice(-12)}${RESET} ` +
      `qty: ${qty}T @ $${askPrice} ` +
      `[HCS seq:${receipt.topicSequenceNumber}]`
    );

    // Expire after TTL
    setTimeout(() => {
      if (bob.activeIntents.delete(intent.intentId)) {
        console.log(`${MAGENTA}[Bob]${RESET} ${GRAY}Intent ${intent.intentId.slice(-12)} expired${RESET}`);
      }
    }, BOB_STRATEGY.ttlSeconds * 1000);

  } catch (err) {
    console.error(`${RED}[Bob] Failed to post intent:${RESET}`, err.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${MAGENTA}${BOLD}
╔═══════════════════════════════════════════════════════╗
║     Agent Bob — OpenClaw Seller Agent                 ║
║     Commodity: WHEAT | Min: $210/tonne                ║
╚═══════════════════════════════════════════════════════╝${RESET}\n`);

  if (!process.env.HCS_TOPIC_UCP_INTENTS) {
    console.error(`${RED}ERROR: Topics not set. Run: npm run setup${RESET}`);
    process.exit(1);
  }

  bob.agentId = process.env.AGENT_BOB_ID || process.env.HEDERA_OPERATOR_ID;
  const bobKey = process.env.AGENT_BOB_KEY || process.env.HEDERA_OPERATOR_KEY;

  bob.client = Client.forTestnet();
  bob.client.setOperator(
    AccountId.fromString(bob.agentId),
    PrivateKey.fromString(bobKey)
  );

  console.log(`${CYAN}${BOLD}Agent ID:${RESET}   ${bob.agentId}`);
  console.log(`${CYAN}${BOLD}Strategy:${RESET}   Sell WHEAT @ oracle + ${(BOB_STRATEGY.targetMargin * 100).toFixed(1)}% margin`);
  console.log(`${CYAN}${BOLD}Inventory:${RESET}  ${bob.inventoryRemaining.toLocaleString()} tonnes available\n`);

  watchOraclePrices();
  watchSettlements();

  console.log(`${MAGENTA}${BOLD}[Bob]${RESET} Agent active — waiting for oracle prices...\n`);
}

main().catch(err => {
  console.error(`${RED}Agent Bob crashed:${RESET}`, err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log(`\n${YELLOW}[Bob] Shutting down...${RESET}`);
  bob.client?.close();
  process.exit(0);
});
