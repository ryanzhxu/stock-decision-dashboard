/* Deterministic, metadata-only Company Profile V2 classifier.
 *
 * This module deliberately does not inspect a ticker symbol or recent price
 * action. It classifies slow-moving business identity from compact provider
 * metadata, leaving an uncertain slot null rather than inventing a trait.
 */
(function createCompanyProfileClassifier(root) {
  "use strict";

  const PRIMARY_CLASSIFICATIONS = Object.freeze([
    "Semiconductors", "Semiconductor Equipment", "Enterprise Software", "Cloud Infrastructure", "Consumer Technology", "Internet Platforms", "E-Commerce", "Digital Advertising", "Telecommunications Infrastructure", "Capital Markets", "Banking", "Digital Financial Services", "Payments", "Insurance", "Managed Care & Health Services", "Pharmaceuticals", "Biotechnology", "Medical Devices", "Consumer Discretionary", "Consumer Staples", "Retail", "Industrials", "Aerospace & Defense", "Transportation & Logistics", "Energy", "Utilities", "Real Estate", "Materials",
  ]);
  const BUSINESS_TRAITS = Object.freeze(["MegaCap", "MarketLeader", "HighGrowth", "MatureGrowth", "CashCow", "Defensive", "Cyclical", "Turnaround"]);
  const RISK_TRAITS = Object.freeze(["HighVolatility", "RegulatoryRisk", "InterestRateSensitive", "CommoditySensitive", "MacroSensitive", "CrowdedLeader", "ExecutionRisk", "LowVolatility"]);
  const LIFECYCLES = Object.freeze(["Emerging", "Scaling", "EstablishedLeader", "MatureLeader", "Recovery", "Declining"]);
  const SETS = Object.freeze({ primary: new Set(PRIMARY_CLASSIFICATIONS), business: new Set(BUSINESS_TRAITS), risk: new Set(RISK_TRAITS), lifecycle: new Set(LIFECYCLES) });

  const text = (value) => String(value || "").toLowerCase();
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const includes = (source, expression) => expression.test(source);
  const cleanEvidence = (items) => [...new Set(items.filter(Boolean))].slice(0, 4);
  const fact = (name, value) => Number.isFinite(value) ? `${name}:${Math.round(value * 100) / 100}` : null;

  function source(metadata = {}) {
    const industry = text(metadata.industry);
    const sector = text(metadata.sector);
    const summary = text(metadata.businessSummary || metadata.longBusinessSummary || metadata.shortBusinessSummary);
    return { industry, sector, summary, all: `${industry} ${sector} ${summary}`, marketCap: number(metadata.marketCap), revenueGrowth: number(metadata.revenueGrowth), profitMargins: number(metadata.profitMargins), beta: number(metadata.beta) };
  }

  function primaryClassification(input) {
    const { industry, sector, summary } = input;
    const match = (source, pattern, label, evidence) => includes(source, pattern) ? { value: label, evidence } : null;
    // Provider industry is a controlled, first-order description of the
    // company.  A long business summary commonly mentions customers,
    // suppliers, adjacent products, and historical partnerships, so it must
    // never override an available specific industry (for example, an Internet
    // retailer that mentions cloud or a consumer-device company that mentions
    // advertising).  Summary is a fallback only when the provider industry
    // cannot map to the fixed taxonomy.
    const byIndustry = (
      match(industry, /managed care|health plan|health insurance/, "Managed Care & Health Services", "industry:managed_care")
      || match(industry, /medical device|medical instrument|diagnostic equipment/, "Medical Devices", "industry:medical_devices")
      || match(industry, /biotechnology|biotech/, "Biotechnology", "industry:biotechnology")
      || match(industry, /drug manufacturer|pharmaceutical|pharma/, "Pharmaceuticals", "industry:pharmaceuticals")
      || match(industry, /semiconductor equipment|semiconductor material|wafer fabrication equipment/, "Semiconductor Equipment", "industry:semiconductor_equipment")
      || match(industry, /semiconductor|computer hardware/, "Semiconductors", "industry:semiconductors")
      || match(industry, /aerospace|defense contractor|defence contractor/, "Aerospace & Defense", "industry:aerospace_defense")
      || match(industry, /air freight|airline|railroad|trucking|logistics|transportation/, "Transportation & Logistics", "industry:transportation")
      || match(industry, /telecom|telecommunication|communication equipment|wireless/, "Telecommunications Infrastructure", "industry:telecommunications")
      || match(industry, /capital markets|investment bank|securities broker|asset management|exchange operator/, "Capital Markets", "industry:capital_markets")
      || match(industry, /banks|banking|regional bank|commercial bank/, "Banking", "industry:banking")
      || match(industry, /insurance|insurance broker/, "Insurance", "industry:insurance")
      || match(industry, /payment processing|payments network|merchant acquiring/, "Payments", "industry:payments")
      || match(industry, /fintech|financial technology|digital banking|consumer lending|credit services/, "Digital Financial Services", "industry:digital_financial_services")
      || match(industry, /real estate investment trust|real estate services|real estate development/, "Real Estate", "industry:real_estate")
      || match(industry, /utilities|electric utility|gas utility|water utility/, "Utilities", "industry:utilities")
      || match(industry, /oil|gas|energy equipment|solar|uranium|coal/, "Energy", "industry:energy")
      || match(industry, /steel|aluminum|mining|gold|copper|chemicals|building materials/, "Materials", "industry:materials")
      || match(industry, /internet retail|e-commerce|ecommerce|online retail|online marketplace/, "E-Commerce", "industry:ecommerce")
      || match(industry, /advertising agency|advertising|ad tech|marketing/, "Digital Advertising", "industry:digital_advertising")
      || match(industry, /internet content|internet information|social media|search engine|online media/, "Internet Platforms", "industry:internet_platform")
      || match(industry, /cloud infrastructure|cloud computing|data center|hosting/, "Cloud Infrastructure", "industry:cloud_infrastructure")
      || match(industry, /software.*application|software.*infrastructure|enterprise software|workflow|database software|saas/, "Enterprise Software", "industry:enterprise_software")
      || match(industry, /consumer electronics|consumer technology|smartphone|personal computer|wearable/, "Consumer Technology", "industry:consumer_technology")
      || match(industry, /retail|apparel|department store|specialty store/, "Retail", "industry:retail")
      || match(industry, /auto manufacturer|automobile|leisure|restaurants|travel services/, "Consumer Discretionary", "industry:consumer_discretionary")
      || match(industry, /industrial|electrical equipment|machinery|engineering|conglomerates/, "Industrials", "industry:industrials")
    );
    if (byIndustry) return byIndustry;
    const bySector = (
      match(sector, /consumer staples/, "Consumer Staples", "sector:consumer_staples")
      || match(sector, /consumer cyclical/, "Consumer Discretionary", "sector:consumer_discretionary")
      || match(sector, /basic materials/, "Materials", "sector:materials")
      || match(sector, /energy/, "Energy", "sector:energy")
      || match(sector, /utilities/, "Utilities", "sector:utilities")
      || match(sector, /real estate/, "Real Estate", "sector:real_estate")
      || match(sector, /industrials/, "Industrials", "sector:industrials")
    );
    if (bySector) return bySector;
    return (
      match(summary, /managed care|health plan|health insurance/, "Managed Care & Health Services", "summary:managed_care")
      || match(summary, /medical device|medical instrument|diagnostic equipment/, "Medical Devices", "summary:medical_devices")
      || match(summary, /biotechnology|biotech|clinical.stage|therapeutics/, "Biotechnology", "summary:biotechnology")
      || match(summary, /pharmaceutical|pharma/, "Pharmaceuticals", "summary:pharmaceuticals")
      || match(summary, /semiconductor|gpu|foundry|memory chip/, "Semiconductors", "summary:semiconductors")
      || match(summary, /aerospace|defense contractor|defence contractor/, "Aerospace & Defense", "summary:aerospace_defense")
      || match(summary, /air freight|airline|railroad|trucking|logistics|transportation/, "Transportation & Logistics", "summary:transportation")
      || match(summary, /telecom|telecommunication|wireless infrastructure|network equipment/, "Telecommunications Infrastructure", "summary:telecommunications")
      || match(summary, /capital markets|investment bank|securities broker|asset management|exchange operator/, "Capital Markets", "summary:capital_markets")
      || match(summary, /payment processing|payments network|merchant acquiring/, "Payments", "summary:payments")
      || match(summary, /fintech|financial technology|digital banking/, "Digital Financial Services", "summary:digital_financial_services")
      || match(summary, /e-commerce|ecommerce|online marketplace/, "E-Commerce", "summary:ecommerce")
      || match(summary, /digital advertising|advertising platform|ad tech|marketing technology/, "Digital Advertising", "summary:digital_advertising")
      || match(summary, /social platform|social media|search engine|online media platform/, "Internet Platforms", "summary:internet_platform")
      || match(summary, /cloud infrastructure|cloud computing infrastructure|data.?center.*cloud|hosting infrastructure/, "Cloud Infrastructure", "summary:cloud_infrastructure")
      || match(summary, /enterprise software|workflow|database software|saas/, "Enterprise Software", "summary:enterprise_software")
      || match(summary, /consumer electronics|consumer technology|smartphone|personal computer|wearable/, "Consumer Technology", "summary:consumer_technology")
      || (industry || summary ? { value: null, evidence: null } : null)
    );
  }

  function businessTrait(input, primary) {
    const { marketCap, revenueGrowth, profitMargins, summary } = input;
    if (marketCap != null && marketCap >= 200_000_000_000) return { value: "MegaCap", evidence: [fact("market_cap", marketCap)] };
    if (revenueGrowth != null && revenueGrowth >= 0.18) return { value: "HighGrowth", evidence: [fact("revenue_growth", revenueGrowth)] };
    if (profitMargins != null && profitMargins >= 0.20 && marketCap != null && marketCap >= 10_000_000_000) return { value: "CashCow", evidence: [fact("profit_margin", profitMargins), fact("market_cap", marketCap)] };
    if (/(market leader|leading provider|leading platform|global leader)/.test(summary) && marketCap != null && marketCap >= 10_000_000_000) return { value: "MarketLeader", evidence: ["summary:market_leader", fact("market_cap", marketCap)] };
    // A classification alone is not proof of a business trait.  Sector
    // exposure is handled by the primary-classification modifier; a Cyclical
    // trait needs direct description evidence instead of treating every chip
    // or industrial company as identical.
    if (/(cyclical demand|economic cycle|commodity cycle|seasonal cycle)/.test(summary)) return { value: "Cyclical", evidence: ["summary:cyclical"] };
    if (["Consumer Staples", "Utilities", "Managed Care & Health Services"].includes(primary) && profitMargins != null && profitMargins >= 0.08) return { value: "Defensive", evidence: [`primary:${primary}`, fact("profit_margin", profitMargins)] };
    if (marketCap != null && marketCap >= 40_000_000_000 && revenueGrowth != null && revenueGrowth >= 0.03 && revenueGrowth < 0.18 && profitMargins != null && profitMargins >= 0.10) return { value: "MatureGrowth", evidence: [fact("market_cap", marketCap), fact("revenue_growth", revenueGrowth), fact("profit_margin", profitMargins)] };
    if (/(turnaround|restructuring|reorganization)/.test(summary)) return { value: "Turnaround", evidence: ["summary:turnaround"] };
    return { value: null, evidence: [] };
  }

  function riskTrait(input, primary) {
    const { beta, summary } = input;
    if (["Biotechnology", "Pharmaceuticals", "Managed Care & Health Services"].includes(primary) || /(antitrust|regulatory approval|clinical trial|fda)/.test(summary)) return { value: "RegulatoryRisk", evidence: [primary ? `primary:${primary}` : null, /(antitrust|regulatory approval|clinical trial|fda)/.test(summary) ? "summary:regulatory" : null].filter(Boolean) };
    if (["Real Estate", "Utilities", "Banking", "Insurance", "Capital Markets"].includes(primary)) return { value: "InterestRateSensitive", evidence: [`primary:${primary}`] };
    if (["Energy", "Materials"].includes(primary)) return { value: "CommoditySensitive", evidence: [`primary:${primary}`] };
    if (["Consumer Discretionary", "E-Commerce", "Retail", "Transportation & Logistics", "Digital Advertising", "Digital Financial Services"].includes(primary)) return { value: "MacroSensitive", evidence: [`primary:${primary}`] };
    if (/(clinical.stage|pre.revenue|development.stage|going concern)/.test(summary)) return { value: "ExecutionRisk", evidence: ["summary:execution_risk"] };
    if (beta != null && beta >= 1.45) return { value: "HighVolatility", evidence: [fact("beta", beta)] };
    if (beta != null && beta <= 0.75) return { value: "LowVolatility", evidence: [fact("beta", beta)] };
    return { value: null, evidence: [] };
  }

  function lifecycle(input, business) {
    const { marketCap, revenueGrowth, profitMargins, summary } = input;
    if (/(declining business|secular decline|wind.?down)/.test(summary)) return { value: "Declining", evidence: ["summary:declining"] };
    if (/(turnaround|restructuring|recovery plan)/.test(summary)) return { value: "Recovery", evidence: ["summary:recovery"] };
    if (marketCap != null && marketCap <= 2_000_000_000 && /(early.stage|development.stage|clinical.stage|emerging company)/.test(summary)) return { value: "Emerging", evidence: [fact("market_cap", marketCap), "summary:early_stage"] };
    if (revenueGrowth != null && revenueGrowth >= 0.18 && marketCap != null && marketCap >= 2_000_000_000) return { value: "Scaling", evidence: [fact("revenue_growth", revenueGrowth), fact("market_cap", marketCap)] };
    if (marketCap != null && marketCap >= 200_000_000_000 && (profitMargins == null || profitMargins >= 0.08 || business === "MegaCap")) return { value: "EstablishedLeader", evidence: [fact("market_cap", marketCap), fact("profit_margin", profitMargins)] };
    if (marketCap != null && marketCap >= 40_000_000_000 && profitMargins != null && profitMargins >= 0.10 && revenueGrowth != null && revenueGrowth >= 0 && revenueGrowth < 0.12) return { value: "MatureLeader", evidence: [fact("market_cap", marketCap), fact("revenue_growth", revenueGrowth), fact("profit_margin", profitMargins)] };
    return { value: null, evidence: [] };
  }

  function classify(metadata = {}) {
    if (String(metadata.quoteType || metadata.quote_type || "").toUpperCase() === "ETF") return null;
    const input = source(metadata);
    const primary = primaryClassification(input);
    const primaryValue = primary?.value || null;
    const business = businessTrait(input, primaryValue);
    const risk = riskTrait(input, primaryValue);
    const life = lifecycle(input, business.value);
    const complete = Boolean(primaryValue && business.value && risk.value && life.value);
    const any = Boolean(primaryValue || business.value || risk.value || life.value);
    return {
      type: "stock", isETF: false,
      primaryClassification: SETS.primary.has(primaryValue) ? primaryValue : null,
      businessTrait: SETS.business.has(business.value) ? business.value : null,
      riskTrait: SETS.risk.has(risk.value) ? risk.value : null,
      lifecycle: SETS.lifecycle.has(life.value) ? life.value : null,
      companyTraits: [business.value, risk.value].filter(Boolean),
      profileStatus: complete ? "complete" : any ? "incomplete" : "unavailable",
      profileSource: "automatic",
      profileEvidence: {
        primaryClassification: cleanEvidence([primary?.evidence]),
        businessTrait: cleanEvidence(business.evidence),
        riskTrait: cleanEvidence(risk.evidence),
        lifecycle: cleanEvidence(life.evidence),
      },
    };
  }

  function validProfile(profile = {}) {
    return (profile.primaryClassification == null || SETS.primary.has(profile.primaryClassification))
      && (profile.businessTrait == null || SETS.business.has(profile.businessTrait))
      && (profile.riskTrait == null || SETS.risk.has(profile.riskTrait))
      && (profile.lifecycle == null || SETS.lifecycle.has(profile.lifecycle));
  }

  const api = Object.freeze({ PRIMARY_CLASSIFICATIONS, BUSINESS_TRAITS, RISK_TRAITS, LIFECYCLES, classify, validProfile });
  root.CompanyProfileClassifier = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(globalThis));
