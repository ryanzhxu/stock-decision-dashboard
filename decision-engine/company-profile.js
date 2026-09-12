(function createProfileEngine(root) {
  "use strict";

  const engine = root.DecisionEngine || (root.DecisionEngine = {});
  const classifier = root.CompanyProfileClassifier || null;
  const reviewCache = new Map();
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const dateFor = (value) => value ? new Date(value) : null;
  const validDate = (date) => date && !Number.isNaN(date.getTime()) ? date : null;
  const fields = ["primaryClassification", "businessTrait", "riskTrait", "lifecycle"];

  function blankModifiers() {
    return {
      directionWeights: {}, confirmationWeights: {}, riskSensitivity: 1, exhaustionSensitivity: 1,
      marketSensitivity: 1, normalAtrTolerance: 1, strongBuyOpportunity: 1, rateSensitivity: 1,
      eventSensitivity: 1, longStability: 1, confidenceScale: 1,
      actionGates: { buyDirection: 0, buyConfirmation: 0, strongBuyDirection: 0, strongBuyConfirmation: 0 },
      benchmarkWeights: { spy: 0.5, qqq: 0.5 },
    };
  }

  function cacheKey(ticker) { return String(ticker || "").toUpperCase(); }
  function cachedState(ticker) { return reviewCache.get(cacheKey(ticker)) || null; }
  function isAllowed(field, value) {
    if (value == null) return true;
    const vocabulary = field === "primaryClassification" ? classifier?.PRIMARY_CLASSIFICATIONS
      : field === "businessTrait" ? classifier?.BUSINESS_TRAITS
        : field === "riskTrait" ? classifier?.RISK_TRAITS
          : field === "sizeClass" ? classifier?.SIZE_CLASSES : classifier?.LIFECYCLES;
    return !vocabulary || vocabulary.includes(value);
  }

  function normalizeProfile(source = {}, fallback = {}) {
    const legacyTraits = Array.isArray(source.companyTraits) ? source.companyTraits : [];
    const profile = {
      primaryClassification: source.primaryClassification ?? source.primary_classification ?? fallback.primaryClassification ?? null,
      businessTrait: source.businessTrait ?? source.business_trait ?? legacyTraits[0] ?? fallback.businessTrait ?? null,
      riskTrait: source.riskTrait ?? source.risk_trait ?? legacyTraits[1] ?? fallback.riskTrait ?? null,
      lifecycle: source.lifecycle ?? source.lifecycleTag ?? source.lifecycle_tag ?? fallback.lifecycle ?? null,
      sizeClass: source.sizeClass ?? source.size_class ?? fallback.sizeClass ?? null,
    };
    [...fields, "sizeClass"].forEach((field) => { if (!isAllowed(field, profile[field])) profile[field] = null; });
    profile.companyTraits = [profile.businessTrait, profile.riskTrait].filter(Boolean);
    const complete = fields.every((field) => Boolean(profile[field]));
    const partial = fields.some((field) => Boolean(profile[field]));
    // Derive status from validated V2.1 slots instead of trusting a stale
    // persisted V2 status whose legacy values were discarded above.
    profile.profileStatus = complete ? "complete" : partial ? "incomplete" : "unavailable";
    profile.profileSource = source.profileSource || source.profile_source || "automatic";
    profile.profileEvidence = source.profileEvidence || source.profile_evidence || {};
    profile.profileSufficiency = source.profileSufficiency || source.profile_sufficiency || fallback.profileSufficiency || {};
    profile.profileSchemaVersion = source.profileSchemaVersion || source.profile_schema_version || fallback.profileSchemaVersion || null;
    // Do not alter Profile Confidence or its contribution to final Confidence.
    profile.profileConfidence = Number.isFinite(source.profileConfidence) ? clamp(source.profileConfidence, 0, 1)
      : Number.isFinite(fallback.profileConfidence) ? clamp(fallback.profileConfidence, 0, 1) : 0.82;
    profile.lastProfileReview = source.lastProfileReview || source.last_profile_review || fallback.lastProfileReview || null;
    return profile;
  }

  function capMultiplier(value, special = false) {
    const [low, high] = engine.config.profile.modifierCaps[special ? "special" : "normal"];
    return clamp(value, low, high);
  }

  function effectiveModifiers(input = {}, legacyLifecycle = null) {
    const profile = Array.isArray(input)
      ? normalizeProfile({ companyTraits: input, lifecycle: legacyLifecycle })
      : normalizeProfile(input);
    const aggregate = blankModifiers();
    const appliedModifiers = [];
    const modifierProvenance = [];
    const modifierSources = [
      [profile.primaryClassification, engine.config.profile.primaryClassificationModifiers, "primaryClassification", true],
      [profile.businessTrait, engine.config.profile.businessTraitModifiers, "businessTrait", true],
      [profile.riskTrait, engine.config.profile.riskTraitModifiers, "riskTrait", true],
      [profile.lifecycle, engine.config.profile.lifecycleModifiers, "lifecycle", true],
      // Size is a bounded internal modifier only. It intentionally does not
      // enter Company Traits or the user-visible Applied Modifiers list.
      [profile.sizeClass, engine.config.profile.sizeClassModifiers, "sizeClass", false],
    ];
    modifierSources.forEach(([value, table, slot, visible]) => {
      const modifier = value && table?.[value];
      if (!modifier) return;
      if (visible) appliedModifiers.push(value);
      modifierProvenance.push({ slot, value, visible: Boolean(visible) });
      Object.entries(modifier.directionWeights || {}).forEach(([key, delta]) => { aggregate.directionWeights[key] = (aggregate.directionWeights[key] || 0) + Number(delta || 0); });
      Object.entries(modifier.confirmationWeights || {}).forEach(([key, delta]) => { aggregate.confirmationWeights[key] = (aggregate.confirmationWeights[key] || 0) + Number(delta || 0); });
      Object.entries(modifier.benchmarkWeights || {}).forEach(([key, delta]) => { aggregate.benchmarkWeights[key] = (aggregate.benchmarkWeights[key] || 0) + Number(delta || 0); });
      ["riskSensitivity", "exhaustionSensitivity", "marketSensitivity", "normalAtrTolerance", "strongBuyOpportunity", "rateSensitivity", "eventSensitivity", "longStability"].forEach((key) => {
        if (Number.isFinite(modifier[key])) aggregate[key] += modifier[key];
      });
      Object.entries(modifier.actionGates || {}).forEach(([key, delta]) => { aggregate.actionGates[key] = (aggregate.actionGates[key] || 0) + Number(delta || 0); });
    });
    Object.keys(aggregate.directionWeights).forEach((key) => { aggregate.directionWeights[key] = capMultiplier(1 + aggregate.directionWeights[key]) - 1; });
    Object.keys(aggregate.confirmationWeights).forEach((key) => { aggregate.confirmationWeights[key] = capMultiplier(1 + aggregate.confirmationWeights[key]) - 1; });
    ["riskSensitivity", "exhaustionSensitivity", "marketSensitivity", "normalAtrTolerance", "strongBuyOpportunity", "rateSensitivity", "eventSensitivity", "longStability"].forEach((key) => {
      aggregate[key] = capMultiplier(aggregate[key], ["marketSensitivity", "exhaustionSensitivity", "rateSensitivity", "eventSensitivity"].includes(key));
    });
    Object.keys(aggregate.actionGates).forEach((key) => { aggregate.actionGates[key] = clamp(Math.round(aggregate.actionGates[key]), 0, 12); });
    const benchmarkTotal = aggregate.benchmarkWeights.spy + aggregate.benchmarkWeights.qqq;
    aggregate.benchmarkWeights = benchmarkTotal > 0
      ? { spy: aggregate.benchmarkWeights.spy / benchmarkTotal, qqq: aggregate.benchmarkWeights.qqq / benchmarkTotal }
      : { spy: 0.5, qqq: 0.5 };
    return { modifiers: aggregate, appliedModifiers, modifierProvenance };
  }

  function easternParts(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: engine.config.profile.review.timeZone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  }

  // Shared March 31 ET review date—not a rolling duration. A stock added
  // after the date waits until March 31 of the next calendar year.
  function annualReviewDue(lastReview, now = new Date()) {
    const today = easternParts(now);
    const prior = easternParts(validDate(dateFor(lastReview)));
    if (!today || !prior) return true;
    if (today.month < engine.config.profile.review.annualReviewMonth
      || (today.month === engine.config.profile.review.annualReviewMonth && today.day < engine.config.profile.review.annualReviewDay)) return false;
    return prior.year < today.year;
  }

  function review({ ticker, profile = {}, now = new Date() } = {}) {
    const key = cacheKey(ticker);
    if (!key) return null;
    const prior = cachedState(key);
    if (prior && !annualReviewDue(prior.lastProfileReview, now)) return prior;
    // Sparse review data may add evidence, but cannot erase a valid field.
    const next = normalizeProfile(profile, prior || {});
    next.lastProfileReview = now.toISOString();
    reviewCache.set(key, next);
    while (reviewCache.size > engine.config.profile.review.cacheLimit) reviewCache.delete(reviewCache.keys().next().value);
    return next;
  }

  function build(classification = {}, ticker = "") {
    if (classification.isETF || classification.type === "etf") return engine.etfProfile.build(classification);
    const profile = normalizeProfile(classification, cachedState(ticker) || {});
    const modifierSet = effectiveModifiers(profile);
    return {
      type: "stock", isETF: false, ...profile,
      effectiveModifiers: modifierSet.modifiers,
      appliedModifiers: modifierSet.appliedModifiers,
      modifierProvenance: modifierSet.modifierProvenance,
    };
  }

  function forHorizon(profile, horizon) { return profile?.isETF ? engine.etfProfile.forHorizon(profile, horizon) : profile; }

  engine.profile = Object.freeze({ build, review, forHorizon, annualReviewDue, clearReviews: () => reviewCache.clear(), _reviewCache: reviewCache, effectiveModifiers, normalizeProfile });
}(globalThis));
