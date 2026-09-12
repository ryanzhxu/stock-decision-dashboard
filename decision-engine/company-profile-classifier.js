/* Deterministic, metadata-only Company Profile V2.1 classifier.
 *
 * Company identity is intentionally derived only from slow-moving provider
 * metadata. It never reads a ticker, current price, Technical state, Action,
 * or Recommendation. Numeric evidence thresholds are centralized in
 * decision-engine/config.js under profile.classifier.
 */
(function createCompanyProfileClassifier(root) {
  "use strict";

  const PRIMARY_CLASSIFICATIONS = Object.freeze([
    "Semiconductors", "Semiconductor Equipment", "Enterprise Software", "Cloud Infrastructure", "Consumer Technology", "Internet Platforms", "Media & Entertainment", "E-Commerce", "Digital Advertising", "Telecommunications Infrastructure", "Capital Markets", "Banking", "Digital Financial Services", "Payments", "Insurance", "Managed Care & Health Services", "Pharmaceuticals", "Biotechnology", "Medical Devices", "Consumer Discretionary", "Consumer Staples", "Retail", "Industrials", "Aerospace & Defense", "Transportation & Logistics", "Energy", "Utilities", "Real Estate", "Materials",
  ]);
  const BUSINESS_TRAITS = Object.freeze(["MarketLeader", "HighGrowth", "MatureGrowth", "CashCow", "Defensive", "Cyclical", "Turnaround", "EmergingGrowth"]);
  const RISK_TRAITS = Object.freeze(["HighVolatility", "RegulatoryRisk", "InterestRateSensitive", "CommoditySensitive", "MacroSensitive", "CrowdedLeader", "ExecutionRisk", "LowVolatility"]);
  const LIFECYCLES = Object.freeze(["Emerging", "Scaling", "EstablishedLeader", "MatureLeader", "Recovery", "Declining"]);
  const SIZE_CLASSES = Object.freeze(["MegaCap", "NonMegaCap"]);
  const SETS = Object.freeze({ primary: new Set(PRIMARY_CLASSIFICATIONS), business: new Set(BUSINESS_TRAITS), risk: new Set(RISK_TRAITS), lifecycle: new Set(LIFECYCLES), size: new Set(SIZE_CLASSES) });

  const text = (value) => String(value || "").toLowerCase();
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const includes = (source, expression) => expression.test(source);
  const fact = (name, value) => Number.isFinite(value) ? `${name}:${Math.round(value * 10000) / 10000}` : null;
  const cleanEvidence = (items) => [...new Set(items.flat(Infinity).filter(Boolean))].slice(0, 6);
  const compactSource = (input) => ({
    sector: input.sector || null, industry: input.industry || null,
    marketCap: input.marketCap, revenueGrowth: input.revenueGrowth,
    profitMargins: input.profitMargins, beta: input.beta,
    summaryAvailable: Boolean(input.summary),
  });

  function rules() {
    const value = root.DecisionEngine?.config?.profile?.classifier;
    if (!value) throw new Error("Company Profile classifier requires decision-engine/config.js to load first");
    return value;
  }

  function schemaVersion() {
    return root.DecisionEngine?.config?.profile?.schemaVersion || null;
  }

  function source(metadata = {}) {
    const industry = text(metadata.industry);
    const sector = text(metadata.sector);
    const summary = text(metadata.businessSummary || metadata.longBusinessSummary || metadata.shortBusinessSummary);
    return {
      industry, sector, summary, all: `${industry} ${sector} ${summary}`,
      marketCap: number(metadata.marketCap), revenueGrowth: number(metadata.revenueGrowth),
      profitMargins: number(metadata.profitMargins), beta: number(metadata.beta),
    };
  }

  function primaryClassification(input) {
    const { industry, sector, summary } = input;
    const match = (value, pattern, label, evidence) => includes(value, pattern) ? { value: label, evidence: [evidence] } : null;
    // Provider industry is the controlled first-order description. Summary is
    // only a fallback because it routinely describes adjacent activities.
    const byIndustry = (
      match(industry, /managed care|health(?:care)?\s*plans?|health insurance/, "Managed Care & Health Services", "industry:managed_care")
      || match(industry, /medical device|medical instrument|diagnostic equipment/, "Medical Devices", "industry:medical_devices")
      || match(industry, /biotechnology|biotech/, "Biotechnology", "industry:biotechnology")
      || match(industry, /drug manufacturer|pharmaceutical|pharma/, "Pharmaceuticals", "industry:pharmaceuticals")
      || match(industry, /semiconductor equipment|semiconductor material|wafer fabrication equipment/, "Semiconductor Equipment", "industry:semiconductor_equipment")
      || match(industry, /semiconductor|computer hardware/, "Semiconductors", "industry:semiconductors")
      || match(industry, /entertainment|broadcasting|movie|television programming|streaming/, "Media & Entertainment", "industry:media_entertainment")
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
      match(summary, /managed care|health(?:care)?\s*plans?|health insurance/, "Managed Care & Health Services", "summary:managed_care")
      || match(summary, /medical device|medical instrument|diagnostic equipment/, "Medical Devices", "summary:medical_devices")
      || match(summary, /biotechnology|biotech|clinical.stage|therapeutics/, "Biotechnology", "summary:biotechnology")
      || match(summary, /pharmaceutical|pharma/, "Pharmaceuticals", "summary:pharmaceuticals")
      || match(summary, /semiconductor|gpu|foundry|memory chip/, "Semiconductors", "summary:semiconductors")
      || match(summary, /streaming|entertainment services|television series|feature films|live programming|broadcasting/, "Media & Entertainment", "summary:media_entertainment")
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
      || null
    );
  }

  function scored(value, score, evidence, minimum) {
    return { value, score, evidence: cleanEvidence(evidence), minimum, sufficient: score >= minimum };
  }

  function selectScored(candidates, order) {
    const ranked = [...candidates].sort((left, right) => right.score - left.score || order.indexOf(left.value) - order.indexOf(right.value));
    return { selected: ranked.find((candidate) => candidate.sufficient) || null, candidates: ranked };
  }

  function businessTrait(input, primary) {
    const { marketCap, revenueGrowth, profitMargins, summary } = input;
    const cfg = rules().business;
    const threshold = cfg.thresholds;
    const minimum = cfg.minimumEvidence;
    const points = cfg.points;
    const leaderLanguage = /(market leader|leading provider|leading platform|global leader|industry leader)/.test(summary);
    const scalableLanguage = /(software as a service|\bsaas\b|cloud.native platform|usage.based platform|subscription.based software|scalable platform)/.test(summary);
    const cyclicalLanguage = /(cyclical demand|economic cycle|commodity cycle|seasonal cycle|capital spending cycle|memory cycle)/.test(summary);
    const issuerTurnaround = /(the company|company).{0,80}(turnaround|restructur|reorganiz|transformation)/.test(summary)
      || /(executing|implementing|undergoing).{0,60}(a )?(turnaround|restructur|reorganiz)/.test(summary);
    const earlyCommercial = /(early.stage|development.stage|emerging company|commercialization stage)/.test(summary);
    const candidates = [
      scored("MarketLeader",
        (marketCap != null && marketCap >= threshold.leaderMarketCap ? points.leaderScale : 0) + (profitMargins != null && profitMargins >= threshold.leaderMargin ? points.leaderMargin : 0) + (leaderLanguage ? points.leaderLanguage : 0),
        [marketCap != null && marketCap >= threshold.leaderMarketCap ? fact("market_cap", marketCap) : null, profitMargins != null && profitMargins >= threshold.leaderMargin ? fact("profit_margin", profitMargins) : null, leaderLanguage ? "summary:leadership" : null], minimum.MarketLeader),
      scored("HighGrowth",
        (revenueGrowth != null && revenueGrowth >= threshold.highGrowthStrong ? points.highGrowthStrong : revenueGrowth != null && revenueGrowth >= threshold.highGrowth ? points.highGrowthBase : 0) + (marketCap != null && marketCap >= threshold.highGrowthScaleFloor ? points.highGrowthScale : 0) + (profitMargins != null && profitMargins >= threshold.highGrowthProfitMarginFloor ? points.highGrowthProfitability : 0) + (scalableLanguage ? points.highGrowthScalableBusiness : 0),
        [revenueGrowth != null && revenueGrowth >= threshold.highGrowth ? fact("revenue_growth", revenueGrowth) : null, marketCap != null && marketCap >= threshold.highGrowthScaleFloor ? fact("market_cap", marketCap) : null, profitMargins != null && profitMargins >= threshold.highGrowthProfitMarginFloor ? fact("profit_margin", profitMargins) : null, scalableLanguage ? "summary:scalable_business" : null], minimum.HighGrowth),
      scored("MatureGrowth",
        (marketCap != null && marketCap >= threshold.matureGrowthMarketCap ? points.matureGrowthScale : 0) + (revenueGrowth != null && revenueGrowth >= threshold.matureGrowthLow && revenueGrowth < threshold.matureGrowthHigh ? points.matureGrowthGrowth : 0) + (profitMargins != null && profitMargins >= threshold.matureGrowthMargin ? points.matureGrowthMargin : 0),
        [marketCap != null && marketCap >= threshold.matureGrowthMarketCap ? fact("market_cap", marketCap) : null, revenueGrowth != null && revenueGrowth >= threshold.matureGrowthLow && revenueGrowth < threshold.matureGrowthHigh ? fact("revenue_growth", revenueGrowth) : null, profitMargins != null && profitMargins >= threshold.matureGrowthMargin ? fact("profit_margin", profitMargins) : null], minimum.MatureGrowth),
      scored("CashCow",
        (marketCap != null && marketCap >= threshold.cashCowMarketCap ? points.cashCowScale : 0) + (profitMargins != null && profitMargins >= threshold.cashCowMargin ? points.cashCowMargin : 0) + (revenueGrowth != null && revenueGrowth < threshold.cashCowGrowthCeiling ? points.cashCowLowGrowth : 0),
        [marketCap != null && marketCap >= threshold.cashCowMarketCap ? fact("market_cap", marketCap) : null, profitMargins != null && profitMargins >= threshold.cashCowMargin ? fact("profit_margin", profitMargins) : null, revenueGrowth != null && revenueGrowth < threshold.cashCowGrowthCeiling ? fact("revenue_growth", revenueGrowth) : null], minimum.CashCow),
      scored("Defensive",
        (["Consumer Staples", "Utilities", "Managed Care & Health Services"].includes(primary) ? points.defensivePrimary : 0) + (profitMargins != null && profitMargins >= threshold.defensiveMargin ? points.defensiveMargin : 0),
        [["Consumer Staples", "Utilities", "Managed Care & Health Services"].includes(primary) ? `primary:${primary}` : null, profitMargins != null && profitMargins >= threshold.defensiveMargin ? fact("profit_margin", profitMargins) : null], minimum.Defensive),
      scored("Cyclical", cyclicalLanguage ? points.cyclicalLanguage : 0, [cyclicalLanguage ? "summary:cyclical_business" : null], minimum.Cyclical),
      scored("Turnaround", issuerTurnaround ? points.turnaroundLanguage : 0, [issuerTurnaround ? "summary:issuer_turnaround" : null], minimum.Turnaround),
      scored("EmergingGrowth",
        (marketCap != null && marketCap < threshold.emergingGrowthMarketCap ? points.emergingGrowthScale : 0) + (revenueGrowth != null && revenueGrowth >= threshold.emergingGrowth ? points.emergingGrowthGrowth : 0) + ((profitMargins != null && profitMargins <= threshold.emergingMarginCeiling) || earlyCommercial ? points.emergingGrowthCondition : 0),
        [marketCap != null && marketCap < threshold.emergingGrowthMarketCap ? fact("market_cap", marketCap) : null, revenueGrowth != null && revenueGrowth >= threshold.emergingGrowth ? fact("revenue_growth", revenueGrowth) : null, profitMargins != null && profitMargins <= threshold.emergingMarginCeiling ? fact("profit_margin", profitMargins) : null, earlyCommercial ? "summary:early_commercial" : null], minimum.EmergingGrowth),
    ];
    return selectScored(candidates, cfg.tieBreakOrder);
  }

  function riskTrait(input, primary) {
    const { beta, summary } = input;
    const threshold = rules().risk;
    if (["Biotechnology", "Pharmaceuticals", "Managed Care & Health Services"].includes(primary) || /(antitrust|regulatory approval|clinical trial|\bfda\b)/.test(summary)) return { value: "RegulatoryRisk", evidence: [primary ? `primary:${primary}` : null, /(antitrust|regulatory approval|clinical trial|\bfda\b)/.test(summary) ? "summary:regulatory" : null].filter(Boolean), sufficient: true };
    if (["Real Estate", "Utilities", "Banking", "Insurance", "Capital Markets"].includes(primary)) return { value: "InterestRateSensitive", evidence: [`primary:${primary}`], sufficient: true };
    if (["Energy", "Materials"].includes(primary)) return { value: "CommoditySensitive", evidence: [`primary:${primary}`], sufficient: true };
    if (["Consumer Discretionary", "E-Commerce", "Retail", "Transportation & Logistics", "Digital Advertising", "Digital Financial Services"].includes(primary)) return { value: "MacroSensitive", evidence: [`primary:${primary}`], sufficient: true };
    if (/(clinical.stage|pre.revenue|development.stage|going concern)/.test(summary)) return { value: "ExecutionRisk", evidence: ["summary:execution_risk"], sufficient: true };
    if (beta != null && beta >= threshold.highBeta) return { value: "HighVolatility", evidence: [fact("beta", beta)], sufficient: true };
    if (beta != null && beta <= threshold.lowBeta) return { value: "LowVolatility", evidence: [fact("beta", beta)], sufficient: true };
    // CrowdedLeader has no robust metadata-only source. It intentionally
    // remains null rather than being guessed from size, performance, or price.
    return { value: null, evidence: [], sufficient: false };
  }

  function lifecycle(input, business) {
    const { marketCap, revenueGrowth, profitMargins, summary } = input;
    const cfg = rules().lifecycle;
    const threshold = cfg.thresholds;
    const points = cfg.points;
    const issuerDecline = /(the company|company).{0,80}(declining business|secular decline|wind.?down)/.test(summary);
    const issuerRecovery = /(the company|company).{0,80}(recovery plan|turnaround|restructur|reorganiz|business transformation)/.test(summary)
      || /(executing|implementing|undergoing).{0,60}(a )?(recovery plan|turnaround|restructur|reorganiz)/.test(summary);
    const earlyStage = /(early.stage|development.stage|clinical.stage|emerging company)/.test(summary);
    const scalableBusiness = /(software as a service|\bsaas\b|cloud.native platform|usage.based platform|subscription.based software|scalable platform)/.test(summary);
    const candidates = [
      scored("Declining", issuerDecline ? points.decliningLanguage : 0, [issuerDecline ? "summary:issuer_declining" : null], cfg.minimumEvidence.Declining),
      scored("Recovery", issuerRecovery ? points.recoveryLanguage : 0, [issuerRecovery ? "summary:issuer_recovery" : null], cfg.minimumEvidence.Recovery),
      scored("Emerging",
        (marketCap != null && marketCap <= threshold.emergingMarketCap ? points.emergingScale : 0) + (earlyStage ? points.emergingStage : 0),
        [marketCap != null && marketCap <= threshold.emergingMarketCap ? fact("market_cap", marketCap) : null, earlyStage ? "summary:early_stage" : null], cfg.minimumEvidence.Emerging),
      scored("Scaling",
        (revenueGrowth != null && revenueGrowth >= threshold.scalingGrowth ? points.scalingGrowth : 0) + (marketCap != null && marketCap < threshold.scalingMarketCapCeiling ? points.scalingNonHugeScale : 0) + (scalableBusiness ? points.scalingScalableBusiness : 0),
        [revenueGrowth != null && revenueGrowth >= threshold.scalingGrowth ? fact("revenue_growth", revenueGrowth) : null, marketCap != null && marketCap < threshold.scalingMarketCapCeiling ? fact("market_cap", marketCap) : null, scalableBusiness ? "summary:scalable_business" : null], cfg.minimumEvidence.Scaling),
      scored("EstablishedLeader",
        (marketCap != null && marketCap >= threshold.establishedMarketCap ? points.establishedScale : 0) + (profitMargins != null && profitMargins >= threshold.establishedMargin ? points.establishedMargin : 0) + (business?.value === "MarketLeader" ? points.establishedBusinessLeader : 0),
        [marketCap != null && marketCap >= threshold.establishedMarketCap ? fact("market_cap", marketCap) : null, profitMargins != null && profitMargins >= threshold.establishedMargin ? fact("profit_margin", profitMargins) : null, business?.value === "MarketLeader" ? "business:MarketLeader" : null], cfg.minimumEvidence.EstablishedLeader),
      scored("MatureLeader",
        (marketCap != null && marketCap >= threshold.matureMarketCap ? points.matureScale : 0) + (profitMargins != null && profitMargins >= threshold.matureMargin ? points.matureMargin : 0) + (revenueGrowth != null && revenueGrowth >= threshold.matureGrowthFloor && revenueGrowth < threshold.matureGrowthCeiling ? points.matureGrowth : 0),
        [marketCap != null && marketCap >= threshold.matureMarketCap ? fact("market_cap", marketCap) : null, profitMargins != null && profitMargins >= threshold.matureMargin ? fact("profit_margin", profitMargins) : null, revenueGrowth != null && revenueGrowth >= threshold.matureGrowthFloor && revenueGrowth < threshold.matureGrowthCeiling ? fact("revenue_growth", revenueGrowth) : null], cfg.minimumEvidence.MatureLeader),
    ];
    return selectScored(candidates, cfg.tieBreakOrder);
  }

  function sizeClass(input) {
    const threshold = rules().sizeClass.megaCapMarketCap;
    if (input.marketCap == null) return { value: null, evidence: [], sufficient: false };
    return input.marketCap >= threshold
      ? { value: "MegaCap", evidence: [fact("market_cap", input.marketCap)], sufficient: true }
      : { value: "NonMegaCap", evidence: [fact("market_cap", input.marketCap)], sufficient: true };
  }

  function classifyInput(input) {
    const primary = primaryClassification(input) || { value: null, evidence: [] };
    const business = businessTrait(input, primary.value);
    const risk = riskTrait(input, primary.value);
    const life = lifecycle(input, business.selected);
    const size = sizeClass(input);
    const selectedBusiness = business.selected || { value: null, evidence: [], sufficient: false };
    const selectedLifecycle = life.selected || { value: null, evidence: [], sufficient: false };
    const complete = Boolean(primary.value && selectedBusiness.value && risk.value && selectedLifecycle.value);
    const any = Boolean(primary.value || selectedBusiness.value || risk.value || selectedLifecycle.value);
    return {
      type: "stock", isETF: false,
      primaryClassification: SETS.primary.has(primary.value) ? primary.value : null,
      businessTrait: SETS.business.has(selectedBusiness.value) ? selectedBusiness.value : null,
      riskTrait: SETS.risk.has(risk.value) ? risk.value : null,
      lifecycle: SETS.lifecycle.has(selectedLifecycle.value) ? selectedLifecycle.value : null,
      sizeClass: SETS.size.has(size.value) ? size.value : null,
      profileSchemaVersion: schemaVersion(),
      companyTraits: [selectedBusiness.value, risk.value].filter(Boolean),
      profileStatus: complete ? "complete" : any ? "incomplete" : "unavailable",
      profileSource: "automatic",
      profileSufficiency: {
        primaryClassification: primary.value ? "sufficient" : "insufficient",
        businessTrait: selectedBusiness.sufficient ? "sufficient" : "insufficient",
        riskTrait: risk.sufficient ? "sufficient" : "insufficient",
        lifecycle: selectedLifecycle.sufficient ? "sufficient" : "insufficient",
        sizeClass: size.sufficient ? "sufficient" : "insufficient",
      },
      profileEvidence: {
        primaryClassification: cleanEvidence(primary.evidence),
        businessTrait: cleanEvidence(selectedBusiness.evidence),
        riskTrait: cleanEvidence(risk.evidence),
        lifecycle: cleanEvidence(selectedLifecycle.evidence),
        sizeClass: cleanEvidence(size.evidence),
      },
      _diagnostics: { source: compactSource(input), businessCandidates: business.candidates, lifecycleCandidates: life.candidates },
    };
  }

  function classify(metadata = {}) {
    if (String(metadata.quoteType || metadata.quote_type || "").toUpperCase() === "ETF") return null;
    const result = classifyInput(source(metadata));
    delete result._diagnostics;
    return result;
  }

  function explain(metadata = {}) {
    if (String(metadata.quoteType || metadata.quote_type || "").toUpperCase() === "ETF") return { type: "etf", isETF: true };
    const result = classifyInput(source(metadata));
    const diagnostics = result._diagnostics;
    delete result._diagnostics;
    return { result, ...diagnostics };
  }

  function validProfile(profile = {}) {
    return (profile.primaryClassification == null || SETS.primary.has(profile.primaryClassification))
      && (profile.businessTrait == null || SETS.business.has(profile.businessTrait))
      && (profile.riskTrait == null || SETS.risk.has(profile.riskTrait))
      && (profile.lifecycle == null || SETS.lifecycle.has(profile.lifecycle))
      && (profile.sizeClass == null || SETS.size.has(profile.sizeClass));
  }

  const api = Object.freeze({ PRIMARY_CLASSIFICATIONS, BUSINESS_TRAITS, RISK_TRAITS, LIFECYCLES, SIZE_CLASSES, classify, explain, validProfile });
  root.CompanyProfileClassifier = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(globalThis));
