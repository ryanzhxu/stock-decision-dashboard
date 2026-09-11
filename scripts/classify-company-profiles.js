#!/usr/bin/env node
"use strict";

// Short-lived bridge for the server-side profile store. This intentionally
// invokes the browser/EOD canonical classifier rather than duplicating its
// taxonomy or rules in Python.
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const classifier = require(path.join(ROOT, "decision-engine", "company-profile-classifier.js"));

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: classify-company-profiles.js <input.json> <output.json>");
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const profiles = Object.fromEntries(Object.entries(input.metadataByTicker || {}).map(([ticker, metadata]) => [String(ticker).toUpperCase(), classifier.classify(metadata || {})]));
fs.writeFileSync(outputPath, JSON.stringify({ profiles }), "utf8");
