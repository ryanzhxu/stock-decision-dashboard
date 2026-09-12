#!/usr/bin/env node
"use strict";

// Bounded, read-only Company Profile V2.1 audit. It consumes only cached
// metadata and persisted compact profiles; it never invokes a provider, opens
// a write connection, or changes profile persistence.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
require(path.join(ROOT, "decision-engine", "config.js"));
const classifier = require(path.join(ROOT, "decision-engine", "company-profile-classifier.js"));
for (const file of ["etf-profile.js", "company-profile.js"]) require(path.join(ROOT, "decision-engine", file));
const profileEngine = globalThis.DecisionEngine.profile;
const CACHE_DIRECTORY = path.join(ROOT, "data", "cache", "quotes");
const DB_PATH = process.env.WATCHLIST_DB_PATH || path.join(ROOT, "data", "watchlist.db");
const requested = new Set((process.argv.find((value) => value.startsWith("--tickers=")) || "").slice(10).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
const details = process.argv.includes("--details");

function text(value) { return value == null || value === "" ? "—" : String(value); }
function compact(values) { return Array.isArray(values) && values.length ? values.join(", ") : "—"; }
function quoteFromCache(file) {
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  return cached?.quote || cached || {};
}
function persistedProfiles() {
  if (!fs.existsSync(DB_PATH)) return {};
  const script = [
    "import json, sqlite3, sys",
    "conn=sqlite3.connect(sys.argv[1]); conn.row_factory=sqlite3.Row",
    "cols={r[1] for r in conn.execute('PRAGMA table_info(company_profiles)')}",
    "wanted=['ticker','primary_classification','business_trait','risk_trait','lifecycle','profile_status','profile_schema_version'] + (['size_class'] if 'size_class' in cols else [])",
    "rows=[dict(r) for r in conn.execute('SELECT '+','.join(wanted)+' FROM company_profiles')]",
    "print(json.dumps(rows, ensure_ascii=False)); conn.close()",
  ].join("\n");
  try {
    const output = childProcess.execFileSync(process.env.PYTHON || "python3", ["-c", script, DB_PATH], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Object.fromEntries(JSON.parse(output).map((row) => [String(row.ticker).toUpperCase(), row]));
  } catch {
    return {};
  }
}
function v2ClassifierFromHead() {
  try {
    const source = childProcess.execFileSync("git", ["show", "HEAD:decision-engine/company-profile-classifier.js"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const context = { globalThis: {} };
    vm.runInNewContext(source, context, { timeout: 1000 });
    const result = context.globalThis.CompanyProfileClassifier;
    return result?.BUSINESS_TRAITS?.includes("MegaCap") ? result : null;
  } catch {
    return null;
  }
}

const previousClassifier = v2ClassifierFromHead();
const persisted = persistedProfiles();
const cached = new Map();
if (fs.existsSync(CACHE_DIRECTORY)) {
  for (const file of fs.readdirSync(CACHE_DIRECTORY).filter((entry) => entry.endsWith(".json")).sort()) {
    const ticker = path.basename(file, ".json").toUpperCase();
    cached.set(ticker, quoteFromCache(path.join(CACHE_DIRECTORY, file)));
  }
}
const tickers = [...new Set([...cached.keys(), ...Object.keys(persisted)])]
  .filter((ticker) => !requested.size || requested.has(ticker)).sort();
const rows = [];
for (const ticker of tickers) {
  const quote = cached.get(ticker) || {};
  const metadata = quote.metadata || {};
  const persistedRow = persisted[ticker] || null;
  const isETF = String(metadata.quoteType || "").toUpperCase() === "ETF";
  if (isETF) {
    rows.push({ ticker, type: "ETF", persisted: persistedRow, metadata, current: null, previous: null, effective: null });
    continue;
  }
  const explanation = classifier.explain(metadata);
  const current = explanation.result;
  const previous = previousClassifier ? previousClassifier.classify(metadata) : null;
  const effective = profileEngine.build(current, ticker);
  rows.push({ ticker, type: "stock", persisted: persistedRow, metadata, current, previous, effective, explanation });
}

console.log("Company Profile V2.1 audit (cache/persistence only; zero provider requests)");
console.log("Ticker | Type | V2 primary/business/risk/lifecycle | V2.1 primary/business/risk/lifecycle | Size | Status | Sufficiency | Applied visible modifiers");
console.log("-".repeat(220));
for (const row of rows) {
  if (row.type === "ETF") {
    console.log(`${row.ticker} | ETF | — | ETF isolated | — | ETF | — | —`);
    continue;
  }
  const old = row.previous ? [row.previous.primaryClassification, row.previous.businessTrait, row.previous.riskTrait, row.previous.lifecycle].map(text).join(" / ") : "V2 baseline unavailable";
  const current = [row.current.primaryClassification, row.current.businessTrait, row.current.riskTrait, row.current.lifecycle].map(text).join(" / ");
  const sufficiency = Object.entries(row.current.profileSufficiency || {}).map(([slot, state]) => `${slot}:${state}`).join(", ");
  console.log(`${row.ticker} | stock | ${old} | ${current} | ${text(row.current.sizeClass)} | ${row.current.profileStatus} | ${sufficiency} | ${compact(row.effective.appliedModifiers)}`);
  if (details) {
    console.log(`  metadata: sector=${text(row.metadata.sector)}; industry=${text(row.metadata.industry)}; marketCap=${text(row.metadata.marketCap)}; revenueGrowth=${text(row.metadata.revenueGrowth)}; profitMargins=${text(row.metadata.profitMargins)}; beta=${text(row.metadata.beta)}`);
    console.log(`  evidence: primary=${compact(row.current.profileEvidence.primaryClassification)}; business=${compact(row.current.profileEvidence.businessTrait)}; risk=${compact(row.current.profileEvidence.riskTrait)}; lifecycle=${compact(row.current.profileEvidence.lifecycle)}; size=${compact(row.current.profileEvidence.sizeClass)}`);
    console.log(`  business candidates: ${row.explanation.businessCandidates.map((item) => `${item.value}=${item.score}/${item.minimum}${item.sufficient ? "*" : ""}`).join(", ")}`);
    console.log(`  lifecycle candidates: ${row.explanation.lifecycleCandidates.map((item) => `${item.value}=${item.score}/${item.minimum}${item.sufficient ? "*" : ""}`).join(", ")}`);
    console.log(`  persisted: ${row.persisted ? `${text(row.persisted.primary_classification)} / ${text(row.persisted.business_trait)} / ${text(row.persisted.risk_trait)} / ${text(row.persisted.lifecycle)}; schema=${text(row.persisted.profile_schema_version)}` : "none"}`);
    console.log(`  modifier provenance: ${row.effective.modifierProvenance.map((item) => `${item.slot}:${item.value}${item.visible ? "" : " (internal)"}`).join(", ") || "—"}`);
  }
}
const stocks = rows.filter((row) => row.type === "stock");
const summary = Object.fromEntries(["complete", "incomplete", "unavailable"].map((status) => [status, stocks.filter((row) => row.current.profileStatus === status).length]));
const sizeSummary = Object.fromEntries(["MegaCap", "NonMegaCap", "unclassified"].map((value) => [value, stocks.filter((row) => (row.current.sizeClass || "unclassified") === value).length]));
const slotSummary = (slot) => {
  const classified = stocks.filter((row) => row.current[slot] != null);
  const distribution = Object.fromEntries([...new Set(classified.map((row) => row.current[slot]))].sort().map((value) => [value, classified.filter((row) => row.current[slot] === value).length]));
  return { classified: classified.length, null: stocks.length - classified.length, distribution };
};
const primarySummary = slotSummary("primaryClassification");
const businessSummary = slotSummary("businessTrait");
const riskSummary = slotSummary("riskTrait");
const lifecycleSummary = slotSummary("lifecycle");
const concentrationWarnings = Object.entries(businessSummary.distribution)
  .filter(([, count]) => stocks.length > 0 && count / stocks.length >= 0.7)
  .map(([trait, count]) => `business concentration: ${trait} is ${count}/${stocks.length} (${Math.round((count / stocks.length) * 100)}%)`);
const semanticWarnings = [];
for (const row of stocks) {
  const { current, metadata } = row;
  const evidence = current.profileEvidence || {};
  const marketCap = Number(metadata.marketCap);
  const profitMargins = Number(metadata.profitMargins);
  if (!current.primaryClassification && metadata.industry) {
    semanticWarnings.push(`${row.ticker}: industry is available but Primary Classification is null`);
  }
  if (current.lifecycle === "Scaling" && Number.isFinite(marketCap) && marketCap >= 200_000_000_000 && Number.isFinite(profitMargins) && profitMargins >= 0.08) {
    semanticWarnings.push(`${row.ticker}: Scaling on a large profitable issuer; inspect structural evidence`);
  }
  if (current.lifecycle === "Recovery" && !(evidence.lifecycle || []).includes("summary:issuer_recovery")) {
    semanticWarnings.push(`${row.ticker}: Recovery without issuer-specific recovery evidence`);
  }
  if (current.lifecycle === "MatureLeader" && current.businessTrait === "EmergingGrowth") {
    semanticWarnings.push(`${row.ticker}: MatureLeader + EmergingGrowth contradiction`);
  }
  if (current.lifecycle === "Scaling" && current.businessTrait === "MatureGrowth") {
    semanticWarnings.push(`${row.ticker}: Scaling + MatureGrowth tension`);
  }
  if (current.lifecycle === "Declining" && current.businessTrait === "MarketLeader") {
    semanticWarnings.push(`${row.ticker}: Declining + MarketLeader tension`);
  }
  if (current.lifecycle === "Recovery" && current.businessTrait === "CashCow") {
    semanticWarnings.push(`${row.ticker}: Recovery + CashCow tension`);
  }
  if (current.profileStatus !== "complete") {
    const insufficient = Object.entries(current.profileSufficiency || {}).filter(([, state]) => state === "insufficient").map(([slot]) => slot);
    if (insufficient.length) semanticWarnings.push(`${row.ticker}: data insufficient for ${insufficient.join(", ")}`);
  }
}
console.log("\nAggregate classification:");
console.log(`ordinary stocks=${stocks.length}`);
for (const [label, value] of [["Primary", primarySummary], ["Business", businessSummary], ["Risk", riskSummary], ["Lifecycle", lifecycleSummary]]) {
  console.log(`${label}: classified=${value.classified}; null=${value.null}; distribution=${JSON.stringify(value.distribution)}`);
}
console.log(`Profile status: ${JSON.stringify(summary)}`);
console.log(`Size class: ${JSON.stringify(sizeSummary)}`);
console.log(`Concentration warnings: ${concentrationWarnings.length ? concentrationWarnings.join(" | ") : "none"}`);
console.log(`Semantic warnings: ${semanticWarnings.length ? semanticWarnings.join(" | ") : "none"}`);
console.log("Notes: V2 comparison is available only while the current Git HEAD still contains the V2 classifier. This audit never writes profiles, cache files, or decisions.");
