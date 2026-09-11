import { NextRequest, NextResponse } from "next/server";
import { db, selectAll } from "@/lib/db";
import { COMPANY_KEYS, PATCHABLE, sameValue } from "@/lib/fields";
import { requireEditor, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET            -> the whole universe, for the control-sheet grid
// GET ?id=<uuid> -> one fund plus its team and change history
export async function GET(req: NextRequest) {
  const { deny } = await requireUser();
  if (deny) return deny;
  const supabase = db();
  const id = req.nextUrl.searchParams.get("id");

  if (id) {
    const { data, error } = await supabase
      .from("v_investor_universe").select("*").eq("company_id", id).single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const { data: history } = await supabase
      .from("investor_field_history")
      .select("field, old_value, new_value, source, rationale, changed_at")
      .eq("company_id", id)
      .order("changed_at", { ascending: false })
      .limit(100);
    // The team comes from the view, which exposes has_email rather than the
    // address. Nothing here returns an address; one is fetched by /api/contact
    // for a single named person, on request.
    const { data: team } = await supabase
      .from("v_investor_team")
      .select("person_id, full_name, title, seniority, is_key_contact, has_email, linkedin_url, is_current")
      .eq("company_id", id)
      .order("rank");
    return NextResponse.json({
      investor: data, history: history || [], team: team || [],
    });
  }

  const { rows, error } = await selectAll<any>(
    "v_investor_universe",
    "company_id, legal_name, country_code, fund_types, invest_geographies, " +
    "ardent_sector, check_band, cheque_min, cheque_max, cheque_source, " +
    "engagement_level, quality_score, priority, last_audited, grade, " +
    "never_approach, holdings, status, status_note, merged_into_id, " +
    "merged_into_name, hidden, team_size, team_with_email, key_contact, " +
    "key_contact_title, key_contact_has_email, city, website, address_line, " +
    "postcode, phone",
    "legal_name",
  );
  if (error) return NextResponse.json({ error }, { status: 500 });

  // Defunct funds and duplicate rows are out of the book by default. They are
  // not deleted and the count is always reported, so a shrinking list is never
  // a silent one.
  const showHidden = req.nextUrl.searchParams.get("hidden") === "1";
  const visible = showHidden ? rows : rows.filter((r: any) => !r.hidden);
  return NextResponse.json({
    rows: visible,
    showing_hidden: showHidden,
    hidden_count: rows.filter((r: any) => r.hidden).length,
    defunct_count: rows.filter((r: any) => r.status === "defunct").length,
    duplicate_count: rows.filter((r: any) => r.merged_into_id).length,
    // The QC counters this screen is for: what is actually classified.
    total: visible.length,
    with_fund_type: visible.filter((r: any) => (r.fund_types || []).length).length,
    with_cheque: visible.filter((r: any) => r.cheque_min != null).length,
    with_geography: visible.filter((r: any) => (r.invest_geographies || []).length).length,
    with_sector: visible.filter((r: any) => r.ardent_sector).length,
  });
}

// POST -> create a fund by hand.
//
// The duplicate check is the point of this endpoint being more than an insert.
// This book already carries Carlyle three times and Bridgepoint three times,
// one of them an unrelated Canadian firm, and every one of those started as
// somebody adding a fund that was already there. So a near-match returns 409
// with the candidates rather than creating the row, and the caller has to say
// explicitly that it is a different firm.
export async function POST(req: NextRequest) {
  const { viewer, deny } = await requireEditor();
  if (deny) return deny;

  const body = await req.json();
  const name = String(body?.legal_name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 });
  }

  const supabase = db();

  if (!body.force) {
    // Exact-ish first, then anything starting with the same first word — which
    // is how "Carlyle" and "Carlyle Group" end up as two rows.
    const firstWord = name.split(/\s+/)[0];
    const { data: near } = await supabase
      .from("companies")
      .select("id, legal_name")
      .or(`legal_name.ilike.${name},legal_name.ilike.${firstWord}%`)
      .limit(8);
    if (near && near.length) {
      return NextResponse.json({ error: "possible_duplicate", candidates: near },
        { status: 409 });
    }
  }

  const { data: company, error: coErr } = await supabase
    .from("companies")
    .insert({
      legal_name: name,
      website: body.website || null,
      country_code: body.country_code || null,
      city: body.city || null,
      address_line: body.address_line || null,
      postcode: body.postcode || null,
      phone: body.phone || null,
      description: body.description || null,
      company_types: ["sponsor"],   // the enum's word for a PE/VC house
      confidence: 1.0,
    })
    .select("id")
    .single();
  if (coErr) return NextResponse.json({ error: coErr.message }, { status: 500 });

  const { error: invErr } = await supabase.from("investors").insert({
    company_id: company.id,
    fund_types: Array.isArray(body.fund_types) ? body.fund_types : [],
    invest_geographies: Array.isArray(body.invest_geographies) ? body.invest_geographies : [],
    ardent_sector: body.ardent_sector || null,
    check_band: body.check_band || null,
    priority: body.priority || null,
    key_investments: body.key_investments || null,
    quality_score: body.quality_score ? Number(body.quality_score) : null,
    last_audited: new Date().toISOString().slice(0, 10),
  });
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

  // The named contact, if one was given. Created as the key contact because a
  // fund entered by hand is one somebody has just spoken to or researched, and
  // that is exactly who they spoke to.
  const contact = String(body.contact_name || "").trim();
  if (contact) {
    const { data: person } = await supabase
      .from("people").insert({ full_name: contact, confidence: 1.0 })
      .select("id").single();
    if (person) {
      await supabase.from("person_roles").insert({
        person_id: person.id,
        company_id: company.id,
        title: body.contact_title || null,
        seniority: "other",
        email: body.contact_email || null,
        is_key_contact: true,
      });
    }
  }

  // Entered by hand is itself a fact worth recording — six months on, "where
  // did this fund come from" has an answer that is not a shrug.
  await supabase.from("investor_field_history").insert([{
    company_id: company.id,
    field: "created",
    old_value: null,
    new_value: name,
    source: "analyst",
    rationale: body.rationale || "added by hand",
    changed_by: viewer.id,
  }]);

  return NextResponse.json({ ok: true, company_id: company.id });
}

