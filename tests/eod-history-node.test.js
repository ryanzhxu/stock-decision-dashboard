#!/usr/bin/env node
"use strict";

// The EOD process must use the production JS engine and persist only compact
// technical state. This test uses deterministic synthetic bars, never a
// provider/cache/network call.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const runner = path.join(ROOT, "历史记录", "生成决策快照.js");
const RAW_KEYS = new Set(["timestamps", "opens", "highs", "lows", "closes", "volumes", "bars", "series", "macd_series", "signal_series", "histogram_series"]);

function bars(count, start, increment, timestampStart = "2025-01-02") {
  const timestamps = [];
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  let value = start;
  let date = new Date(`${timestampStart}T16:00:00Z`);
  for (let index = 0; index < count; index += 1) {
    value += increment + Math.sin(index / 7) * 0.25;
    timestamps.push(date.toISOString().slice(0, 10));
    opens.push(value - 0.45); highs.push(value + 1.2); lows.push(value - 1.1); closes.push(value); volumes.push(1_000_000 + index * 5000);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return { timestamps, opens, highs, lows, closes, volumes, availability: "available", available: true, lookback: "2y" };
}

function intradayBars(count, start, increment, hoursPerBar) {
  const result = bars(count, start, increment);
  result.timestamps = result.timestamps.map((date, index) => `${date}T${String(9 + ((index * hoursPerBar) % 7)).padStart(2, "0")}:30:00-0400`);
  result.interval = hoursPerBar === 4 ? "4h" : "1h";
  result.source = "test";
  result.regular_hours_only = true;
  return result;
}

function quote(ticker, price = 180) {
  const end = new Date("2026-08-18T16:00:00Z");
  end.setUTCDate(end.getUTCDate() - 319);
  const daily = bars(320, price - 100, 0.32, end.toISOString().slice(0, 10));
  const oneHour = intradayBars(180, price - 20, 0.10, 1);
  const fourHour = intradayBars(150, price - 40, 0.18, 4);
  return {
    ticker, price: daily.closes.at(-1), quote_status: "available",
    history: { ...daily, intervals: { "1h": oneHour, "4h": fourHour }, daily_history_metadata: { lookback: "2y" } },
    metadata: { quoteType: ticker === "TQQQ" ? "ETF" : "EQUITY", sharesOutstanding: 1_000_000_000 },
    technical: { fibonacci_structure: {} },
  };
}

function hasRawSeries(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasRawSeries);
  return Object.entries(value).some(([key, child]) => RAW_KEYS.has(key) || /_series$/i.test(key) || hasRawSeries(child));
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "eod-history-node-"));
try {
  const qqq = quote("QQQ", 300);
  const tqqq = quote("TQQQ", 100);
  const stock = quote("STOCK", 180);
  stock.metadata = {
    quoteType: "EQUITY", industry: "Semiconductors", marketCap: 2_400_000_000_000,
    revenueGrowth: 0.28, profitMargins: 0.42, beta: 1.62,
    classification: {
      primaryClassification: "Semiconductors", businessTrait: "HighGrowth", riskTrait: "HighVolatility",
      lifecycle: "EstablishedLeader", sizeClass: "MegaCap", companyTraits: ["HighGrowth", "HighVolatility"], profileStatus: "complete",
      profileSource: "automatic", profileSchemaVersion: "2.1", profileConfidence: 0.82, lastProfileReview: "2026-03-31T03:30:00-04:00",
    },
  };
  const unavailable = { ticker: "NOPE", price: null, quote_status: "unavailable", history: { timestamps: [], closes: [], availability: "unavailable" }, metadata: { quoteType: "EQUITY" } };
  const stale = quote("STALE", 80);
  stale.history.timestamps[stale.history.timestamps.length - 1] = "2026-08-17";
  const input = {
    marketDate: "2026-08-18", recordedAtEt: "2026-08-18T16:30:00-04:00",
    payload: {
      items: [{ ticker: "QQQ", analysis: qqq }, { ticker: "TQQQ", analysis: tqqq }, { ticker: "STOCK", analysis: stock }, { ticker: "NOPE", analysis: unavailable }, { ticker: "STALE", analysis: stale }],
      marketContext: { market_context: { regime: "normal", equity_trend: { spy: { change_20d_pct: 1.5 }, qqq: { change_20d_pct: 2.1 } }, vix: { current: 18 } } },
    },
  };
  const inputPath = path.join(temporary, "input.json");
  const outputPath = path.join(temporary, "output.json");
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const run = spawnSync(process.execPath, [runner, inputPath, outputPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(output.records.length, 15, "every ticker must produce all three horizons");
  const qqqShort = output.records.find((row) => row.ticker === "QQQ" && row.horizon === "short");
  const tqqqLong = output.records.find((row) => row.ticker === "TQQQ" && row.horizon === "long");
  const nopeMid = output.records.find((row) => row.ticker === "NOPE" && row.horizon === "mid");
  const staleLong = output.records.find((row) => row.ticker === "STALE" && row.horizon === "long");
  const stockShort = output.records.find((row) => row.ticker === "STOCK" && row.horizon === "short");
  assert.equal(qqqShort.asset_type, "ETF");
  assert.equal(tqqqLong.leveraged, true);
  assert.equal(tqqqLong.etf_direction, "long");
  assert.equal(nopeMid.data_status, "unavailable");
  assert.equal(nopeMid.action, null);
  assert.equal(staleLong.data_status, "unavailable", "prior-day cache must not become a current EOD recommendation");
  assert.equal(stockShort.primary_classification, "Semiconductors");
  assert.deepEqual(stockShort.company_traits, ["HighGrowth", "HighVolatility"]);
  assert.equal(stockShort.business_trait, "HighGrowth");
  assert.equal(stockShort.size_class, "MegaCap", "EOD stores internal V2.1 size context without promoting it to a trait");
  assert.equal(stockShort.risk_trait, "HighVolatility");
  assert.equal(stockShort.profile_status, "complete");
  assert.equal(stockShort.profile_source, "automatic");
  assert.equal(stockShort.applied_profile_modifiers.profile_confidence, 0.82);
  assert.ok(qqqShort.technical_features, "available record includes compact canonical features");
  assert.equal(hasRawSeries(qqqShort.technical_features), false, "raw OHLCV and indicator series must never be persisted");
  assert.ok(Array.isArray(qqqShort.supporting_reasons));
  console.log("EOD history Node snapshot tests passed.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
