// Scoring, ported from scripts/rank.py so there is one implementation rather
// than a Python engine drifting from a TypeScript UI. The design decisions it
// carries are the ones that took the longest to get right:
//
//   * Ardent's own descriptors beat anything inferred. Fund type, investment
//     geography, sector and cheque band come off the Investor Control Sheet,
//     which is maintained by hand for the purpose of deciding who to approach.
//     Crawled strategy tags and HQ country are the fallback, not the source.
//   * Stated fit and revealed fit are scored SEPARATELY and never summed.
//     Portfolio evidence exists for ~3.5% of investors; adding it to a total
//     would rank the crawl schedule rather than the investors.
//   * Missing signals score zero rather than being excluded from the average.
//     Normalising over present signals only gave a perfect score to anyone
//     merely based in the right country.
//   * Hard filters exclude on KNOWN failure only. Most investors have no
//     investment geography on file, and dropping them would remove a third of
//     the market from every UK mandate because of a gap in our own data.
//   * Past engagement is not a signal. A fund passes for timing or fund cycle
//     far more often than for fit, so scoring on declines would penalise the
//     busiest and most relevant houses.

export type Mandate = {
  // Recorded for the eventual report, no longer scored. It used to drive deal
  // type through a mandate-to-strategy map, which put "sell side" in a dropdown
  // above a list of investors — and there is no such thing as a sell-side
  // investor. Fund type is the investor's own attribute and is now chosen
  // directly.
  mandate_type: string | null;
  fund_types: string[];
  country_code: string | null;
  expected_ev_gbp: number | null;
  revenue_gbp: number | null;
  sector: string | null;
  business_description: string | null;
  hard_filters: string[];
  required_countries: string[];
};

export type Investor = {
  company_id: string;
  legal_name: string;
  country_code: string | null;
  fund_type: string | null;
  invest_geographies: string[];
  ardent_sector: string | null;
  check_band: string | null;
  cheque_min: number | null;
  cheque_max: number | null;
  cheque_source: string | null;
  strategies: string[];
  focus: string[];
  grade: string | null;
  never_approach: boolean;
  holdings: number;
  blob: string;
  recent: number;
  latest: number | null;
};

export const WEIGHTS: Record<string, number> = {
  sector_fit: 0.35,
  size_fit: 0.25,
  deal_type_fit: 0.2,
  geography_fit: 0.2,
};
const REVEALED: Record<string, number> = {
  thesis_similarity: 0.65,
  recent_activity: 0.35,
};

// Ardent's own fund categories, in the order the Investor Control Sheet lists
// them. This IS the vocabulary — nothing infers it, and the analyst edits it.
export const ARDENT_FUND_TYPES: [string, string][] = [
  ["hnw", "High Net Worth"],
  ["family_office", "Family Office"],
  ["vct", "EIS / VCT"],
  ["vc", "VC"],
  ["mbo", "MBO"],
  ["lbo", "LBO"],
  ["lp", "LP"],
  ["multi_strategy_am", "Multi-Strategy AM"],
  ["corp_strategy_office", "Corp Strategy Office"],
];

export function fundTypeLabel(key: string | null): string {
  if (!key) return "";
  return ARDENT_FUND_TYPES.find(([k]) => k === key)?.[1] || key.replace(/_/g, " ");
}

// Deal type is scored only when the analyst has named the fund types they want.
// Selecting none is not a missing signal about the investor — it is a question
// nobody asked — so the weight is removed rather than scored zero, which is the
// opposite of how a genuinely absent attribute is treated everywhere else here.
function weightsFor(m: Mandate): Record<string, number> {
  if (m.fund_types && m.fund_types.length) return WEIGHTS;
  const { deal_type_fit, ...rest } = WEIGHTS;
  void deal_type_fit;
  return rest;
}

// The sheet records where a fund DEPLOYS as one of four regions. A mandate
// arrives with an ISO country code, so it has to be lifted to the same grain.
// Not exhaustive by design: an unlisted country yields no region, which means
// no geography signal rather than a wrong one.
const COUNTRY_TO_REGION: Record<string, string> = {
  GB: "UK",
  IE: "EU", FR: "EU", DE: "EU", NL: "EU", BE: "EU", LU: "EU", ES: "EU", PT: "EU",
  IT: "EU", AT: "EU", CH: "EU", DK: "EU", SE: "EU", NO: "EU", FI: "EU", PL: "EU",
  CZ: "EU", GR: "EU",
  US: "NA", CA: "NA", MX: "NA",
  CN: "ASIA", HK: "ASIA", JP: "ASIA", SG: "ASIA", IN: "ASIA", KR: "ASIA",
  TW: "ASIA", MY: "ASIA", ID: "ASIA", AE: "ASIA", IL: "ASIA",
};

