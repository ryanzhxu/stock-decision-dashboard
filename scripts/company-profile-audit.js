#!/usr/bin/env node
"use strict";

// Read-only migration audit.  This is deliberately outside production code:
// it compares the automatic V2 classifier with the prior checked-in manual
// profile definitions using whatever compact metadata is already cached.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const classifier = require(path.join(ROOT, "decision-engine", "company-profile-classifier.js"));
for (const file of ["config.js", "etf-profile.js", "company-profile.js"]) {
  require(path.join(ROOT, "decision-engine", file));
}
const profileEngine = globalThis.DecisionEngine.profile;
const CACHE_DIRECTORY = path.join(ROOT, "data", "cache", "quotes");

function oldProfilesFromGit() {
  try {
    const source = childProcess.execFileSync("git", ["show", "HEAD:profile-definitions.js"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const context = { globalThis: {} };
    vm.runInNewContext(source, context, { timeout: 1000 });
    return context.globalThis.ProfileDefinitions?.stocks || {};
  } catch {
    return {};
  }
}

function quoteFromCache(file) {
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  return cached?.quote || cached || {};
}

function text(value) { return value == null ? "—" : String(value); }
function compactTraits(value) { return Array.isArray(value) && value.length ? value.join(", ") : "—"; }

const previous = oldProfilesFromGit();
const rows = fs.existsSync(CACHE_DIRECTORY)
  ? fs.readdirSync(CACHE_DIRECTORY).filter((file) => file.endsWith(".json")).sort().map((file) => {
    const ticker = path.basename(file, ".json");
    const quote = quoteFromCache(path.join(CACHE_DIRECTORY, file));
    const metadata = quote.metadata || {};
    const old = previous[ticker] || null;
    const automatic = classifier.classify(metadata);
    const effective = automatic ? profileEngine.build(automatic, ticker) : null;
    return { ticker, old, automatic, effective, metadataPresent: Object.keys(metadata).length > 0 };
  })
  : [];

console.log("Company Profile V2 migration audit (cache-only; no provider requests)");
console.log("Ticker | Old primary | Auto primary | Old traits | Auto business | Auto risk | Old lifecycle | Auto lifecycle | Status | Applied modifiers");
console.log("-".repeat(180));
for (const row of rows) {
  if (!row.automatic) {
    console.log(`${row.ticker} | ${text(row.old?.primaryClassification)} | ETF | ${compactTraits(row.old?.companyTraits)} | — | — | ${text(row.old?.lifecycle)} | — | ETF | ${compactTraits(row.effective?.appliedModifiers)}`);
    continue;
  }
  console.log([
    row.ticker,
    text(row.old?.primaryClassification),
    text(row.automatic.primaryClassification),
    compactTraits(row.old?.companyTraits),
    text(row.automatic.businessTrait),
    text(row.automatic.riskTrait),
    text(row.old?.lifecycle),
    text(row.automatic.lifecycle),
    row.automatic.profileStatus,
    compactTraits(row.effective?.appliedModifiers),
  ].join(" | "));
}
const stockRows = rows.filter((row) => row.automatic);
const status = stockRows.reduce((groups, row) => {
  const key = row.automatic.profileStatus;
  (groups[key] ||= []).push(row);
  return groups;
}, {});
console.log(`\nSummary: ${stockRows.length} cached stocks; complete=${status.complete?.length || 0}, incomplete=${status.incomplete?.length || 0}, unavailable=${status.unavailable?.length || 0}.`);
console.log("Note: cache files created before V2 may lack marketCap/revenueGrowth/profitMargins/beta. Those slots correctly remain null until the normal live refresh supplies compact metadata.");
