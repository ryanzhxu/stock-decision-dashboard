const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "decision-engine", "config.js"));
require(path.join(__dirname, "..", "decision-engine", "company-profile-classifier.js"));
for (const file of ["etf-profile.js", "company-profile.js"]) {
  require(path.join(__dirname, "..", "decision-engine", file));
}
const classifier = globalThis.CompanyProfileClassifier;
const engine = globalThis.DecisionEngine;
const definitions = require("../profile-definitions.js");

assert.equal(classifier.PRIMARY_CLASSIFICATIONS.length, 29, "V2.1 adds Media & Entertainment to the fixed primary taxonomy");
assert.deepEqual(classifier.BUSINESS_TRAITS, ["MarketLeader", "HighGrowth", "MatureGrowth", "CashCow", "Defensive", "Cyclical", "Turnaround", "EmergingGrowth"]);
assert.equal(classifier.BUSINESS_TRAITS.includes("MegaCap"), false, "MegaCap is no longer a visible Business Trait");
assert.deepEqual(classifier.SIZE_CLASSES, ["MegaCap", "NonMegaCap"]);
assert.equal(classifier.RISK_TRAITS.length, 8);
assert.equal(classifier.LIFECYCLES.length, 6);
assert.equal(engine.config.profile.schemaVersion, "2.1");

const semiconductorMetadata = {
  quoteType: "EQUITY", sector: "Technology", industry: "Semiconductors",
  businessSummary: "A global GPU and semiconductor provider for data-center compute.",
  marketCap: 2_400_000_000_000, revenueGrowth: 0.28, profitMargins: 0.42, beta: 1.62,
};
const semiconductor = classifier.classify(semiconductorMetadata);
assert.equal(semiconductor.primaryClassification, "Semiconductors");
assert.equal(semiconductor.businessTrait, "HighGrowth", "Business is selected from generalized multi-signal evidence, not size");
assert.equal(semiconductor.riskTrait, "HighVolatility");
assert.equal(semiconductor.lifecycle, "EstablishedLeader", "Huge mature issuers are not Scaling on growth alone");
assert.equal(semiconductor.sizeClass, "MegaCap");
assert.deepEqual(semiconductor.companyTraits, ["HighGrowth", "HighVolatility"]);
assert.equal(semiconductor.profileSchemaVersion, "2.1");
assert.equal(semiconductor.profileStatus, "complete");

// Primary Classification uses the provider's industry before adjacent summary
// products and includes the two V2.1 taxonomy corrections.
assert.equal(classifier.classify({
  quoteType: "EQUITY", sector: "Communication Services", industry: "Entertainment",
  businessSummary: "Provides streaming entertainment services worldwide.", marketCap: 50_000_000_000, revenueGrowth: 0.1, profitMargins: 0.2,
}).primaryClassification, "Media & Entertainment");
assert.equal(classifier.classify({
  quoteType: "EQUITY", sector: "Healthcare", industry: "Healthcare Plans",
  businessSummary: "Provides managed care and health benefit plans.", marketCap: 300_000_000_000, revenueGrowth: 0.05, profitMargins: 0.08,
}).primaryClassification, "Managed Care & Health Services");
assert.equal(classifier.classify({
  quoteType: "EQUITY", sector: "Consumer Cyclical", industry: "Internet Retail",
  businessSummary: "Operates e-commerce marketplaces, cloud infrastructure, and a healthcare service.",
}).primaryClassification, "E-Commerce");

// Identical metadata must be ticker-independent and short-term fields cannot
// affect profile classification because they are not accepted source inputs.
assert.deepEqual(
  classifier.classify({ ...semiconductorMetadata, ticker: "AAA", rsi: 10, currentPrice: 1, action: "sell" }),
  classifier.classify({ ...semiconductorMetadata, ticker: "ZZZ", rsi: 90, currentPrice: 999, action: "buy" }),
);

const bareHighGrowth = classifier.classify({ quoteType: "EQUITY", industry: "Software - Application", revenueGrowth: 0.35 });
assert.equal(bareHighGrowth.businessTrait, null, "Revenue growth alone is insufficient for HighGrowth");
const scaling = classifier.classify({
  quoteType: "EQUITY", industry: "Software - Application", marketCap: 50_000_000_000,
  revenueGrowth: 0.27, profitMargins: 0.12,
  businessSummary: "A subscription-based software as a service platform for enterprises.",
});
assert.equal(scaling.businessTrait, "HighGrowth");
assert.equal(scaling.lifecycle, "Scaling", "Scaling requires growth plus non-huge scale or explicit scalable-business evidence");
const emergingGrowth = classifier.classify({
  quoteType: "EQUITY", industry: "Software - Application", marketCap: 7_000_000_000,
  revenueGrowth: 0.32, profitMargins: -0.12, businessSummary: "Provides enterprise workflow software.",
});
assert.equal(emergingGrowth.businessTrait, "EmergingGrowth");
assert.equal(emergingGrowth.lifecycle, "Scaling");
const largeGrowth = classifier.classify({
  quoteType: "EQUITY", industry: "Enterprise Software", marketCap: 450_000_000_000,
  revenueGrowth: 0.31, profitMargins: 0.25, businessSummary: "Provides enterprise database and infrastructure software.",
});
assert.equal(largeGrowth.lifecycle, "EstablishedLeader", "high revenue growth alone cannot turn a huge mature issuer into Scaling");

