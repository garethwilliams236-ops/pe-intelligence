// The contact vocabularies, in one place.
//
// Seniority is the FUND ladder — managing partner, partner, principal — not the
// CRM's c_suite / evp / svp, which describes a corporate. Function is the CRM's
// own list, unchanged, because a CFO is a CFO in either system and that is the
// field a banker actually filters on.
//
// Both are closed lists on purpose. A free-text title is still captured beside
// them; what these give you is something you can group by.

export const SENIORITY: [string, string][] = [
  ["managing_partner", "Managing Partner"],
  ["partner", "Partner"],
  ["operating_partner", "Operating Partner"],
  ["venture_partner", "Venture Partner"],
  ["principal", "Principal"],
  ["director", "Director"],
  ["investment_manager", "Investment Manager"],
  ["associate", "Associate"],
  ["analyst", "Analyst"],
  ["chair", "Chair"],
  ["non_executive_director", "Non-Executive Director"],
  ["ceo", "Chief Executive"],
  ["cfo", "Chief Financial Officer"],
  ["other_executive", "Other Executive"],
  ["other", "Other"],
];

export const FUNCTION: [string, string][] = [
  ["ceo", "CEO"],
  ["cfo", "CFO"],
  ["coo", "COO"],
  ["corp_dev", "Corporate Development"],
  ["gc", "General Counsel"],
  ["ir", "Investor Relations"],
  ["board", "Board"],
  ["other", "Other"],
];

export const SENIORITY_KEYS = SENIORITY.map(([k]) => k);
export const FUNCTION_KEYS = FUNCTION.map(([k]) => k);

export function label(list: [string, string][], key: string | null): string {
  if (!key) return "";
  return list.find(([k]) => k === key)?.[1] || key;
}

export const seniorityLabel = (k: string | null) => label(SENIORITY, k);
export const functionLabel = (k: string | null) => label(FUNCTION, k);

// Same rule the fund loader uses: case, punctuation and spacing collapse, so
// "Jean-Pierre O'Brien" and "Jean Pierre OBrien" are one person for the purpose
// of noticing you are about to add them twice.
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Split a typed name into parts without pretending to be clever about it. The
// middle is whatever sits between the first and last word, which is right for
// "Sarah Jane Collins" and wrong for "van der Berg" — so the form shows what it
// derived and lets it be corrected.
export function splitName(full: string): {
  first_name: string | null; middle_name: string | null; last_name: string | null;
} {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: null, middle_name: null, last_name: null };
  if (parts.length === 1) return { first_name: parts[0], middle_name: null, last_name: null };
  return {
    first_name: parts[0],
    middle_name: parts.length > 2 ? parts.slice(1, -1).join(" ") : null,
    last_name: parts[parts.length - 1],
  };
}
