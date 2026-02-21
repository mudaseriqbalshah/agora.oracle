#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// UCP Matching Engine
// Subscribes to HCS intent topic, matches buy/sell orders, executes HTS atomic swap
// This is the core of the openBridge UCP Commerce Network
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from "dotenv";
import {
  Client, AccountId, PrivateKey, TokenId, TopicId,
  TopicMessageSubmitTransaction, TopicMessageQuery,
  TransferTransaction,
} from "@hashgraph/sdk";
import { buildMatchProposal, buildSettlementRecord, MSG_TYPES } from "./ucp-types.js";

dotenv.config();

// ── Smart key parser (handles DER, raw hex, ED25519, ECDSA) ──────────────────
function parsePrivateKey(rawKey) {
  const clean = (rawKey || "").replace("0x", "").trim();
  const t = process.env.HEDERA_KEY_TYPE;
  const parsers = t === "ECDSA"
    ? [() => PrivateKey.fromStringECDSA(clean), () => PrivateKey.fromString(clean)]
    : t === "ED25519"
    ? [() => PrivateKey.fromStringED25519(clean), () => PrivateKey.fromStringDer(clean), () => PrivateKey.fromString(clean)]
    : [() => PrivateKey.fromStringDer(clean), () => PrivateKey.fromString(clean),
       () => PrivateKey.fromStringED25519(clean), () => PrivateKey.fromStringECDSA(clean)];
  for (const p of parsers) { try { return p(); } catch(e) {} }
  throw new Error("Cannot parse private key. Run: node scripts/fix-key.js");
}


const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GRAY   = "\x1b[90m";
const RED    = "\x1b[31m";
const WHITE  = "\x1b[37m";
const BG_GREEN = "\x1b[42m";

// ── Engine State ─────────────────────────────────────────────────────────────

const engine = {
  client: null,
  buyIntents: new Map(),    // intentId → intent
  sellIntents: new Map(),
  latestOraclePrices: {},   // commodity → { price, attestation }
  matchesExecuted: 0,
  settlementsPending: new Map(),
};

// ── Subscribe to UCP Intents ──────────────────────────────────────────────────

function subscribeToIntents() {
  const topicId = process.env.HCS_TOPIC_UCP_INTENTS;

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(topicId))
    .setStartTime(0);

  query.subscribe(
    Client.forTestnet(),
    (err) => { if (err) console.error("[Engine] Intent subscription error:", err.message); },
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const msg = JSON.parse(text);
        handleIntent(msg);
      } catch (e) {}
    }
  );

  console.log(`[Engine] Watching intents on ${CYAN}${topicId}${RESET}`);
}

// ── Subscribe to Oracle Prices ────────────────────────────────────────────────

function subscribeToOracle() {
  const topicId = process.env.HCS_TOPIC_ORACLE_PRICES;
  if (!topicId) return;

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(topicId))
    .setStartTime(0);

  query.subscribe(
    Client.forTestnet(),
    null,
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const msg = JSON.parse(text);
        if (msg.msgType === "UCP_PRICE_ATTESTATION") {
          engine.latestOraclePrices[msg.commodity.id] = {
            price: msg.price,
            attestation: msg,
            updatedAt: Date.now(),
          };
        }
      } catch (e) {}
    }
  );
}

// ── Handle Incoming Intent ────────────────────────────────────────────────────

function handleIntent(msg) {
  const now = Math.floor(Date.now() / 1000);

  // Filter expired intents
  if (msg.ttl && msg.ttl < now) {
    console.log(`${GRAY}[Engine] Skipping expired intent ${msg.intentId?.slice(-8)}${RESET}`);
    return;
  }

  if (msg.msgType === MSG_TYPES.BUY_INTENT) {
    engine.buyIntents.set(msg.intentId, msg);
    console.log(
      `[Engine] ${CYAN}BUY ${RESET}intent received from ${msg.agentId?.slice(-8)}` +
      ` — ${msg.quantity} ${msg.commodity?.id} @ max $${msg.priceRange?.max}`
    );
    tryMatch(msg.intentId, "buy");

  } else if (msg.msgType === MSG_TYPES.SELL_INTENT) {
    engine.sellIntents.set(msg.intentId, msg);
    console.log(
      `[Engine] ${YELLOW}SELL${RESET} intent received from ${msg.agentId?.slice(-8)}` +
      ` — ${msg.quantity} ${msg.commodity?.id} @ $${msg.priceRange?.min}`
    );
    tryMatch(msg.intentId, "sell");

  } else if (msg.msgType === MSG_TYPES.INTENT_CANCEL) {
    engine.buyIntents.delete(msg.intentId);
    engine.sellIntents.delete(msg.intentId);
    console.log(`${GRAY}[Engine] Intent ${msg.intentId?.slice(-8)} cancelled${RESET}`);
  }
}

// ── Matching Algorithm ────────────────────────────────────────────────────────

