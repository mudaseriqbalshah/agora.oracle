#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// openBridge UCP Live Monitor
// Shows real-time feed of all HCS topics for demo/judges screen
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from "dotenv";
import { Client, TopicId, TopicMessageQuery } from "@hashgraph/sdk";

dotenv.config();

const RESET   = "\x1b[0m";
const BOLD    = "\x1b[1m";
const GREEN   = "\x1b[32m";
const CYAN    = "\x1b[36m";
const YELLOW  = "\x1b[33m";
const BLUE    = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const GRAY    = "\x1b[90m";
const RED     = "\x1b[31m";
const WHITE   = "\x1b[37m";
const BG_DARK = "\x1b[40m";

const MSG_COLORS = {
  UCP_PRICE_ATTESTATION: CYAN,
  UCP_BUY_INTENT:        BLUE,
  UCP_SELL_INTENT:       MAGENTA,
  UCP_MATCH_PROPOSAL:    YELLOW,
  UCP_MATCH_ACCEPT:      GREEN,
  UCP_SETTLEMENT_INIT:   YELLOW,
  UCP_SETTLEMENT_DONE:   GREEN,
  UCP_REPUTATION_UPDATE: GRAY,
};

const MSG_ICONS = {
  UCP_PRICE_ATTESTATION: "📡",
  UCP_BUY_INTENT:        "🔵",
  UCP_SELL_INTENT:       "🟣",
  UCP_MATCH_PROPOSAL:    "⚡",
  UCP_MATCH_ACCEPT:      "✅",
  UCP_SETTLEMENT_INIT:   "🔄",
  UCP_SETTLEMENT_DONE:   "💰",
  UCP_REPUTATION_UPDATE: "⭐",
};

const stats = {
  oracles: 0, intents: 0, matches: 0, settlements: 0, total: 0
};

function formatMsg(msg, topicLabel) {
  const color = MSG_COLORS[msg.msgType] || WHITE;
  const icon  = MSG_ICONS[msg.msgType]  || "•";
  const time  = new Date().toLocaleTimeString();

  let detail = "";
  switch (msg.msgType) {
    case "UCP_PRICE_ATTESTATION":
      detail = `${YELLOW}$${msg.price}${color}/${msg.commodity?.unit} conf:${msg.confidence}%`;
      stats.oracles++;
      break;
    case "UCP_BUY_INTENT":
      detail = `${msg.quantity} ${msg.commodity?.id} @ max $${msg.priceRange?.max} ttl:${msg.ttl ? Math.max(0, msg.ttl - Math.floor(Date.now()/1000)) + "s" : "?"}`;
      stats.intents++;
      break;
    case "UCP_SELL_INTENT":
      detail = `${msg.quantity} ${msg.commodity?.id} @ $${msg.priceRange?.min} rep:${msg.reputationScore}★`;
      stats.intents++;
      break;
    case "UCP_MATCH_PROPOSAL":
      detail = `${YELLOW}$${msg.agreedPrice}${color} x ${msg.quantity} units | buyer:${msg.buyerAgentId?.slice(-6)} seller:${msg.sellerAgentId?.slice(-6)}`;
      stats.matches++;
      break;
    case "UCP_SETTLEMENT_DONE":
      detail = `${GREEN}$${msg.totalValue}${color} total | TX:${msg.hederaTxId?.slice(0,20)}...`;
      stats.settlements++;
      break;
    case "UCP_REPUTATION_UPDATE":
      detail = `agent:${msg.agentId?.slice(-6)} outcome:${msg.outcome}`;
      break;
    default:
      detail = JSON.stringify(msg).slice(0, 60) + "...";
  }

  stats.total++;

  return `${GRAY}${time}${RESET} ${color}${icon} ${BOLD}${msg.msgType || "UNKNOWN"}${RESET}` +
    `${GRAY} [${topicLabel}]${RESET} ${color}${detail}${RESET}`;
}

function subscribeToTopic(topicIdStr, label) {
  if (!topicIdStr) {
    console.log(`${GRAY}  ${label}: not configured${RESET}`);
    return;
  }

  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(topicIdStr))
    .setStartTime(0);

  const client = Client.forTestnet();

  query.subscribe(
    client,
    (err) => { if (err) console.error(`${RED}[${label}] error: ${err.message}${RESET}`); },
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const parsed = JSON.parse(text);
        console.log(formatMsg(parsed, label));
      } catch (e) {
        console.log(`${GRAY}[${label}] raw: ${Buffer.from(message.contents).toString("utf8").slice(0, 80)}${RESET}`);
      }
    }
  );

  console.log(`  ${GREEN}✓${RESET} Watching ${label}: ${CYAN}${topicIdStr}${RESET}`);
}

async function main() {
  console.clear();
  console.log(`${MAGENTA}${BOLD}
╔══════════════════════════════════════════════════════════╗
║   openBridge UCP Commerce Network — Live Monitor         ║
║   Hedera Testnet | Real-time HCS Feed                    ║
╚══════════════════════════════════════════════════════════╝${RESET}\n`);

  if (!process.env.HCS_TOPIC_UCP_INTENTS) {
    console.error(`${RED}ERROR: Topics not configured. Run: npm run setup${RESET}`);
    process.exit(1);
  }

  console.log(`${CYAN}${BOLD}Subscribing to HCS topics:${RESET}`);
  subscribeToTopic(process.env.HCS_TOPIC_ORACLE_PRICES, "ORACLE");
  subscribeToTopic(process.env.HCS_TOPIC_UCP_INTENTS,   "INTENTS");
  subscribeToTopic(process.env.HCS_TOPIC_SETTLEMENTS,   "SETTLE");
  subscribeToTopic(process.env.HCS_TOPIC_REPUTATION,    "REPUTE");

  console.log(`\n${GRAY}${"─".repeat(62)}${RESET}`);
  console.log(`${GRAY}  Hashscan: https://hashscan.io/testnet${RESET}`);
  console.log(`${GRAY}${"─".repeat(62)}${RESET}\n`);

  console.log(`${CYAN}Waiting for messages...${RESET}\n`);

  // Stats line every 30s
  setInterval(() => {
    console.log(`\n${GRAY}━━ Stats: oracle:${stats.oracles} intents:${stats.intents} matches:${stats.matches} settlements:${stats.settlements} total:${stats.total} ━━${RESET}\n`);
  }, 30_000);
}

main().catch(err => {
  console.error(`${RED}Monitor failed:${RESET}`, err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log(`\n${YELLOW}Monitor shutting down...${RESET}`);
  process.exit(0);
});
