import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireEditor, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Which table a field lives on. fund_type is the only proposable field that
// hangs off the investor rather than the company, and getting this wrong writes
// silently to nothing, so it is stated once here rather than inferred.
const ON_INVESTOR = new Set(["fund_types", "ardent_sector", "check_band",
  "engagement_level", "priority", "key_investments"]);

// Array columns cannot take the proposal's text value as-is. Proposals store a
// comma-separated list because the table holds one text column for every field;
// this is where it becomes a Postgres array again.
const ARRAY_FIELDS = new Set(["fund_types", "invest_geographies"]);

function forColumn(field: string, value: string | null): unknown {
  if (!ARRAY_FIELDS.has(field)) return value === "" ? null : value;
  return (value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

export async function GET() {
  const { deny } = await requireUser();
  if (deny) return deny;
  const supabase = db();
  const { data, error } = await supabase
    .from("v_pending_proposals")
    .select("*")
    // Most confident first: the near-certain ones clear in a keystroke and the
    // guesses are what deserve the thinking.
    .order("confidence", { ascending: false })
    .order("legal_name")
    .limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: runs } = await supabase
    .from("investor_update_runs")
    .select("*").order("started_at", { ascending: false }).limit(5);

  const { count: reviewed } = await supabase
    .from("investor_update_proposals")
    .select("id", { count: "exact", head: true })
    .neq("status", "pending");

  return NextResponse.json({ rows: data || [], runs: runs || [], reviewed: reviewed ?? 0 });
}

// PATCH -> accept, amend or reject one proposal.
//
// Accepting writes through the SAME audited path an analyst edit takes, stamped
// source 'scrape_accepted' — so a field changed by the robot and a field changed
// by hand are equally answerable six months later, and neither is silent.
// Rejecting writes nothing to the record but is still recorded: a source that is
// repeatedly wrong about a field is worth knowing about.
export async function PATCH(req: NextRequest) {
  const { viewer, deny } = await requireEditor();
  if (deny) return deny;
  const { id, action, value, note } = await req.json();
  if (!id || !["accept", "amend", "reject"].includes(action)) {
    return NextResponse.json({ error: "id and a valid action required" }, { status: 400 });
  }
  const supabase = db();

  const { data: p, error: readErr } = await supabase
    .from("investor_update_proposals").select("*").eq("id", id).single();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (p.status !== "pending") {
    return NextResponse.json({ error: "already reviewed" }, { status: 409 });
  }

  // Accepting a set-valued proposal ADDS to what is there. The scraper reads one
  // thing off a homepage and proposes it; a fund already marked LBO that turns
  // out to also be a growth investor should end up as both, not silently lose
  // the classification an analyst made. Amend replaces, because an amend is the
  // analyst stating the whole set deliberately.
  const finalValue = action === "amend"
    ? (value ?? "")
    : ARRAY_FIELDS.has(p.field)
      ? [...new Set([
          ...String(p.current_value || "").split(",").map((v: string) => v.trim()),
          ...String(p.proposed_value || "").split(",").map((v: string) => v.trim()),
        ])].filter(Boolean).join(",")
      : p.proposed_value;

  // A contact proposal is not a field update — accepting it creates a person
  // and attaches them to the firm. Same review, different consequence, so it
  // gets its own branch rather than being forced through the column writer.
  if (action !== "reject" && p.field === "contact") {
    const [rawName, email] = String(finalValue).split("|");
    const name = (rawName || "").trim() || (email || "").split("@")[0];
    const { data: person } = await supabase
      .from("people").insert({ full_name: name, confidence: 0.6 })
      .select("id").single();
    if (person) {
      const { data: taken } = await supabase
        .from("person_roles").select("id")
        .eq("company_id", p.company_id).eq("is_key_contact", true).maybeSingle();
      await supabase.from("person_roles").insert({
        person_id: person.id,
        company_id: p.company_id,
        seniority: "other",
        email: (email || "").trim() || null,
        is_key_contact: !taken,
      });
    }
    await supabase.from("investor_field_history").insert([{
      company_id: p.company_id, field: "contact",
      old_value: null, new_value: finalValue,
      source: "scrape_accepted",
      rationale: note || `accepted from ${p.evidence_url || "site"}`,
      changed_by: viewer.id,
    }]);
  } else if (action !== "reject") {
    const table = ON_INVESTOR.has(p.field) ? "investors" : "companies";
    const key = table === "investors" ? "company_id" : "id";
    const write = forColumn(p.field, finalValue);

    await supabase.from("investor_field_history").insert([{
      company_id: p.company_id,
      field: p.field,
      old_value: p.current_value,
      new_value: write,
      source: "scrape_accepted",
      rationale: note || (action === "amend"
        ? `amended from proposed "${p.proposed_value}"`
        : `accepted from ${p.evidence_url || "site"}`),
      changed_by: viewer.id,
    }]);

    const { error: writeErr } = await supabase
      .from(table).update({ [p.field]: write }).eq(key, p.company_id);
    if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });
  }

  const { error: updErr } = await supabase
    .from("investor_update_proposals")
    .update({
      status: action === "accept" ? "accepted" : action === "amend" ? "amended" : "rejected",
      final_value: action === "reject" ? null : finalValue,
      reviewed_at: new Date().toISOString(),
      reviewed_by: viewer.id,
      note: note || null,
    })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, action, field: p.field });
}