function tryMatch(newIntentId, side) {
  const now = Math.floor(Date.now() / 1000);

  for (const [buyId, buy] of engine.buyIntents.entries()) {
    for (const [sellId, sell] of engine.sellIntents.entries()) {

      // Skip expired
      if (buy.ttl < now || sell.ttl < now) continue;

      // Must be same commodity
      if (buy.commodity?.id !== sell.commodity?.id) continue;

      // Price compatibility: buyer's max >= seller's min
      if (buy.priceRange?.max < sell.priceRange?.min) continue;

      // Quantity compatibility (partial fills allowed — use min)
      const matchQty = Math.min(buy.quantity, sell.quantity);
      if (matchQty <= 0) continue;

      // Check oracle attestation freshness (must be < 5 min old)
      const commodityId = buy.commodity.id;
      const oracleData = engine.latestOraclePrices[commodityId];
      if (!oracleData || (Date.now() - oracleData.updatedAt) > 300_000) {
        console.log(`${GRAY}[Engine] No fresh oracle price for ${commodityId} — waiting${RESET}`);
        continue;
      }

      // Reputation check
      const sellerRep = sell.reputationScore ?? 5.0;
      const requiredRep = buy.reputation_threshold ?? 0;
      if (sellerRep < requiredRep) {
        console.log(`${GRAY}[Engine] Seller rep ${sellerRep} < required ${requiredRep}${RESET}`);
        continue;
      }

      // Determine agreed price (midpoint of buy max and sell min)
      const agreedPrice = parseFloat(
        ((buy.priceRange.max + sell.priceRange.min) / 2).toFixed(2)
      );

      // We have a match!
      executeMatch(buy, sell, agreedPrice, matchQty, oracleData);

      // Remove from active pools
      engine.buyIntents.delete(buyId);
      engine.sellIntents.delete(sellId);
      return;
    }
  }
}

// ── Execute Match ─────────────────────────────────────────────────────────────

async function executeMatch(buyIntent, sellIntent, agreedPrice, qty, oracleData) {
  engine.matchesExecuted++;

  const matchProposal = buildMatchProposal(
    buyIntent.intentId,
    sellIntent.intentId,
    agreedPrice,
    qty,
    buyIntent.agentId,
    sellIntent.agentId
  );
  matchProposal.oracleAttestation = oracleData.attestation;

  console.log(`\n${BG_GREEN}${WHITE}${BOLD} ⚡ MATCH FOUND — Executing Settlement ` +
    `#${engine.matchesExecuted} ${RESET}`);
  console.log(`  Buyer:    ${CYAN}${buyIntent.agentId}${RESET}`);
  console.log(`  Seller:   ${CYAN}${sellIntent.agentId}${RESET}`);
  console.log(`  Commodity:${YELLOW} ${qty} tonnes WHEAT${RESET}`);
  console.log(`  Price:    ${YELLOW}$${agreedPrice}/tonne${RESET}`);
  console.log(`  Total:    ${YELLOW}$${(agreedPrice * qty).toFixed(2)}${RESET}`);
  console.log(`  Oracle:   $${oracleData.price} (${oracleData.attestation?.confidence}% conf)\n`);

  // Publish match proposal to settlements topic
  await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_SETTLEMENTS))
    .setMessage(JSON.stringify(matchProposal))
    .execute(engine.client);

  // Execute HTS Atomic Swap
  await executeAtomicSwap(matchProposal, buyIntent, sellIntent, qty, agreedPrice);
}

// ── HTS Atomic Swap ───────────────────────────────────────────────────────────

async function executeAtomicSwap(matchProposal, buyIntent, sellIntent, qty, price) {
  const wheatTokenId = process.env.HTS_WHEAT_TOKEN;
  const usdTokenId   = process.env.HTS_USD_TOKEN;

  if (!wheatTokenId || !usdTokenId) {
    console.log(`${YELLOW}[Engine] Token IDs not set — simulating settlement${RESET}`);
    await simulateSettlement(matchProposal, buyIntent, sellIntent, qty, price);
    return;
  }

  const wheatAmount = qty * 1000; // 3 decimals
  const usdAmount   = Math.round(qty * price * 100); // 2 decimals

  console.log(`[Engine] Executing HTS atomic swap...`);
  console.log(`  WHEAT: ${sellIntent.agentId} → ${buyIntent.agentId} (${qty} tonnes)`);
  console.log(`  UCPUSD: ${buyIntent.agentId} → ${sellIntent.agentId} ($${(usdAmount/100).toFixed(2)})`);

  try {
    const tx = await new TransferTransaction()
      // Seller sends WHEAT to Buyer
      .addTokenTransfer(wheatTokenId, AccountId.fromString(sellIntent.agentId), -wheatAmount)
      .addTokenTransfer(wheatTokenId, AccountId.fromString(buyIntent.agentId),  +wheatAmount)
      // Buyer sends USD to Seller
      .addTokenTransfer(usdTokenId, AccountId.fromString(buyIntent.agentId),  -usdAmount)
      .addTokenTransfer(usdTokenId, AccountId.fromString(sellIntent.agentId), +usdAmount)
      .execute(engine.client);

    const receipt = await tx.getReceipt(engine.client);
    const txId = tx.transactionId?.toString();

    console.log(`${GREEN}${BOLD}[Engine] ✅ Atomic swap complete!${RESET}`);
    console.log(`  TX ID:  ${CYAN}${txId}${RESET}`);
    console.log(`  Status: ${GREEN}${receipt.status}${RESET}`);
    console.log(`  View:   ${CYAN}https://hashscan.io/testnet/transaction/${txId?.replace("@","/")}${RESET}\n`);

    // Publish settlement record to HCS
    const settlement = buildSettlementRecord(
      matchProposal.matchId, txId,
      buyIntent.agentId, sellIntent.agentId,
      "WHEAT", qty, price
    );
    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_SETTLEMENTS))
      .setMessage(JSON.stringify(settlement))
      .execute(engine.client);

    // Reputation updates
    await updateReputation(buyIntent.agentId, "completed", qty * price);
    await updateReputation(sellIntent.agentId, "completed", qty * price);

  } catch (err) {
    console.error(`${RED}[Engine] Atomic swap failed:${RESET}`, err.message);
    console.log(`${YELLOW}[Engine] Falling back to simulated settlement${RESET}`);
    await simulateSettlement(matchProposal, buyIntent, sellIntent, qty, price);
  }
}

