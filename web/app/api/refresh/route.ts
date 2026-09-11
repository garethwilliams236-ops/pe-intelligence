import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extract, fetchSite, fundTypeHint } from "@/lib/scrape";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The nightly refresh. Twenty funds, oldest-checked first, proposing changes
// into investor_update_proposals and touching nothing else.
//
// The batch runs against a WALL-CLOCK BUDGET rather than trusting twenty sites
// to answer inside one invocation. Whatever it gets through is committed and the
// rest stay at the front of the queue, because the queue is derived from
// last_scraped_at rather than a stored cursor — so a short run is a short run,
// not a skipped batch.
const BUDGET_MS = 240_000;
const BATCH = 20;

// Fields the scraper may propose against. Everything on the fund page is fair
// game because a proposal is not a change — but each carries its own confidence
// so the queue sorts the near-certain from the guessed.
const PROPOSABLE = new Set([
  "address_line", "postcode", "city", "phone", "website", "description",
  "fund_types",
]);

// Two callers, two proofs. Vercel's scheduler carries the bearer token and has
// no session; a person pressing "Run now" has a session and no token. Either is
// sufficient; neither is optional.
async function authorised(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (secret && header === `Bearer ${secret}`) return true;
  const { deny } = await requireEditor();
  return !deny;
}

export async function POST(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const started = Date.now();
  const body = await req.json().catch(() => ({}));
  const trigger = body?.trigger === "manual" ? "manual" : "schedule";
  const size = Math.min(Number(body?.size) || BATCH, 50);

  const supabase = db();

  // Next up: never scraped first, then longest ago, then alphabetical. Hidden
  // funds are skipped — there is no point refreshing a duplicate row or a firm
  // we have recorded as closed.
  // The select list is one string rather than a concatenation, and the result
  // is cast. supabase-js parses the select string at the TYPE level to infer the
  // row shape; a `"a, b" + "c"` expression is not a literal it can read, so it
  // gives up and types every row as GenericStringError — which compiles locally
  // under esbuild (types stripped) and fails the Vercel build at tsc.
  const { data: queueRows, error: queueErr } = await supabase
    .from("v_refresh_queue")
    .select("company_id, legal_name, website, address_line, postcode, city, phone, description, fund_types")
    .eq("hidden", false)
    .not("website", "is", null)
    .order("last_scraped_at", { ascending: true, nullsFirst: true })
    .order("legal_name")
    .limit(size);
  if (queueErr) return NextResponse.json({ error: queueErr.message }, { status: 500 });
  const queue = (queueRows || []) as any[];

  const { data: run, error: runErr } = await supabase
    .from("investor_update_runs")
    .insert({ trigger }).select("id").single();
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });

  let attempted = 0, fetched = 0, proposed = 0, failed = 0;
  let ranOut = false;

  for (const inv of queue) {
    if (Date.now() - started > BUDGET_MS) { ranOut = true; break; }
    attempted++;

    const { pages, error } = await fetchSite(inv.website as string);
    // Stamped whether or not it worked: one unreachable site must not sit at the
    // head of the queue blocking the other 1,284 forever.
    await supabase.from("investors")
      .update({ last_scraped_at: new Date().toISOString(), scrape_error: error })
      .eq("company_id", inv.company_id);

    if (!pages.length) { failed++; continue; }
    fetched++;

    const found = [...extract(pages)];
    const hint = fundTypeHint(pages);
    if (hint) found.push(hint);

    const rows = found
      .filter((f) => PROPOSABLE.has(f.field))
      .filter((f) => {
        const current = (inv as any)[f.field];
        // Only differences are worth a human's attention. Whitespace and case
        // are not differences.
        const norm = (v: unknown) =>
          String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        // For a set-valued field, "already one of the types we hold" is not a
        // difference — proposing LBO to a fund already marked LBO is pure noise.
        if (Array.isArray(current)) return !current.includes(f.value);
        return norm(current) !== norm(f.value) && f.value.trim() !== "";
      })
      .map((f) => ({
        run_id: run.id,
        company_id: inv.company_id,
        field: f.field,
        current_value: Array.isArray((inv as any)[f.field])
          ? ((inv as any)[f.field] as string[]).join(",") || null
          : (inv as any)[f.field] ?? null,
        proposed_value: f.value,
        confidence: f.confidence,
        evidence_url: f.url,
        evidence_snippet: f.snippet.slice(0, 500),
      }));

    if (rows.length) {
      // Filtered in the client rather than left to ON CONFLICT: the "one pending
      // proposal per field" index is PARTIAL (where status = 'pending'), and
      // Postgres cannot infer a partial index from an ON CONFLICT target, so the
      // upsert would fail outright rather than skip the duplicate.
      const { data: already } = await supabase
        .from("investor_update_proposals")
        .select("field")
        .eq("company_id", inv.company_id)
        .eq("status", "pending");
      const pending = new Set((already || []).map((a: any) => a.field));
      const fresh = rows.filter((r) => !pending.has(r.field));
      if (fresh.length) {
        const { error: insErr } = await supabase
          .from("investor_update_proposals").insert(fresh);
        if (!insErr) proposed += fresh.length;
      }
    }
  }

  await supabase.from("investor_update_runs").update({
    finished_at: new Date().toISOString(),
    attempted, fetched, proposed, failed,
    notes: ranOut ? "stopped on time budget; remainder stays at the head of the queue" : null,
  }).eq("id", run.id);

  return NextResponse.json({
    run_id: run.id, trigger, attempted, fetched, proposed, failed,
    stopped_early: ranOut,
    seconds: Math.round((Date.now() - started) / 1000),
  });
}

// Vercel's scheduler issues a GET. Same work, same guard.
export async function GET(req: NextRequest) {
  return POST(new NextRequest(req.url, {
    method: "POST", headers: req.headers, body: JSON.stringify({ trigger: "schedule" }),
  }));
}
