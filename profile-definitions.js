/* Shared, reviewable profile metadata. This is classification data, not a
 * recommendation score: the Decision Engine turns the relevant traits into
 * bounded behavior modifiers in decision-engine/company-profile.js. */
(function createProfileDefinitions(root) {
  "use strict";

  const classifier = root.CompanyProfileClassifier || (typeof require !== "undefined" ? require("./decision-engine/company-profile-classifier.js") : null);
  const freezeProfile = (profile) => Object.freeze({ ...profile, companyTraits: Object.freeze([...(profile.companyTraits || [])]) });
  // Profile Confidence remains intentionally unchanged during the V2.1 profile
  // migration. It is still a separate, existing confidence input—not an
  // inferred quality score from this classifier.
  const validSlot = (field, value) => {
    if (value == null) return null;
    const vocabulary = field === "primaryClassification" ? classifier?.PRIMARY_CLASSIFICATIONS
      : field === "businessTrait" ? classifier?.BUSINESS_TRAITS
        : field === "riskTrait" ? classifier?.RISK_TRAITS
          : field === "sizeClass" ? classifier?.SIZE_CLASSES : classifier?.LIFECYCLES;
    return vocabulary?.includes(value) ? value : null;
  };
  const stock = (profile = {}) => {
    const primaryClassification = validSlot("primaryClassification", profile.primaryClassification);
    const businessTrait = validSlot("businessTrait", profile.businessTrait);
    const riskTrait = validSlot("riskTrait", profile.riskTrait);
    const lifecycle = validSlot("lifecycle", profile.lifecycle);
    const sizeClass = validSlot("sizeClass", profile.sizeClass);
    const slots = [primaryClassification, businessTrait, riskTrait, lifecycle];
    const profileStatus = slots.every(Boolean) ? "complete" : slots.some(Boolean) ? "incomplete" : "unavailable";
    return freezeProfile({
    type: "stock", isETF: false,
    primaryClassification,
    businessTrait,
    riskTrait,
    companyTraits: [businessTrait, riskTrait].filter(Boolean),
    lifecycle,
    // Size is only internal context for bounded modifiers. It is deliberately
    // excluded from Company Traits and every presentation group.
    sizeClass,
    // Status is derived from canonical validated slots. A stale V2 database
    // status may not claim completeness after invalid legacy values are
    // removed during the V2.1 migration.
    profileStatus,
    profileSource: profile.profileSource || "automatic",
    profileEvidence: profile.profileEvidence || {},
    profileSufficiency: profile.profileSufficiency || {},
    profileSchemaVersion: profile.profileSchemaVersion || null,
    profileConfidence: Number.isFinite(profile.profileConfidence) ? profile.profileConfidence : 0.82,
    lastProfileReview: profile.lastProfileReview || null,
    });
  };
  const etf = (leveraged, direction, underlying, underlyingTicker = null) => Object.freeze({
    type: "etf", isETF: true, leveraged, direction, underlying, underlyingTicker,
  });

  // Ordinary stocks deliberately have no ticker-specific production map.
  // The server persists the canonical automatic result and the same
  // deterministic classifier provides a safe fallback for local/browser use.
  const stocks = Object.freeze({});

  const etfs = Object.freeze({
    QQQ: etf(false, "long", "Nasdaq-100", "QQQ"),
    SPMO: etf(false, "long", "S&P 500 Momentum", "SPY"),
    TQQQ: etf(true, "long", "Nasdaq-100", "QQQ"),
    SQQQ: etf(true, "inverse", "Nasdaq-100", "QQQ"),
    SOXL: etf(true, "long", "Semiconductor Sector", "SOXX"),
    SOXS: etf(true, "inverse", "Semiconductor Sector", "SOXX"),
  });

  function profileFor(ticker, metadata = {}) {
    const symbol = String(ticker || "").toUpperCase();
    if (etfs[symbol]) return etfs[symbol];
    const type = String(metadata.quoteType || metadata.quote_type || "").toUpperCase();
    if (type === "ETF") return etf(false, "long", metadata.longName || metadata.name || symbol, null);
    const persisted = metadata.classification || metadata.companyProfile || {};
    const automatic = classifier?.classify?.(metadata) || {};
    // A persisted V2 field wins only when it belongs to the canonical
    // vocabulary.  This prevents any prior generic/legacy payload from
    // leaking into the UI or modifier pipeline during migration.
    const persistedSlots = {
      primaryClassification: validSlot("primaryClassification", persisted.primaryClassification || persisted.primary_classification),
      businessTrait: validSlot("businessTrait", persisted.businessTrait || persisted.business_trait),
      riskTrait: validSlot("riskTrait", persisted.riskTrait || persisted.risk_trait),
      lifecycle: validSlot("lifecycle", persisted.lifecycle || persisted.lifecycle_tag),
      sizeClass: validSlot("sizeClass", persisted.sizeClass || persisted.size_class),
    };
    return stock({
      ...automatic,
      ...persisted,
      primaryClassification: persistedSlots.primaryClassification || automatic.primaryClassification,
      businessTrait: persistedSlots.businessTrait || automatic.businessTrait,
      riskTrait: persistedSlots.riskTrait || automatic.riskTrait,
      lifecycle: persistedSlots.lifecycle || automatic.lifecycle,
      sizeClass: persistedSlots.sizeClass || automatic.sizeClass,
      profileSchemaVersion: persisted.profileSchemaVersion || persisted.profile_schema_version || automatic.profileSchemaVersion,
    });
  }

  const api = Object.freeze({ stocks, etfs, profileFor });
  root.ProfileDefinitions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(globalThis));
