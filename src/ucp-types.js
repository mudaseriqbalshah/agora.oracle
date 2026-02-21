// ─────────────────────────────────────────────────────────────────────────────
// UCP (Universal Commodity Protocol) - Type Definitions
// openBridge UCP Commerce Network
// ─────────────────────────────────────────────────────────────────────────────

export const UCP_VERSION = "1.0.0";

// ── UCP Message Types ────────────────────────────────────────────────────────

export const MSG_TYPES = {
  // Agent intents
  BUY_INTENT:       "UCP_BUY_INTENT",
  SELL_INTENT:      "UCP_SELL_INTENT",
  INTENT_CANCEL:    "UCP_INTENT_CANCEL",
  // Oracle
  PRICE_ATTESTATION: "UCP_PRICE_ATTESTATION",
  // Matching
  MATCH_PROPOSAL:   "UCP_MATCH_PROPOSAL",
  MATCH_ACCEPT:     "UCP_MATCH_ACCEPT",
  MATCH_REJECT:     "UCP_MATCH_REJECT",
  // Settlement
  SETTLEMENT_INIT:  "UCP_SETTLEMENT_INIT",
  SETTLEMENT_DONE:  "UCP_SETTLEMENT_DONE",
  // Reputation
  REPUTATION_UPDATE: "UCP_REPUTATION_UPDATE",
};

// ── Commodity Types (UCP Standard) ──────────────────────────────────────────

export const COMMODITIES = {
  WHEAT:    { id: "WHEAT",    unit: "tonne",  decimals: 3 },
  CORN:     { id: "CORN",     unit: "bushel", decimals: 3 },
  GOLD:     { id: "GOLD",     unit: "oz",     decimals: 4 },
  CRUDE:    { id: "CRUDE",    unit: "barrel", decimals: 2 },
  HBAR:     { id: "HBAR",     unit: "HBAR",   decimals: 8 },
};

// ── UCP Intent Schema ────────────────────────────────────────────────────────

export function buildIntent(type, agentId, commodity, qty, priceMin, priceMax, ttlSeconds) {
  return {
    ucpVersion: UCP_VERSION,
    msgType: type === "buy" ? MSG_TYPES.BUY_INTENT : MSG_TYPES.SELL_INTENT,
    intentId: `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    agentId,
    commodity: COMMODITIES[commodity],
    quantity: qty,
    priceRange: { min: priceMin, max: priceMax, currency: "USD" },
    ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
    timestamp: new Date().toISOString(),
  };
}

// ── Oracle Price Attestation Schema ─────────────────────────────────────────

export function buildOracleAttestation(oracleId, commodity, price, confidence) {
  return {
    ucpVersion: UCP_VERSION,
    msgType: MSG_TYPES.PRICE_ATTESTATION,
    attestationId: `oracle-${Date.now()}`,
    oracleId,
    commodity: COMMODITIES[commodity],
    price,
    currency: "USD",
    confidence,         // 0-100%
    sources: ["CoinGecko", "Binance", "Chainlink-simulation"],
    timestamp: new Date().toISOString(),
    validFor: 300,      // seconds this attestation is valid
  };
}

// ── Match Proposal Schema ────────────────────────────────────────────────────

export function buildMatchProposal(buyIntentId, sellIntentId, agreedPrice, qty, buyerAgentId, sellerAgentId) {
  return {
    ucpVersion: UCP_VERSION,
    msgType: MSG_TYPES.MATCH_PROPOSAL,
    matchId: `match-${Date.now()}`,
    buyIntentId,
    sellIntentId,
    buyerAgentId,
    sellerAgentId,
    agreedPrice,
    quantity: qty,
    currency: "USD",
    settlementDeadline: Math.floor(Date.now() / 1000) + 120, // 2 min to settle
    timestamp: new Date().toISOString(),
  };
}

// ── Settlement Record Schema ─────────────────────────────────────────────────

export function buildSettlementRecord(matchId, txId, buyerAgentId, sellerAgentId, commodity, qty, price) {
  return {
    ucpVersion: UCP_VERSION,
    msgType: MSG_TYPES.SETTLEMENT_DONE,
    settlementId: `settle-${Date.now()}`,
    matchId,
    hederaTxId: txId,
    buyerAgentId,
    sellerAgentId,
    commodity,
    quantity: qty,
    finalPrice: price,
    totalValue: (qty * price).toFixed(2),
    timestamp: new Date().toISOString(),
  };
}