// Recovery/turnaround requires issuer-specific structural language, not a
// generic summary mention such as an advisory business that serves restructurings.
assert.equal(classifier.classify({
  quoteType: "EQUITY", industry: "Capital Markets", marketCap: 120_000_000_000, revenueGrowth: 0.1, profitMargins: 0.2,
  businessSummary: "Provides restructuring advisory services to clients.",
}).lifecycle, "MatureLeader");
assert.equal(classifier.classify({
  quoteType: "EQUITY", industry: "Industrials", marketCap: 20_000_000_000, revenueGrowth: 0.05, profitMargins: 0.1,
  businessSummary: "The company is executing a restructuring and turnaround plan for its operations.",
}).lifecycle, "Recovery");

const lowVol = classifier.classify({ quoteType: "EQUITY", industry: "Consumer Electronics", beta: 0.75 });
const highVol = classifier.classify({ quoteType: "EQUITY", industry: "Consumer Electronics", beta: 1.45 });
assert.equal(lowVol.riskTrait, "LowVolatility");
assert.equal(highVol.riskTrait, "HighVolatility");
assert.equal(classifier.classify({ quoteType: "EQUITY", industry: "Semiconductors" }).riskTrait, null, "sparse risk evidence stays conservative null");

const profile = engine.profile.build(semiconductor, "CAP");
assert.equal(profile.sizeClass, "MegaCap");
assert.equal(profile.companyTraits.includes("MegaCap"), false, "internal size cannot become a trait");
assert.equal(profile.appliedModifiers.includes("MegaCap"), false, "internal size cannot become a visible modifier tag");
assert(profile.modifierProvenance.some((item) => item.slot === "sizeClass" && item.value === "MegaCap" && !item.visible));
const sameWithoutSize = engine.profile.build({ ...semiconductor, sizeClass: "NonMegaCap" }, "CAP_NO_SIZE");
assert.equal(profile.effectiveModifiers.actionGates.buyConfirmation, sameWithoutSize.effectiveModifiers.actionGates.buyConfirmation, "size class does not grant action gates");

const withSize = engine.profile.build({ primaryClassification: "Enterprise Software", sizeClass: "MegaCap" }, "SIZE_A");
const withoutSize = engine.profile.build({ primaryClassification: "Enterprise Software", sizeClass: "NonMegaCap" }, "SIZE_B");
assert(withSize.effectiveModifiers.longStability > withoutSize.effectiveModifiers.longStability, "size has a small bounded stability effect");
assert.equal(withSize.effectiveModifiers.actionGates.buyDirection, withoutSize.effectiveModifiers.actionGates.buyDirection, "size cannot alter action gates");
assert.deepEqual(withSize.effectiveModifiers.directionWeights, withoutSize.effectiveModifiers.directionWeights, "size class does not vote on Direction");

const capped = engine.profile.build({ primaryClassification: "Real Estate", businessTrait: "HighGrowth", riskTrait: "InterestRateSensitive", lifecycle: "Scaling", sizeClass: "MegaCap" }, "CAPPED");
for (const key of ["riskSensitivity", "marketSensitivity", "exhaustionSensitivity", "normalAtrTolerance", "strongBuyOpportunity", "rateSensitivity", "eventSensitivity", "longStability"]) {
  const special = ["marketSensitivity", "exhaustionSensitivity", "rateSensitivity", "eventSensitivity"].includes(key);
  const [low, high] = engine.config.profile.modifierCaps[special ? "special" : "normal"];
  assert(capped.effectiveModifiers[key] >= low && capped.effectiveModifiers[key] <= high, `${key} remains cap-bounded`);
}

assert.equal(engine.profile.annualReviewDue("2026-09-10T16:00:00-04:00", new Date("2027-03-30T16:00:00Z")), false);
assert.equal(engine.profile.annualReviewDue("2026-09-10T16:00:00-04:00", new Date("2027-03-31T16:00:00Z")), true);

const staleV2 = definitions.profileFor("LEGACY", {
  quoteType: "EQUITY", industry: "Technology",
  classification: { primaryClassification: "Technology", businessTrait: "MegaCap", riskTrait: "Equity", lifecycle: "Expansion" },
});
assert.equal(staleV2.businessTrait, null, "stale V2 MegaCap cannot leak through definition validation");
assert.deepEqual(staleV2.companyTraits, []);

const etf = definitions.profileFor("TQQQ", { quoteType: "ETF" });
assert.equal(etf.isETF, true);
assert.equal(etf.leveraged, true);
assert.equal(Object.hasOwn(etf, "businessTrait"), false, "ETFs do not use stock profile slots");

console.log("company-profile.test.js: V2.1 taxonomy, generalized evidence selection, size isolation, and ETF isolation passed");
