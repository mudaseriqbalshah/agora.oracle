#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// openBridge UCP Setup Script
// Runs ONCE to create all HCS topics and HTS tokens on Hedera Testnet
// Usage: node scripts/setup-topics.js
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  Client, AccountId, PrivateKey,
  TopicCreateTransaction,
  TokenCreateTransaction, TokenType, TokenSupplyType,
  TokenAssociateTransaction,
  TokenMintTransaction,
  TransferTransaction,
  Hbar,
} from "@hashgraph/sdk";

dotenv.config();

// ── Smart key parser — handles DER hex, raw hex, ECDSA, ED25519 ──────────────
function parsePrivateKey(rawKey) {
  const clean = rawKey.replace("0x", "").trim();
  const keyType = process.env.HEDERA_KEY_TYPE;
  const parsers = keyType === "ECDSA"
    ? [() => PrivateKey.fromStringECDSA(clean), () => PrivateKey.fromString(clean)]
    : keyType === "ED25519"
    ? [() => PrivateKey.fromStringED25519(clean), () => PrivateKey.fromStringDer(clean), () => PrivateKey.fromString(clean)]
    : [
        () => PrivateKey.fromStringDer(clean),
        () => PrivateKey.fromString(clean),
        () => PrivateKey.fromStringED25519(clean),
        () => PrivateKey.fromStringECDSA(clean),
      ];
  for (const parser of parsers) {
    try { return parser(); } catch (e) {}
  }
  throw new Error(`Cannot parse HEDERA_OPERATOR_KEY. Run: node scripts/fix-key.js`);
}

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN  = "\x1b[36m";
const YELLOW= "\x1b[33m";
const PURPLE= "\x1b[35m";
const RED   = "\x1b[31m";

function log(color, label, msg) {
  console.log(`${color}${BOLD}[${label}]${RESET} ${msg}`);
}