export function regionFor(country: string | null): string | null {
  return country ? COUNTRY_TO_REGION[country.toUpperCase()] || null : null;
}

// A mandate is written in a banker's vocabulary; investor sector focus comes
// from Crunchbase's. "Retail technology" and "Commerce and Shopping" mean the
// same thing and share no words. Kept small and explicit on purpose — an
// unauditable synonym table is worse than a missing bridge.
const CONCEPTS: Record<string, string[]> = {
  commerce: ["retail", "retailer", "retailers", "consumer", "shopping", "commerce",
    "ecommerce", "checkout", "grocery", "store", "stores", "brand", "brands", "fashion"],
  software: ["software", "saas", "platform", "application", "applications", "apps", "cloud"],
  technology: ["technology", "information", "digital", "tech"],
  internet: ["internet", "online", "marketplace"],
  data: ["data", "analytics", "artificial", "intelligence", "machine", "vision"],
  fintech: ["fintech", "payments", "payment", "lending", "banking", "insurance", "wealth"],
  health: ["health", "healthcare", "medical", "clinical", "pharma", "biotechnology", "care"],
  media: ["media", "entertainment", "content", "publishing", "gaming"],
  industrial: ["manufacturing", "industrial", "engineering", "science", "materials"],
  energy: ["energy", "renewable", "cleantech", "climate"],
  property: ["property", "estate", "proptech", "construction"],
  transport: ["transport", "transportation", "logistics", "mobility", "automotive"],
  mobile: ["mobile", "telecom", "telecoms", "wireless"],
  security: ["security", "privacy", "cyber"],
  hardware: ["hardware", "electronics", "devices", "semiconductor", "robotics"],
  commercial: ["sales", "marketing", "recruitment", "staffing", "education"],
};

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "company",
  "companies", "business", "group", "limited", "market", "leading", "provider",
  "services", "service", "solutions", "platform", "products", "customers", "growth"]);

export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of (text || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

export function concepts(words: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const [name, vocab] of Object.entries(CONCEPTS)) {
    if (vocab.some((v) => words.has(v))) out.add(name);
  }
  return out;
}

// Ardent's own sector label leads, because it was written about this fund by
// someone deciding whether to call them. Crawled focus tags follow.
function sectorTerms(inv: Investor): string[] {
  const out: string[] = [];
  if (inv.ardent_sector) out.push(inv.ardent_sector);
  for (const f of inv.focus || []) if (f) out.push(f);
  return out;
}

export function excludedBy(m: Mandate, inv: Investor, want: Set<string>): string | null {
  if (inv.never_approach) return "graded never-approach";
  const hard = new Set(m.hard_filters || []);

  if (hard.has("geography")) {
    // Where the fund DEPLOYS, not where it keeps its office. Known failure
    // only: an empty list is a gap in our data, not a reason to hide a fund.
    const region = regionFor(m.country_code);
    const theirs = inv.invest_geographies || [];
    if (region && theirs.length && !theirs.includes(region)) {
      return `does not invest in ${region}`;
    }
  }
  if (hard.has("fund_type") && (m.fund_types || []).length) {
    // Known failure only, as everywhere else: ~200 investors carry no fund type
    // on the sheet and are kept rather than hidden by a gap in our own record.
    if (inv.fund_type && !m.fund_types.includes(inv.fund_type)) {
      return `not ${m.fund_types.map(fundTypeLabel).join("/")}`;
    }
  }
  if (hard.has("sector") && want.size) {
    const terms = sectorTerms(inv);
    if (terms.length) {
      const theirs = concepts(keywords(terms.join(" ")));
      if (![...theirs].some((c) => want.has(c))) return "sector mismatch";
    }
  }
  if (hard.has("size")) {
    const target = m.expected_ev_gbp ?? m.revenue_gbp;
    if (target && inv.cheque_min != null && inv.cheque_max != null) {
      if (target < Number(inv.cheque_min) || target > Number(inv.cheque_max)) {
        return "cheque range excludes the mandate";
      }
    }
  }
  return null;
}

