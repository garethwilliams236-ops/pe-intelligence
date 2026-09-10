// Reading a sponsor's own website, politely, and turning what is there into
// PROPOSALS. Nothing in this file writes to an investor record.
//
// It is deliberately less capable than crawler/ in Python: no headless browser,
// so a client-rendered site returns nothing and is recorded as a failure rather
// than as "no changes". That distinction matters — "we looked and there was
// nothing new" and "we could not look" must not appear the same in the queue.
//
// Politeness matches the Python crawler, because a second crawler with worse
// manners against the same domains is how a firm ends up blocked: robots.txt is
// fetched once per host and honoured, the User-Agent identifies us and carries a
// contact, and Crawl-delay is respected.

const UA =
  "ArdentPEIntelligence/1.0 (+https://ardentadvisors.com; gwilliams@ardentadvisors.com)";

const FETCH_TIMEOUT_MS = 7000;

export type Extracted = {
  field: string;
  value: string;
  confidence: number;
  url: string;
  snippet: string;
};

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

type Robots = { disallow: string[]; delayMs: number };
const robotsCache = new Map<string, Robots>();

async function robotsFor(origin: string): Promise<Robots> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  // No robots.txt is permission by omission, not a reason to stop — same rule
  // the Python crawler applies.
  let rules: Robots = { disallow: [], delayMs: 0 };
  try {
    const res = await timedFetch(`${origin}/robots.txt`);
    if (res.ok) {
      const text = await res.text();
      rules = parseRobots(text);
    }
  } catch {
    /* unreachable robots.txt is treated as absent */
  }
  robotsCache.set(origin, rules);
  return rules;
}

// Only the groups that apply to us: our own UA and the wildcard. A directive
// aimed at Googlebot is not aimed at us, and obeying it would be theatre.
export function parseRobots(text: string): Robots {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  const disallow: string[] = [];
  let delayMs = 0;
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rest.length) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      const agent = value.toLowerCase();
      applies = agent === "*" || UA.toLowerCase().startsWith(agent.split("/")[0]);
    } else if (applies && key === "disallow" && value) {
      disallow.push(value);
    } else if (applies && key === "crawl-delay") {
      const seconds = Number(value);
      if (!Number.isNaN(seconds)) delayMs = Math.min(seconds * 1000, 10_000);
    }
  }
  return { disallow, delayMs };
}

function allowed(rules: Robots, path: string): boolean {
  return !rules.disallow.some((rule) => rule !== "/" ? path.startsWith(rule) : true);
}

function timedFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getPage(url: string): Promise<{ url: string; html: string } | null> {
  const parsed = new URL(url);
  const rules = await robotsFor(parsed.origin);
  if (!allowed(rules, parsed.pathname)) return null;
  if (rules.delayMs) await sleep(rules.delayMs);
  const res = await timedFetch(url);
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("html")) return null;
  return { url: res.url, html: (await res.text()).slice(0, 400_000) };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const strip = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();

function snippetAround(text: string, needle: string, width = 120): string {
  const at = text.indexOf(needle);
  if (at < 0) return text.slice(0, width);
  return text.slice(Math.max(0, at - width / 2), at + needle.length + width / 2).trim();
}

// Structured data first. An Organization block states the address and telephone
// as fact rather than as something guessed out of a footer, so it is worth far
// more confidence than a regex hit.
function jsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      if (parsed["@graph"]) out.push(...parsed["@graph"]);
    } catch {
      /* malformed JSON-LD is common and not worth a failure */
    }
  }
  return out;
}

const UK_POSTCODE =
  /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
// Deliberately narrow: international formats produce far more false positives
// than they are worth, and a wrong switchboard number is worse than none.
const PHONE =
  /(?:tel:|telephone[:\s]|phone[:\s]|t[:\s])\s*(\+?[\d\s().-]{9,20})/i;