// ── Simulated Settlement (when tokens not configured) ────────────────────────

async function simulateSettlement(matchProposal, buyIntent, sellIntent, qty, price) {
  const fakeTxId = `0.0.0@${Math.floor(Date.now()/1000)}.${Math.floor(Math.random()*1e9)}`;

  const settlement = buildSettlementRecord(
    matchProposal.matchId,
    fakeTxId,
    buyIntent.agentId,
    sellIntent.agentId,
    "WHEAT", qty, price
  );
  settlement.simulated = true;

  await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_SETTLEMENTS))
    .setMessage(JSON.stringify(settlement))
    .execute(engine.client);

  console.log(`${YELLOW}[Engine] ⚡ Simulated settlement published to HCS${RESET}`);
  console.log(`  Fake TX: ${fakeTxId}`);
}

// ── Reputation Update ─────────────────────────────────────────────────────────

async function updateReputation(agentId, outcome, tradeValue) {
  const update = {
    msgType: MSG_TYPES.REPUTATION_UPDATE,
    agentId,
    outcome,
    tradeValue: tradeValue.toFixed(2),
    timestamp: new Date().toISOString(),
  };

  try {
    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(process.env.HCS_TOPIC_REPUTATION))
      .setMessage(JSON.stringify(update))
      .execute(engine.client);
  } catch (e) {}
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${GREEN}${BOLD}
╔═══════════════════════════════════════════════════════╗
║     UCP Matching Engine v1.0.0                        ║
║     openBridge Commerce Network — Hedera Testnet      ║
╚═══════════════════════════════════════════════════════╝${RESET}\n`);

  if (!process.env.HEDERA_OPERATOR_ID || !process.env.HCS_TOPIC_UCP_INTENTS) {
    console.error(`${RED}ERROR: Missing credentials or topics. Run: npm run setup${RESET}`);
    process.exit(1);
  }

  engine.client = Client.forTestnet();
  engine.client.setOperator(
    AccountId.fromString(process.env.HEDERA_OPERATOR_ID),
    parsePrivateKey(process.env.HEDERA_OPERATOR_KEY)
  );

  console.log(`${CYAN}${BOLD}Operator:${RESET}  ${process.env.HEDERA_OPERATOR_ID}`);
  console.log(`${CYAN}${BOLD}Topics:${RESET}`);
  console.log(`  Intents:     ${CYAN}${process.env.HCS_TOPIC_UCP_INTENTS}${RESET}`);
  console.log(`  Oracle:      ${CYAN}${process.env.HCS_TOPIC_ORACLE_PRICES}${RESET}`);
  console.log(`  Settlements: ${CYAN}${process.env.HCS_TOPIC_SETTLEMENTS}${RESET}`);
  console.log(`  Reputation:  ${CYAN}${process.env.HCS_TOPIC_REPUTATION}${RESET}`);
  console.log(`\n[Engine] Matching engine active — watching for intents...\n`);

  subscribeToOracle();
  subscribeToIntents();

  // Periodic stats
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const activeBuys  = [...engine.buyIntents.values()].filter(i => i.ttl > now).length;
    const activeSells = [...engine.sellIntents.values()].filter(i => i.ttl > now).length;
    console.log(
      `${GRAY}[Engine] Stats — Active: ${activeBuys} buys, ${activeSells} sells | ` +
      `Matches: ${engine.matchesExecuted} | ` +
      `Oracle prices: ${Object.keys(engine.latestOraclePrices).length} commodities${RESET}`
    );
  }, 30_000);
}

main().catch(err => {
  console.error(`${RED}Matching engine crashed:${RESET}`, err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log(`\n${YELLOW}[Engine] Shutting down...${RESET}`);
  engine.client?.close();
  process.exit(0);
});