// PATCH -> apply analyst overrides, one history row per field that changed.
//
// The history row is written BEFORE the update, and only for fields whose value
// actually differs. Recording a no-op edit would bury the real changes, and
// writing the update first would lose the old value if the insert then failed.
export async function PATCH(req: NextRequest) {
  const { viewer, deny } = await requireEditor();
  if (deny) return deny;
  const { company_id, changes, rationale } = await req.json();
  if (!company_id || !changes) {
    return NextResponse.json({ error: "company_id and changes required" }, { status: 400 });
  }
  const supabase = db();

  const { data: current, error: readErr } = await supabase
    .from("investors").select("*").eq("company_id", company_id).single();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

  const update: Record<string, unknown> = {};
  const trail: Record<string, unknown>[] = [];

  for (const [field, raw] of Object.entries(changes as Record<string, unknown>)) {
    if (!PATCHABLE.includes(field)) continue;          // never trust the client's field list
    let value = raw;
    if (field === "quality_score") {
      value = raw === "" || raw == null ? null : Number(raw);
      if (value !== null && Number.isNaN(value)) continue;
    }
    if (field === "invest_geographies" || field === "fund_types") {
      value = Array.isArray(raw) ? raw : [];
    }
    if (typeof value === "string" && value.trim() === "") value = null;
    if (sameValue(current[field], value)) continue;

    update[field] = value;
    trail.push({
      company_id, field,
      old_value: current[field] == null ? null : String(current[field]),
      new_value: value == null ? null : String(value),
      source: "analyst",
      rationale: rationale || null,
      changed_by: viewer.id,
    });
  }

  // Contact details are columns on companies, so they cannot ride along in the
  // investors update either. Same audit trail, separate statement.
  const companyUpdate: Record<string, unknown> = {};
  {
    const { data: company } = await supabase
      .from("companies")
      .select(COMPANY_KEYS.join(", "))
      .eq("id", company_id).single();
    for (const field of COMPANY_KEYS) {
      if (!(field in (changes as Record<string, unknown>))) continue;
      let value: unknown = (changes as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim() === "") value = null;
      const before = (company as any)?.[field] ?? null;
      if (sameValue(before, value)) continue;
      companyUpdate[field] = value;
      trail.push({
        company_id, field,
        old_value: before == null ? null : String(before),
        new_value: value == null ? null : String(value),
        source: "analyst", rationale: rationale || null, changed_by: viewer.id,
      });
    }
  }

  // The duplicate link is a column on companies, so it cannot ride along in the
  // investors update. The audit row records the SURVIVOR'S NAME rather than its
  // uuid: the id is recoverable from the row itself, and a history that reads
  // "merged into Carlyle Group" is the point of keeping one.
  let merged = false;
  const merge = (changes as Record<string, unknown>).merged_into_id;
  if (merge !== undefined) {
    const { data: company } = await supabase
      .from("companies").select("merged_into_id").eq("id", company_id).single();
    const before = company?.merged_into_id ?? null;
    const after = merge === "" || merge == null ? null : String(merge);
    if (before !== after) {
      const nameOf = async (id: string | null) => {
        if (!id) return null;
        const { data } = await supabase
          .from("companies").select("legal_name").eq("id", id).single();
        return data?.legal_name ?? id;
      };
      await supabase.from("investor_field_history").insert([{
        company_id, field: "merged_into_id",
        old_value: await nameOf(before), new_value: await nameOf(after),
        source: "analyst", rationale: rationale || null, changed_by: viewer.id,
      }]);
      const { error: mergeErr } = await supabase
        .from("companies").update({ merged_into_id: after }).eq("id", company_id);
      if (mergeErr) return NextResponse.json({ error: mergeErr.message }, { status: 500 });
      // Counted, NOT pushed onto `trail`: its history row is already written
      // above, and `trail` is inserted wholesale further down. A marker object
      // in there would insert a row with no company_id and fail the batch.
      merged = true;
    }
  }

  if (!trail.length) {
    return NextResponse.json({ ok: true, changed: merged ? 1 : 0 });
  }

  // An analyst who opens a record and saves it has audited it, whatever else
  // they changed — that is what the column means on the sheet it came from.
  const today = new Date().toISOString().slice(0, 10);
  if (!sameValue(current.last_audited, today)) {
    update.last_audited = today;
    trail.push({
      company_id, field: "last_audited",
      old_value: current.last_audited ? String(current.last_audited) : null,
      new_value: today, source: "analyst", rationale: rationale || null,
      changed_by: viewer.id,
    });
  }

  const { error: histErr } = await supabase.from("investor_field_history").insert(trail);
  if (histErr) return NextResponse.json({ error: histErr.message }, { status: 500 });

  if (Object.keys(update).length) {
    const { error: updErr } = await supabase
      .from("investors").update(update).eq("company_id", company_id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (Object.keys(companyUpdate).length) {
    const { error: coErr } = await supabase
      .from("companies").update(companyUpdate).eq("id", company_id);
    if (coErr) return NextResponse.json({ error: coErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, changed: trail.length + (merged ? 1 : 0) });
}