export function extract(pages: { url: string; html: string }[]): Extracted[] {
  const found: Extracted[] = [];
  const seen = new Set<string>();
  const add = (e: Extracted) => {
    if (seen.has(e.field)) return;       // first (best) page wins per field
    seen.add(e.field);
    found.push(e);
  };

  for (const page of pages) {
    const text = strip(page.html);

    for (const node of jsonLd(page.html)) {
      const type = String(node["@type"] || "");
      if (!/Organization|Corporation|LocalBusiness/i.test(type)) continue;
      const addr = node.address;
      if (addr && typeof addr === "object") {
        const line = [addr.streetAddress, addr.addressLocality]
          .filter(Boolean).join(", ");
        if (line) {
          add({ field: "address_line", value: String(addr.streetAddress || line),
                confidence: 0.85, url: page.url, snippet: line });
        }
        if (addr.postalCode) {
          add({ field: "postcode", value: String(addr.postalCode),
                confidence: 0.85, url: page.url, snippet: line });
        }
        if (addr.addressLocality) {
          add({ field: "city", value: String(addr.addressLocality),
                confidence: 0.8, url: page.url, snippet: line });
        }
      }
      if (node.telephone) {
        add({ field: "phone", value: String(node.telephone).trim(),
              confidence: 0.85, url: page.url, snippet: String(node.telephone) });
      }
    }

    // tel: links are the next best thing — a human put that number there for
    // people to ring, which is exactly what the field means.
    const tel = page.html.match(/href=["']tel:([^"']+)["']/i);
    if (tel) {
      add({ field: "phone", value: decodeURIComponent(tel[1]).replace(/\s+/g, " ").trim(),
            confidence: 0.75, url: page.url, snippet: `tel:${tel[1]}` });
    } else {
      const phone = text.match(PHONE);
      if (phone) {
        add({ field: "phone", value: phone[1].replace(/\s+/g, " ").trim(),
              confidence: 0.45, url: page.url, snippet: snippetAround(text, phone[0]) });
      }
    }

    const postcode = text.match(UK_POSTCODE);
    if (postcode) {
      add({ field: "postcode", value: postcode[1].toUpperCase().replace(/\s+/g, " "),
            confidence: 0.55, url: page.url, snippet: snippetAround(text, postcode[0]) });
    }

    const meta = page.html.match(
      /<meta[^>]+(?:name=["']description["']|property=["']og:description["'])[^>]+content=["']([^"']{40,400})["']/i);
    if (meta) {
      add({ field: "description", value: meta[1].trim(), confidence: 0.6,
            url: page.url, snippet: meta[1].slice(0, 160) });
    }
  }

  return found;
}

// A fund's own words about what it is. Low confidence on purpose: this is a
// keyword scan, and fund type is the field the ranking leans on hardest, so it
// should arrive in the queue looking like the guess it is.
const TYPE_HINTS: [RegExp, string][] = [
  [/\bventure capital\b|\bseed (?:stage|fund)\b|\bearly[- ]stage\b/i, "vc"],
  [/\bVCT\b|\bventure capital trust\b|\bEIS\b/i, "vct"],
  [/\bmanagement buy[- ]?out\b|\bMBO\b/i, "mbo"],
  [/\bleveraged buy[- ]?out\b|\bLBO\b|\bbuyout\b/i, "lbo"],
  [/\bfund of funds\b|\blimited partner\b|\bLP (?:investor|capital)\b/i, "lp"],
  [/\bfamily office\b/i, "family_office"],
  [/\basset manage(?:r|ment)\b|\bmulti[- ]strategy\b/i, "multi_strategy_am"],
  [/\bcorporate (?:venture|development|strategy)\b/i, "corp_strategy_office"],
];

export function fundTypeHint(pages: { url: string; html: string }[]): Extracted | null {
  for (const page of pages) {
    const text = strip(page.html).slice(0, 20_000);
    for (const [re, value] of TYPE_HINTS) {
      const hit = text.match(re);
      if (hit) {
        return { field: "fund_type", value, confidence: 0.35, url: page.url,
                 snippet: snippetAround(text, hit[0]) };
      }
    }
  }
  return null;
}

// Where to look. Home plus the two pages that actually carry contact details and
// people; more pages per fund would be a better scrape and a worse batch, since
// the whole run has to finish inside one serverless invocation.
export const PATHS = ["", "/contact", "/contact-us", "/about", "/team", "/our-team"];

export async function fetchSite(website: string, maxPages = 3) {
  let base: URL;
  try {
    base = new URL(website.startsWith("http") ? website : `https://${website}`);
  } catch {
    return { pages: [], error: "unparseable website" };
  }
  const pages: { url: string; html: string }[] = [];
  let error: string | null = null;
  for (const path of PATHS) {
    if (pages.length >= maxPages) break;
    try {
      const page = await getPage(new URL(path || "/", base).toString());
      if (page) pages.push(page);
      else if (!path) error = "home page not fetchable";
    } catch (e: any) {
      if (!path) error = e?.name === "TimeoutError" ? "timed out" : String(e?.message || e);
    }
  }
  if (!pages.length && !error) error = "nothing fetched";
  return { pages, error: pages.length ? null : error };
}
