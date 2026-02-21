#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// openBridge Key Diagnostics
// Figures out the correct key format and tests a real transaction
// Usage: node scripts/fix-key.js
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from "dotenv";
import {
  Client, AccountId, PrivateKey,
  AccountBalanceQuery,
  TopicCreateTransaction,
  Hbar,
} from "@hashgraph/sdk";

dotenv.config();

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const GRAY   = "\x1b[90m";

function log(color, label, msg) {
  console.log(`${color}${BOLD}[${label}]${RESET} ${msg}`);
}

async function tryKey(label, privateKey, accountId) {
  try {
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(accountId), privateKey);
    client.setDefaultMaxTransactionFee(new Hbar(5));

    // First just check balance (no signature needed)
    const balance = await new AccountBalanceQuery()
      .setAccountId(AccountId.fromString(accountId))
      .execute(client);

    console.log(`  ${GREEN}✓${RESET} Account found — Balance: ${YELLOW}${balance.hbars}${RESET}`);

    // Now try a real signed transaction
    process.stdout.write(`  Testing signature with ${label}... `);
    const tx = await new TopicCreateTransaction()
      .setTopicMemo("openbridge-key-test")
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const topicId = receipt.topicId?.toString();

    console.log(`${GREEN}✓ SIGNATURE VALID!${RESET}`);
    console.log(`  Test topic created: ${CYAN}${topicId}${RESET}`);
    client.close();
    return { success: true, topicId, privateKey };
  } catch (err) {
    console.log(`${RED}✗ ${err.message.slice(0, 80)}${RESET}`);
    return { success: false };
  }
}