export type Scored = Investor & {
  stated: number;
  revealed: number | null;
  reasons: Record<string, string>;
};

export function score(
  m: Mandate, inv: Investor, want: Set<string>, wantConcepts: Set<string>
): Scored {
  const stated: Record<string, number> = {};
  const revealed: Record<string, number> = {};
  const reasons: Record<string, string> = {};

  const terms = sectorTerms(inv);
  if (terms.length && wantConcepts.size) {
    const theirs = concepts(keywords(terms.join(" ")));
    const shared = [...wantConcepts].filter((c) => theirs.has(c));
    stated.sector_fit = shared.length / wantConcepts.size;
    if (shared.length) {
      const matched = terms.filter((t) =>
        [...concepts(keywords(t))].some((c) => shared.includes(c)));
      const src = inv.ardent_sector && matched.includes(inv.ardent_sector)
        ? "Ardent records focus on" : "states focus on";
      reasons.sector_fit = `${src} ${matched.slice(0, 3).join(", ")}`;
    }
  }

  if ((m.fund_types || []).length) {
    stated.deal_type_fit = inv.fund_type && m.fund_types.includes(inv.fund_type) ? 1 : 0;
    if (stated.deal_type_fit === 1) {
      reasons.deal_type_fit = `${fundTypeLabel(inv.fund_type)} on the Ardent list`;
    }
  }

  const target = m.expected_ev_gbp ?? m.revenue_gbp;
  if (target && (inv.cheque_min != null || inv.cheque_max != null)) {
    const lo = Number(inv.cheque_min ?? 0);
    const hi = Number(inv.cheque_max ?? lo * 10);
    const band = inv.cheque_source === "ardent_band" ? inv.check_band : null;
    if (lo <= target && target <= hi) {
      stated.size_fit = 1;
      reasons.size_fit = band
        ? `Ardent bands them at ${band}, mandate at ${(target / 1e6).toFixed(0)}m`
        : `writes ${(lo / 1e6).toFixed(0)}–${(hi / 1e6).toFixed(0)}m, mandate at ${(target / 1e6).toFixed(0)}m`;
    } else {
      // Orders of magnitude, so 2x out is not the same as 50x out.
      const edge = target < lo ? lo : hi;
      const ratio = Math.max(target, edge) / Math.max(Math.min(target, edge), 1);
      stated.size_fit = Math.max(0, 1 - (ratio - 1) / 4);
    }
  }

  const region = regionFor(m.country_code);
  const theirs = inv.invest_geographies || [];
  if (region && theirs.length) {
    stated.geography_fit = theirs.includes(region) ? 1 : 0;
    if (theirs.includes(region)) reasons.geography_fit = `invests in ${theirs.join(", ")}`;
  } else if (m.country_code && inv.country_code) {
    // No deployment regions on file — fall back to the office, and say so by
    // scoring it lower than a stated match ever gets.
    stated.geography_fit = inv.country_code === m.country_code ? 0.6 : 0.2;
    if (inv.country_code === m.country_code) {
      reasons.geography_fit = `office in ${inv.country_code} (no investment geography on file)`;
    }
  }

  if (inv.blob) {
    const theirWords = keywords(inv.blob);
    const shared = [...want].filter((w) => theirWords.has(w));
    if (want.size) {
      revealed.thesis_similarity = Math.min(1, (shared.length / want.size) * 2);
      if (shared.length) {
        reasons.thesis_similarity =
          `portfolio overlaps on ${shared.slice(0, 5).join(", ")}`;
      }
    }
  }
  if (inv.holdings > 0) {
    revealed.recent_activity = Math.min(1, (inv.recent || 0) / 5);
    if (inv.latest) {
      reasons.recent_activity =
        `${inv.recent} investments in the last 4 years, most recent ${inv.latest}`;
    }
  }

  // Divide by ALL weights: a missing signal is unknown, not neutral, so
  // knowing three things about an investor beats knowing one.
  const blend = (s: Record<string, number>, w: Record<string, number>) => {
    if (!Object.keys(s).length) return 0;
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    return Object.entries(w).reduce((acc, [k, weight]) => acc + (s[k] || 0) * weight, 0) / total;
  };

  return {
    ...inv,
    stated: Number(blend(stated, weightsFor(m)).toFixed(4)),
    revealed: Object.keys(revealed).length
      ? Number(blend(revealed, REVEALED).toFixed(4))
      : null,
    reasons,
  };
}
