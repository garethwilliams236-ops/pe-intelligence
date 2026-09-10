import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Which table a field lives on. fund_type is the only proposable field that
// hangs off the investor rather than the company, and getting this wrong writes
// silently to nothing, so it is stated once here rather than inferred.
const ON_INVESTOR = new Set(["fund_type", "ardent_sector", "check_band",
  "engagement_level", "priority", "key_investments"]);

export async function GET() {
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

  const finalValue = action === "amend" ? (value ?? "") : p.proposed_value;

  if (action !== "reject") {
    const table = ON_INVESTOR.has(p.field) ? "investors" : "companies";
    const key = table === "investors" ? "company_id" : "id";
    const write = finalValue === "" ? null : finalValue;

    await supabase.from("investor_field_history").insert([{
      company_id: p.company_id,
      field: p.field,
      old_value: p.current_value,
      new_value: write,
      source: "scrape_accepted",
      rationale: note || (action === "amend"
        ? `amended from proposed "${p.proposed_value}"`
        : `accepted from ${p.evidence_url || "site"}`),
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
      note: note || null,
    })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, action, field: p.field });
}