async function main() {
  console.log(`\n${CYAN}${BOLD}
╔════════════════════════════════════════════════════╗
║   openBridge Key Diagnostics                       ║
╚════════════════════════════════════════════════════╝${RESET}\n`);

  const accountId = process.env.HEDERA_OPERATOR_ID;
  const rawKey    = process.env.HEDERA_OPERATOR_KEY;

  if (!accountId || !rawKey) {
    log(RED, "ERROR", "Missing HEDERA_OPERATOR_ID or HEDERA_OPERATOR_KEY in .env");
    process.exit(1);
  }

  console.log(`${CYAN}${BOLD}Account ID:${RESET} ${accountId}`);
  console.log(`${CYAN}${BOLD}Raw key:${RESET}    ${rawKey.slice(0, 20)}...${rawKey.slice(-8)} (${rawKey.length} chars)\n`);

  // Detect key format
  const isDer   = rawKey.startsWith("302e") || rawKey.startsWith("3030") || rawKey.startsWith("302c");
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(rawKey);
  const isHex96 = /^[0-9a-fA-F]{96}$/.test(rawKey);
  const hasPrefix = rawKey.includes("0x");
  const cleanKey  = rawKey.replace("0x", "");

  console.log(`${CYAN}${BOLD}Key format detection:${RESET}`);
  console.log(`  Length: ${rawKey.length} characters`);
  console.log(`  DER encoded (302e...): ${isDer ? GREEN+"YES"+RESET : GRAY+"no"+RESET}`);
  console.log(`  Raw hex 64 chars:      ${isHex64 ? GREEN+"YES"+RESET : GRAY+"no"+RESET}`);
  console.log(`  Raw hex 96 chars:      ${isHex96 ? GREEN+"YES"+RESET : GRAY+"no"+RESET}`);
  console.log(`  Has 0x prefix:         ${hasPrefix ? YELLOW+"YES (will strip)"+RESET : GRAY+"no"+RESET}`);
  console.log("");

  // Build list of key parsing attempts to try
  const attempts = [];

  if (isDer) {
    attempts.push(["fromStringDer (DER hex)", () => PrivateKey.fromStringDer(cleanKey)]);
    attempts.push(["fromString (auto-detect)", () => PrivateKey.fromString(cleanKey)]);
    attempts.push(["fromStringED25519", () => PrivateKey.fromStringED25519(cleanKey)]);
    attempts.push(["fromStringECDSA", () => PrivateKey.fromStringECDSA(cleanKey)]);
  } else if (isHex64 || isHex96) {
    attempts.push(["fromStringED25519 (raw hex)", () => PrivateKey.fromStringED25519(cleanKey)]);
    attempts.push(["fromString (auto-detect)",    () => PrivateKey.fromString(cleanKey)]);
    attempts.push(["fromStringECDSA (raw hex)",   () => PrivateKey.fromStringECDSA(cleanKey)]);
  } else {
    // Try all
    attempts.push(["fromString (auto-detect)", () => PrivateKey.fromString(cleanKey)]);
    attempts.push(["fromStringDer",            () => PrivateKey.fromStringDer(cleanKey)]);
    attempts.push(["fromStringED25519",        () => PrivateKey.fromStringED25519(cleanKey)]);
    attempts.push(["fromStringECDSA",          () => PrivateKey.fromStringECDSA(cleanKey)]);
  }

  // Also try base64 decode in case it's base64-encoded
  try {
    const decoded = Buffer.from(rawKey, "base64").toString("hex");
    if (decoded.length === 64 || decoded.length >= 60) {
      attempts.push(["fromStringED25519 (base64-decoded)", () => PrivateKey.fromStringED25519(decoded)]);
    }
  } catch (e) {}

  // ── Try each method ──────────────────────────────────────────────────────
  console.log(`${CYAN}${BOLD}Testing key parsing methods:${RESET}\n`);

  let workingMethod = null;

  for (const [label, parseFn] of attempts) {
    process.stdout.write(`  ${label}: `);
    let privateKey;
    try {
      privateKey = parseFn();
      console.log(`${GREEN}parsed OK${RESET} → pubkey: ${GRAY}${privateKey.publicKey.toString().slice(0,20)}...${RESET}`);
    } catch (e) {
      console.log(`${RED}parse error: ${e.message.slice(0, 60)}${RESET}`);
      continue;
    }

    // Try signing a real transaction
    const result = await tryKey(label, privateKey, accountId);
    if (result.success) {
      workingMethod = { label, privateKey };
      console.log(`\n${GREEN}${BOLD}━━━ WORKING METHOD FOUND: ${label} ━━━${RESET}\n`);
      break;
    }
  }

  // ── Results ──────────────────────────────────────────────────────────────
  if (!workingMethod) {
    console.log(`\n${RED}${BOLD}━━━ No working key format found ━━━${RESET}\n`);
    console.log(`${YELLOW}Please check:${RESET}`);
    console.log(`  1. Make sure you copied the ${BOLD}PRIVATE${RESET} key (not public key)`);
    console.log(`  2. On portal.hedera.com go to:`);
    console.log(`     ${CYAN}Your Account → Keys → Download/Copy Private Key${RESET}`);
    console.log(`  3. Copy the ${BOLD}"DER Encoded Private Key"${RESET} — it starts with ${CYAN}302e...${RESET}`);
    console.log(`  4. Or copy the ${BOLD}"HEX Encoded Private Key"${RESET} — exactly 64 hex chars`);
    console.log(`\n  Current key length: ${rawKey.length} chars`);
    console.log(`  Expected: ~64 chars (hex) or ~64 chars (DER starts with 302e)`);
    console.log(`\n${GRAY}  If you used HashPack, export via: Settings → Security → Export Private Key${RESET}`);
  } else {
    const pubkey = workingMethod.privateKey.publicKey.toString();
    console.log(`${GREEN}${BOLD}✅ Your key works!${RESET}\n`);
    console.log(`  Method:  ${CYAN}${workingMethod.label}${RESET}`);
    console.log(`  PubKey:  ${GRAY}${pubkey}${RESET}`);
    console.log(`\n${YELLOW}${BOLD}Action required — update your .env:${RESET}`);

    // Tell them what format to use in .env
    if (workingMethod.label.includes("DER")) {
      console.log(`  Your key is ${GREEN}DER format${RESET} — keep it exactly as-is in .env ✓`);
    } else if (workingMethod.label.includes("ED25519")) {
      console.log(`  Add this to your .env:`);
      console.log(`  ${YELLOW}HEDERA_KEY_TYPE=ED25519${RESET}`);
    } else if (workingMethod.label.includes("ECDSA")) {
      console.log(`  Add this to your .env:`);
      console.log(`  ${YELLOW}HEDERA_KEY_TYPE=ECDSA${RESET}`);
    }

    console.log(`\n${GREEN}${BOLD}Now run: npm run setup${RESET}`);
  }
}

main().catch(err => {
  console.error(`${RED}Diagnostic failed:${RESET}`, err.message);
});
