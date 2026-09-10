// The fields an analyst can override, in one place, because the grid, the record
// editor and the audit trail must agree on what is editable and what the legal
// values are. A field that is a free-text box in one place and a dropdown in
// another produces exactly the data mess this screen exists to clean up.

import { ARDENT_FUND_TYPES } from "@/lib/rank";

export type Editor = "select" | "chips" | "text" | "textarea" | "number";

export type FieldDef = {
  key: string;
  label: string;
  editor: Editor;
  options?: [string, string][];   // value, label
  hint?: string;
};

// The five bands the Investor Control Sheet uses, written exactly as the sheet
// writes them — including the stray space in the top band — because the view
// that turns a band into a numeric range matches on these strings.
export const CHEQUE_BANDS: [string, string][] = [
  ["£0-5m", "£0–5m"],
  ["£5-20m", "£5–20m"],
  ["£20-60m", "£20–60m"],
  ["£60-200m", "£60–200m"],
  ["£200- £900m", "£200–900m"],
];

export const GEOGRAPHIES: [string, string][] = [
  ["UK", "UK"], ["EU", "Europe"], ["NA", "North America"], ["ASIA", "Asia"],
];

// Ordered by how much the ranking depends on them. Fund type and cheque band
// carry the two hard filters an analyst actually reaches for, so they come
// first and everything else is secondary.
export const EDITABLE: FieldDef[] = [
  { key: "fund_type", label: "Fund type", editor: "select", options: ARDENT_FUND_TYPES,
    hint: "Authoritative. Overrides anything inferred from strategy tags." },
  { key: "check_band", label: "Cheque band", editor: "select", options: CHEQUE_BANDS,
    hint: "Overrides the scraped numeric range wherever the two disagree." },
  { key: "invest_geographies", label: "Invests in", editor: "chips", options: GEOGRAPHIES,
    hint: "Where the money goes, not where the office is." },
  { key: "ardent_sector", label: "Sector", editor: "text" },
  { key: "quality_score", label: "Quality", editor: "number", hint: "1–5." },
  { key: "priority", label: "Priority", editor: "text" },
  { key: "engagement_level", label: "Engagement", editor: "text" },
  { key: "key_investments", label: "Key investments", editor: "textarea" },
];

// Contact details. These live on `companies`, not `investors`, so the API
// writes them in a separate statement — but they are edited on the same screen
// and audited into the same trail, because "where is this fund and how do I
// ring it" is one question to the person asking it.
export const COMPANY_FIELDS: FieldDef[] = [
  { key: "address_line", label: "Address", editor: "textarea",
    hint: "Nothing loads this — it is yours to fill in." },
  { key: "city", label: "City", editor: "text" },
  { key: "postcode", label: "Postcode", editor: "text" },
  { key: "phone", label: "Switchboard", editor: "text" },
  { key: "website", label: "Website", editor: "text" },
];

export const COMPANY_KEYS = COMPANY_FIELDS.map((f) => f.key);

export const EDITABLE_KEYS = EDITABLE.map((f) => f.key);

// Status is edited by its own control, not by the generic field loop —
// "defunct" is a decision with a consequence, and burying it in a dropdown
// between Priority and Engagement invites it being set by accident. It is
// still patchable, so the allow-list is wider than the form.
export const PATCHABLE = [...EDITABLE_KEYS, "status", "status_note"];

export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v == null || v === "" ? "" : Array.isArray(v) ? [...v].sort().join(",") : String(v);
  return norm(a) === norm(b);
}
