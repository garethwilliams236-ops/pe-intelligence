// The interaction vocabularies, lifted from the IB CRM at the same spellings.
// A value that has to be translated between two systems is a value that will
// eventually be translated wrongly, so none of these are renamed for display
// at the database level — only here, on the way to the screen.

export const INTERACTION_TYPE: [string, string][] = [
  ["meeting", "Meeting"],
  ["call", "Call"],
  ["email", "Email"],
  ["note", "Note"],
  ["intro", "Intro"],
  ["conference", "Conference"],
  ["dinner", "Dinner"],
  ["other", "Other"],
];

export const DIRECTION: [string, string][] = [
  ["outbound", "We approached them"],
  ["inbound", "They approached us"],
  ["internal", "Internal"],
  ["not_applicable", "—"],
];

export const SENTIMENT: [string, string][] = [
  ["positive", "Positive"],
  ["neutral", "Neutral"],
  ["negative", "Negative"],
  ["unknown", "Not recorded"],
];

export const TYPE_KEYS = INTERACTION_TYPE.map(([k]) => k);
export const DIRECTION_KEYS = DIRECTION.map(([k]) => k);
export const SENTIMENT_KEYS = SENTIMENT.map(([k]) => k);

function look(list: [string, string][], key: string | null): string {
  if (!key) return "";
  return list.find(([k]) => k === key)?.[1] || key;
}

export const typeLabel = (k: string | null) => look(INTERACTION_TYPE, k);
export const directionLabel = (k: string | null) => look(DIRECTION, k);
export const sentimentLabel = (k: string | null) => look(SENTIMENT, k);

export type Interaction = {
  id: string;
  interaction_type: string;
  direction: string;
  subject: string | null;
  ai_summary: string | null;
  body: string | null;
  occurred_at: string;
  duration_minutes: number | null;
  location: string | null;
  source: string;
  sentiment: string;
  logged_by_email: string | null;
  people: string[];
  person_ids: string[];
  firms: string[];
  company_ids: string[];
};

// "14 Mar 2026", not "2026-03-14". A feed is read at a glance and a row of
// hyphenated dates all look the same.
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB",
    { day: "numeric", month: "short", year: "numeric" });
}

// How long ago, for the line that answers "are we neglecting them".
export function howLongAgo(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days < 0) return "scheduled";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.floor(days / 365.25)} years ago`;
}

// The value a datetime-local input wants, in LOCAL time. toISOString() would
// hand it UTC and silently shift the default by an hour through a British
// summer, which is the sort of thing nobody notices until a meeting is logged
// on the wrong day.
export function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