async function main() {
  console.log(`\n${PURPLE}${BOLD}
╔═══════════════════════════════════════════════════════╗
║     openBridge UCP Commerce Network — Setup           ║
║     ETHDenver 2026 | Hedera Testnet                   ║
╚═══════════════════════════════════════════════════════╝${RESET}\n`);

  // ── Validate credentials ────────────────────────────────────────────────
  if (!process.env.HEDERA_OPERATOR_ID || !process.env.HEDERA_OPERATOR_KEY) {
    console.error(`${RED}${BOLD}ERROR:${RESET} Missing HEDERA_OPERATOR_ID or HEDERA_OPERATOR_KEY in .env`);
    console.log(`\nGet free testnet credentials at: ${CYAN}https://portal.hedera.com${RESET}`);
    process.exit(1);
  }

  const operatorId  = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = parsePrivateKey(process.env.HEDERA_OPERATOR_KEY);

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(10));

  log(CYAN, "Hedera", `Connected to testnet as ${operatorId}`);

  const results = {};

  // ── Create HCS Topics ───────────────────────────────────────────────────
  console.log(`\n${CYAN}${BOLD}━━━ Creating HCS Topics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

  const topics = [
    { key: "HCS_TOPIC_UCP_INTENTS",    memo: "openBridge-UCP-AgentIntents-v1" },
    { key: "HCS_TOPIC_ORACLE_PRICES",  memo: "openBridge-UCP-OraclePrices-v1" },
    { key: "HCS_TOPIC_SETTLEMENTS",    memo: "openBridge-UCP-Settlements-v1" },
    { key: "HCS_TOPIC_REPUTATION",     memo: "openBridge-UCP-Reputation-v1" },
  ];

  for (const topic of topics) {
    process.stdout.write(`  Creating ${YELLOW}${topic.memo}${RESET}... `);
    const tx = await new TopicCreateTransaction()
      .setTopicMemo(topic.memo)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const topicId = receipt.topicId.toString();
    results[topic.key] = topicId;
    console.log(`${GREEN}✓${RESET} ${BOLD}${topicId}${RESET}`);
  }

  // ── Create HTS Tokens ───────────────────────────────────────────────────
  console.log(`\n${CYAN}${BOLD}━━━ Creating HTS Tokens ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

  // Wheat token (commodity)
  process.stdout.write(`  Creating ${YELLOW}Wheat Commodity Token (WHEAT)${RESET}... `);
  const wheatTx = await new TokenCreateTransaction()
    .setTokenName("openBridge Wheat Commodity")
    .setTokenSymbol("WHEAT")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(3)
    .setInitialSupply(1_000_000 * 1000) // 1M tonnes, 3 decimals
    .setTreasuryAccountId(AccountId.fromString(operatorId))
    .setSupplyType(TokenSupplyType.Infinite)
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .execute(client);
  const wheatReceipt = await wheatTx.getReceipt(client);
  results["HTS_WHEAT_TOKEN"] = wheatReceipt.tokenId.toString();
  console.log(`${GREEN}✓${RESET} ${BOLD}${results["HTS_WHEAT_TOKEN"]}${RESET}`);

  // USD Stablecoin token
  process.stdout.write(`  Creating ${YELLOW}USD Stablecoin (UCPUSD)${RESET}... `);
  const usdTx = await new TokenCreateTransaction()
    .setTokenName("openBridge USD Stablecoin")
    .setTokenSymbol("UCPUSD")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(2)
    .setInitialSupply(10_000_000 * 100) // $10M, 2 decimals
    .setTreasuryAccountId(AccountId.fromString(operatorId))
    .setSupplyType(TokenSupplyType.Infinite)
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .execute(client);
  const usdReceipt = await usdTx.getReceipt(client);
  results["HTS_USD_TOKEN"] = usdReceipt.tokenId.toString();
  console.log(`${GREEN}✓${RESET} ${BOLD}${results["HTS_USD_TOKEN"]}${RESET}`);

  // ── Fund Agent Accounts (if provided) ───────────────────────────────────
  const agentIds = [
    { label: "Alice",  idKey: "AGENT_ALICE_ID", keyKey: "AGENT_ALICE_KEY" },
    { label: "Bob",    idKey: "AGENT_BOB_ID",   keyKey: "AGENT_BOB_KEY"   },
    { label: "Oracle", idKey: "ORACLE_NODE_ID", keyKey: "ORACLE_NODE_KEY"  },
  ].filter(a => process.env[a.idKey] && process.env[a.keyKey]);

  // ── Save topics/tokens to .env NOW (before agent funding, so a failure here doesn't lose them)
  {
    let envContent = existsSync(".env") ? readFileSync(".env", "utf8") : "";
    for (const [key, value] of Object.entries(results)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) envContent = envContent.replace(regex, `${key}=${value}`);
      else envContent += `\n${key}=${value}`;
    }
    writeFileSync(".env", envContent);
    log(GREEN, "Saved", "Topics and tokens written to .env (safe even if funding fails)");
  }

  if (agentIds.length > 0) {
    console.log(`\n${CYAN}${BOLD}━━━ Funding Agent Accounts ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

    for (const agent of agentIds) {
      const agentId = process.env[agent.idKey];
      let agentKey;
      try {
        agentKey = parsePrivateKey(process.env[agent.keyKey]);
      } catch(e) {
        console.log(`${YELLOW}⚠ Skipping ${agent.label} — key parse failed: ${e.message.slice(0,50)}${RESET}`);
        continue;
      }

      // Associate tokens with agent
      process.stdout.write(`  Associating tokens with ${YELLOW}Agent ${agent.label}${RESET} (${agentId})... `);
      const agentClient = Client.forTestnet();
      agentClient.setOperator(AccountId.fromString(agentId), agentKey);

      await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(agentId))
        .setTokenIds([results["HTS_WHEAT_TOKEN"], results["HTS_USD_TOKEN"]])
        .execute(agentClient);
      console.log(`${GREEN}✓ tokens associated${RESET}`);

      // Send initial token balances
      process.stdout.write(`  Funding ${YELLOW}${agent.label}${RESET}... `);
      const fund = new TransferTransaction();

      if (agent.label === "Bob" || agent.label === "Oracle") {
        fund.addTokenTransfer(results["HTS_WHEAT_TOKEN"], AccountId.fromString(operatorId), -10_000_000);
        fund.addTokenTransfer(results["HTS_WHEAT_TOKEN"], AccountId.fromString(agentId), 10_000_000);
      }
      if (agent.label === "Alice") {
        fund.addTokenTransfer(results["HTS_USD_TOKEN"], AccountId.fromString(operatorId), -50_000_000);
        fund.addTokenTransfer(results["HTS_USD_TOKEN"], AccountId.fromString(agentId), 50_000_000);
      }

      const fundTx = await fund.execute(client);
      await fundTx.getReceipt(client);
      console.log(`${GREEN}✓ funded${RESET}`);
      agentClient.close();
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${GREEN}${BOLD}
╔═══════════════════════════════════════════════════════╗
║  ✅  Setup Complete!                                   ║
╚═══════════════════════════════════════════════════════╝${RESET}

${BOLD}HCS Topics created:${RESET}
  UCP Intents:    ${CYAN}${results["HCS_TOPIC_UCP_INTENTS"]}${RESET}
  Oracle Prices:  ${CYAN}${results["HCS_TOPIC_ORACLE_PRICES"]}${RESET}
  Settlements:    ${CYAN}${results["HCS_TOPIC_SETTLEMENTS"]}${RESET}
  Reputation:     ${CYAN}${results["HCS_TOPIC_REPUTATION"]}${RESET}

${BOLD}HTS Tokens created:${RESET}
  WHEAT token:    ${CYAN}${results["HTS_WHEAT_TOKEN"]}${RESET}
  UCPUSD token:   ${CYAN}${results["HTS_USD_TOKEN"]}${RESET}

${BOLD}View on Hedera Explorer:${RESET}
  ${CYAN}https://hashscan.io/testnet/account/${operatorId}${RESET}

${BOLD}Next steps:${RESET}
  1. Run ${YELLOW}npm run oracle${RESET}    → start openBridge oracle node
  2. Run ${YELLOW}npm run demo${RESET}      → run the full demo (all agents)
  3. Run ${YELLOW}npm run monitor${RESET}   → watch live HCS feed
`);

  client.close();
}

main().catch(err => {
  console.error(`${RED}${BOLD}Setup failed:${RESET}`, err.message);
  console.log(`\n${YELLOW}If topics and tokens were already created, just add them to .env manually and run: npm run demo${RESET}`);
  process.exit(1);
});
