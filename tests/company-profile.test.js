const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "decision-engine", "company-profile-classifier.js"));
for (const file of ["config.js", "etf-profile.js", "company-profile.js"]) {
  require(path.join(__dirname, "..", "decision-engine", file));
}
const classifier = globalThis.CompanyProfileClassifier;
const engine = globalThis.DecisionEngine;
const definitions = require("../profile-definitions.js");

assert.equal(classifier.PRIMARY_CLASSIFICATIONS.length, 28, "the canonical primary taxonomy has 28 entries");
assert.equal(classifier.BUSINESS_TRAITS.length, 8);
assert.equal(classifier.RISK_TRAITS.length, 8);
assert.equal(classifier.LIFECYCLES.length, 6);

const semiconductorMetadata = {
  quoteType: "EQUITY",
  sector: "Technology",
  industry: "Semiconductors",
  businessSummary: "A global GPU and semiconductor provider for data-center compute.",
  marketCap: 2_400_000_000_000,
  revenueGrowth: 0.28,
  profitMargins: 0.42,
  beta: 1.62,
};
const semiconductor = classifier.classify(semiconductorMetadata);
assert.equal(semiconductor.primaryClassification, "Semiconductors");
assert.equal(semiconductor.businessTrait, "MegaCap");
assert.equal(semiconductor.riskTrait, "HighVolatility");
assert.equal(semiconductor.lifecycle, "Scaling");
assert.deepEqual(semiconductor.companyTraits, ["MegaCap", "HighVolatility"]);
assert.equal(semiconductor.profileStatus, "complete");
for (const [field, vocabulary] of Object.entries({
  primaryClassification: classifier.PRIMARY_CLASSIFICATIONS,
  businessTrait: classifier.BUSINESS_TRAITS,
  riskTrait: classifier.RISK_TRAITS,
  lifecycle: classifier.LIFECYCLES,
})) assert(semiconductor[field] == null || vocabulary.includes(semiconductor[field]), `${field} is canonical`);

// Industry is the primary structural evidence. Adjacent products mentioned in
// a long summary must not silently replace the provider's specific industry.
assert.equal(classifier.classify({
  quoteType: "EQUITY", sector: "Technology", industry: "Consumer Electronics",
  businessSummary: "Designs smartphones and wearables; it also operates an advertising platform and payment service.",
}).primaryClassification, "Consumer Technology");
assert.equal(classifier.classify({
  quoteType: "EQUITY", sector: "Consumer Cyclical", industry: "Internet Retail",
  businessSummary: "Operates e-commerce marketplaces, cloud infrastructure, and a healthcare service.",
}).primaryClassification, "E-Commerce");

// Classifier rules intentionally do not inspect ticker symbols.
assert.deepEqual(
  classifier.classify({ ...semiconductorMetadata, ticker: "AAA" }),
  classifier.classify({ ...semiconductorMetadata, ticker: "ZZZ" }),
  "identical metadata has identical classification regardless of ticker",
);

const missing = classifier.classify({ quoteType: "EQUITY", sector: "Technology", industry: "Technology" });
assert.equal(missing.primaryClassification, null);
assert.equal(missing.businessTrait, null);
assert.equal(missing.riskTrait, null);
assert.equal(missing.lifecycle, null);
assert.equal(missing.profileStatus, "unavailable");
assert(!["UnreviewedProfile", "Technology", "Equity", "DiversifiedBusiness", "EstablishedLeader"].includes(missing.businessTrait));

const partial = classifier.classify({
  quoteType: "EQUITY", industry: "Software - Application", businessSummary: "Provides enterprise workflow SaaS software.",
  marketCap: 8_000_000_000, revenueGrowth: 0.23,
});
assert.equal(partial.primaryClassification, "Enterprise Software");
assert.equal(partial.businessTrait, "HighGrowth");
assert.equal(partial.riskTrait, null);
assert.equal(partial.lifecycle, "Scaling");
assert.equal(partial.profileStatus, "incomplete");
const partialBuilt = engine.profile.build(partial, "PARTIAL");
assert.deepEqual(partialBuilt.companyTraits, ["HighGrowth"]);
assert(partialBuilt.appliedModifiers.includes("Enterprise Software"));
assert(partialBuilt.appliedModifiers.includes("HighGrowth"));
assert(!partialBuilt.appliedModifiers.includes("HighVolatility"));

// Primary Classification must affect modifier behavior even when all other
// slots are the same.
const software = engine.profile.build({ primaryClassification: "Enterprise Software", businessTrait: "MatureGrowth", riskTrait: null, lifecycle: "MatureLeader" }, "SOFTWARE");
const banking = engine.profile.build({ primaryClassification: "Banking", businessTrait: "MatureGrowth", riskTrait: null, lifecycle: "MatureLeader" }, "BANKING");
assert.notDeepEqual(software.effectiveModifiers, banking.effectiveModifiers);
assert(software.appliedModifiers.includes("Enterprise Software"));
assert(banking.appliedModifiers.includes("Banking"));

const capped = engine.profile.build({ primaryClassification: "Real Estate", businessTrait: "HighGrowth", riskTrait: "InterestRateSensitive", lifecycle: "Scaling" }, "CAPPED");
for (const key of ["riskSensitivity", "marketSensitivity", "exhaustionSensitivity", "normalAtrTolerance", "strongBuyOpportunity", "rateSensitivity", "eventSensitivity", "longStability"]) {
  const special = ["marketSensitivity", "exhaustionSensitivity", "rateSensitivity", "eventSensitivity"].includes(key);
  const [low, high] = engine.config.profile.modifierCaps[special ? "special" : "normal"];
  assert(capped.effectiveModifiers[key] >= low && capped.effectiveModifiers[key] <= high, `${key} is cap-bounded`);
}

assert.equal(engine.profile.annualReviewDue("2026-09-10T16:00:00-04:00", new Date("2027-03-30T16:00:00Z")), false);
assert.equal(engine.profile.annualReviewDue("2026-09-10T16:00:00-04:00", new Date("2027-03-31T16:00:00Z")), true);
assert.equal(engine.profile.annualReviewDue("2027-04-10T16:00:00-04:00", new Date("2028-03-30T16:00:00Z")), false);
assert.equal(engine.profile.annualReviewDue("2027-04-10T16:00:00-04:00", new Date("2028-03-31T16:00:00Z")), true);

// Legacy/generic fields never become a completed V2 profile, even if they
// arrive in a stale cache payload.
const legacy = definitions.profileFor("LEGACY", {
  quoteType: "EQUITY", sector: "Technology", industry: "Technology",
  classification: { primaryClassification: "Technology", businessTrait: "UnreviewedProfile", riskTrait: "Equity", lifecycle: "Expansion" },
});
assert.equal(legacy.profileStatus, "unavailable");
assert.deepEqual(legacy.companyTraits, []);

const etf = definitions.profileFor("TQQQ", { quoteType: "ETF" });
assert.equal(etf.isETF, true);
assert.equal(etf.leveraged, true);
assert.equal(etf.direction, "long");
assert.equal(Object.hasOwn(etf, "businessTrait"), false, "ETFs do not use stock profile slots");

console.log("company-profile.test.js: V2 taxonomy, automatic classification, annual review, caps, and ETF isolation passed");
