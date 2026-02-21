#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// openBridge Oracle Node
// Publishes signed commodity price attestations to Hedera HCS
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from "dotenv";
import { Client, AccountId, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import { buildOracleAttestation } from "./ucp-types.js";
import { createHash } from "crypto";

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
const PURPLE = "\x1b[35m";
const GRAY   = "\x1b[90m";

// ── Simulated Market Prices (realistic 2026 commodity prices) ────────────────
// In a real deployment, these fetch from CoinGecko/Chainlink/external APIs

const BASE_PRICES = {
  WHEAT: 215.50,   // $/tonne
  CORN:  178.25,   // $/bushel
  GOLD:  2850.00,  // $/oz
  CRUDE: 82.40,    // $/barrel
  HBAR:  0.087,    // $/HBAR
};

// Add slight random drift each cycle to simulate live market
function simulatePrice(commodity, basePrice, volatility = 0.005) {
  const drift = (Math.random() - 0.48) * volatility * basePrice;
  return parseFloat((basePrice + drift).toFixed(commodity === "HBAR" ? 5 : 2));
}

// ── Oracle State ─────────────────────────────────────────────────────────────

const state = {
  prices: { ...BASE_PRICES },
  attestationCount: 0,
  topicId: null,
  client: null,
  oracleId: null,
};

// ── Sign attestation with oracle's key (HMAC-SHA256) ─────────────────────────

function signAttestation(attestation, privateKeyHex) {
  const payload = JSON.stringify({
    oracleId: attestation.oracleId,
    commodity: attestation.commodity.id,
    price: attestation.price,
    timestamp: attestation.timestamp,
  });
  const hmac = createHash("sha256")
    .update(payload + privateKeyHex.slice(0, 32))
    .digest("hex")
    .slice(0, 32);
  return hmac;
}

// ── Publish Price Attestation ────────────────────────────────────────────────

async function publishAttestation(commodity) {
  const price = simulatePrice(commodity, state.prices[commodity]);
  state.prices[commodity] = price; // update running price

  const attestation = buildOracleAttestation(
    state.oracleId,
    commodity,
    price,
    96 + Math.floor(Math.random() * 4) // 96-99% confidence
  );

  // Sign the attestation
  attestation.signature = signAttestation(attestation, process.env.HEDERA_OPERATOR_KEY || "demo");
  attestation.nodeVersion = "openBridge-v1.0.0";

  const msgJson = JSON.stringify(attestation);

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(state.topicId))
      .setMessage(msgJson)
      .execute(state.client);

    const receipt = await tx.getReceipt(state.client);
    state.attestationCount++;

    const seqNum = receipt.topicSequenceNumber?.toString() ?? "?";
    console.log(
      `${GREEN}✓${RESET} ${BOLD}${commodity}${RESET} ${YELLOW}$${price}${RESET}/` +
      `${attestation.commodity.unit} ` +
      `${GRAY}[seq:${seqNum}]${RESET} ` +
      `${GRAY}conf:${attestation.confidence}% | ${new Date().toLocaleTimeString()}${RESET}`
    );
    return attestation;
  } catch (err) {
    console.error(`${BOLD}\x1b[31m✗ Oracle publish failed:${RESET}`, err.message);
  }
}

// ── Main Oracle Loop ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${PURPLE}${BOLD}
╔═══════════════════════════════════════════════════════╗
║     openBridge Oracle Node v1.0.0                     ║
║     Publishing price attestations to Hedera HCS       ║
╚═══════════════════════════════════════════════════════╝${RESET}\n`);

  if (!process.env.HEDERA_OPERATOR_ID || !process.env.HEDERA_OPERATOR_KEY) {
    console.error("\x1b[31mERROR: Missing Hedera credentials in .env\x1b[0m");
    process.exit(1);
  }

  if (!process.env.HCS_TOPIC_ORACLE_PRICES) {
    console.error("\x1b[31mERROR: HCS_TOPIC_ORACLE_PRICES not set. Run: npm run setup\x1b[0m");
    process.exit(1);
  }

  state.topicId = process.env.HCS_TOPIC_ORACLE_PRICES;
  state.oracleId = process.env.ORACLE_NODE_ID || process.env.HEDERA_OPERATOR_ID;

  state.client = Client.forTestnet();
  state.client.setOperator(
    AccountId.fromString(process.env.HEDERA_OPERATOR_ID),
    parsePrivateKey(process.env.HEDERA_OPERATOR_KEY)
  );

  console.log(`${CYAN}${BOLD}Oracle ID:${RESET}     ${state.oracleId}`);
  console.log(`${CYAN}${BOLD}HCS Topic:${RESET}     ${state.topicId}`);
  console.log(`${CYAN}${BOLD}Hashscan:${RESET}      https://hashscan.io/testnet/topic/${state.topicId}`);
  console.log(`\n${CYAN}${BOLD}Commodity prices (initial):${RESET}`);
  for (const [c, p] of Object.entries(BASE_PRICES)) {
    console.log(`  ${YELLOW}${c.padEnd(6)}${RESET}  $${p}`);
  }

  console.log(`\n${CYAN}${BOLD}━━━ Publishing Attestations (every 15s) ━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${GRAY}  Format: ✓ COMMODITY $PRICE/unit [seq:N] conf:X%${RESET}\n`);

  // Publish all commodities immediately on start
  for (const commodity of Object.keys(BASE_PRICES)) {
    await publishAttestation(commodity);
    await sleep(300);
  }

  // Then publish on interval (WHEAT most frequently — it's our demo commodity)
  setInterval(async () => {
    await publishAttestation("WHEAT");
  }, 15_000);

  setInterval(async () => {
    for (const commodity of ["CORN", "GOLD", "CRUDE", "HBAR"]) {
      await publishAttestation(commodity);
      await sleep(500);
    }
  }, 60_000);

  // Stats every 2 minutes
  setInterval(() => {
    console.log(`\n${GRAY}━━ Oracle Stats ━━ Attestations: ${state.attestationCount} | ` +
      `Uptime: ${Math.floor(process.uptime() / 60)}m ━━${RESET}\n`);
  }, 120_000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error("\x1b[31mOracle node crashed:\x1b[0m", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\n\x1b[33mOracle node shutting down gracefully...\x1b[0m");
  state.client?.close();
  process.exit(0);
});
