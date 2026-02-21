// ─────────────────────────────────────────────────────────────────────────────
// Hedera Client + Helpers
// openBridge UCP Commerce Network
// ─────────────────────────────────────────────────────────────────────────────

import {
  Client, AccountId, PrivateKey, TopicId,
  TopicCreateTransaction, TopicMessageSubmitTransaction,
  TopicInfoQuery, TopicMessageQuery,
  TokenCreateTransaction, TokenType, TokenSupplyType,
  TokenMintTransaction, TokenAssociateTransaction,
  TransferTransaction,
  AccountBalanceQuery,
  Hbar,
} from "@hashgraph/sdk";
import * as dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";

dotenv.config();

// ── Client Factory ───────────────────────────────────────────────────────────

export function createClient(accountId, privateKey) {
  const client = Client.forTestnet();
  client.setOperator(
    AccountId.fromString(accountId),
    PrivateKey.fromString(privateKey)
  );
  return client;
}

export function getOperatorClient() {
  return createClient(
    process.env.HEDERA_OPERATOR_ID,
    process.env.HEDERA_OPERATOR_KEY
  );
}

// ── HCS Topic Creation ───────────────────────────────────────────────────────

export async function createHCSTopic(client, memo) {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  return receipt.topicId.toString();
}

// ── HCS Message Publishing ───────────────────────────────────────────────────

export async function publishToHCS(client, topicId, message) {
  const msgString = typeof message === "string" ? message : JSON.stringify(message);
  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(msgString)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  return {
    sequenceNumber: receipt.topicSequenceNumber?.toString(),
    transactionId: tx.transactionId?.toString(),
  };
}

// ── HCS Message Subscription ─────────────────────────────────────────────────
// Returns an unsubscribe function

export function subscribeToHCS(topicId, onMessage, startTime = null) {
  const query = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(topicId));

  if (startTime) {
    query.setStartTime(startTime);
  }

  const handle = query.subscribe(
    Client.forTestnet(),
    (error) => {
      if (error) console.error(`[HCS] Subscription error on ${topicId}:`, error.message);
    },
    (message) => {
      try {
        const text = Buffer.from(message.contents).toString("utf8");
        const parsed = JSON.parse(text);
        onMessage(parsed, message);
      } catch (e) {
        // non-JSON message, ignore
      }
    }
  );

  return () => handle.unsubscribe();
}

// ── HTS Token Creation ───────────────────────────────────────────────────────

export async function createFungibleToken(client, operatorId, operatorKey, name, symbol, initialSupply, decimals = 2) {
  const tx = await new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(decimals)
    .setInitialSupply(initialSupply * Math.pow(10, decimals))
    .setTreasuryAccountId(AccountId.fromString(operatorId))
    .setSupplyType(TokenSupplyType.Infinite)
    .setAdminKey(PrivateKey.fromString(operatorKey).publicKey)
    .setSupplyKey(PrivateKey.fromString(operatorKey).publicKey)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  return receipt.tokenId.toString();
}

// ── HTS Token Association ────────────────────────────────────────────────────

export async function associateToken(client, accountId, tokenIds) {
  const tx = await new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(accountId))
    .setTokenIds(tokenIds)
    .execute(client);
  await tx.getReceipt(client);
}

// ── HTS Token Transfer (Atomic Swap) ────────────────────────────────────────

export async function atomicSwap(
  client,
  tokenAId, senderAId, receiverAId, amountA,   // Commodity token: Bob → Alice
  tokenBId, senderBId, receiverBId, amountB,   // USD token: Alice → Bob
) {
  const tx = await new TransferTransaction()
    .addTokenTransfer(tokenAId, AccountId.fromString(senderAId), -amountA)
    .addTokenTransfer(tokenAId, AccountId.fromString(receiverAId), amountA)
    .addTokenTransfer(tokenBId, AccountId.fromString(senderBId), -amountB)
    .addTokenTransfer(tokenBId, AccountId.fromString(receiverBId), amountB)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  return {
    status: receipt.status.toString(),
    transactionId: tx.transactionId?.toString(),
  };
}

// ── Account Balance Query ────────────────────────────────────────────────────

export async function getAccountBalances(client, accountId) {
  const query = new AccountBalanceQuery().setAccountId(AccountId.fromString(accountId));
  const balance = await query.execute(client);
  return {
    hbar: balance.hbars.toString(),
    tokens: balance.tokens ? Object.fromEntries(balance.tokens._map) : {}
  };
}

// ── Config Loading ───────────────────────────────────────────────────────────

export function loadConfig() {
  if (!existsSync(".env")) {
    throw new Error("No .env file found. Copy .env.example to .env and fill in credentials.");
  }
  const required = ["HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

export function getTopics() {
  return {
    intents:      process.env.HCS_TOPIC_UCP_INTENTS,
    prices:       process.env.HCS_TOPIC_ORACLE_PRICES,
    settlements:  process.env.HCS_TOPIC_SETTLEMENTS,
    reputation:   process.env.HCS_TOPIC_REPUTATION,
  };
}

export function getTokens() {
  return {
    wheat: process.env.HTS_WHEAT_TOKEN,
    usd:   process.env.HTS_USD_TOKEN,
  };
}
