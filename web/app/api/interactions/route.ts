import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireEditor, requireUser } from "@/lib/auth";
import { DIRECTION_KEYS, SENTIMENT_KEYS, TYPE_KEYS } from "@/lib/interactions";

export const dynamic = "force-dynamic";

// GET ?company_id=<uuid>  -> the fund's feed
// GET ?person_id=<uuid>   -> the person's feed
//
// Both read v_interactions, where participants and firms are already rolled
// into arrays. A dinner with four attendees is one row in that view; joining
// the tables directly would make it four, and a feed that repeats a meeting
// once per attendee is a feed nobody trusts.
export async function GET(req: NextRequest) {
  const { deny } = await requireUser();
  if (deny) return deny;

  const companyId = req.nextUrl.searchParams.get("company_id");
  const personId = req.nextUrl.searchParams.get("person_id");
  if (!companyId && !personId) {
    return NextResponse.json(
      { error: "company_id or person_id required" }, { status: 400 });
  }

  const supabase = db();
  let q = supabase
    .from("v_interactions")
    .select("id, interaction_type, direction, subject, ai_summary, body, occurred_at, duration_minutes, location, source, sentiment, logged_by_email, people, person_ids, firms, company_ids")
    .order("occurred_at", { ascending: false })
    .limit(200);

  // contains(), not eq(): these are array columns, and one interaction can
  // name several firms or several people.
  q = companyId
    ? q.contains("company_ids", [companyId])
    : q.contains("person_ids", [personId as string]);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data || [] });
}

// POST -> log one interaction, with its people and its firms.
//
// Three inserts, not one. The interaction is the event; who was there and what
// it was about are separate rows so that a call about two funds is one call.
// The triggers on those two tables are what keep last_interaction_at honest.
export async function POST(req: NextRequest) {
  const { viewer, deny } = await requireEditor();
  if (deny) return deny;

  const body = await req.json();
  const type = TYPE_KEYS.includes(body?.interaction_type)
    ? body.interaction_type : null;
  if (!type) {
    return NextResponse.json({ error: "A valid type is required." }, { status: 400 });
  }
  const occurred = String(body?.occurred_at || "").trim();
  if (!occurred) {
    return NextResponse.json({ error: "A date is required." }, { status: 400 });
  }
  const companyIds: string[] = Array.isArray(body?.company_ids) ? body.company_ids : [];
  const personIds: string[] = Array.isArray(body?.person_ids) ? body.person_ids : [];
  if (!companyIds.length && !personIds.length) {
    return NextResponse.json(
      { error: "An interaction must name a fund or a person." }, { status: 400 });
  }

  const supabase = db();
  const { data: created, error } = await supabase
    .from("interactions")
    .insert({
      interaction_type: type,
      direction: DIRECTION_KEYS.includes(body?.direction)
        ? body.direction : "not_applicable",
      sentiment: SENTIMENT_KEYS.includes(body?.sentiment) ? body.sentiment : "unknown",
      subject: body.subject || null,
      body: body.body || null,
      occurred_at: new Date(occurred).toISOString(),
      duration_minutes: body.duration_minutes ? Number(body.duration_minutes) : null,
      location: body.location || null,
      source: "manual",
      logged_by: viewer.id,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (personIds.length) {
    const { error: pErr } = await supabase.from("interaction_participants").insert(
      personIds.map((pid) => ({
        interaction_id: created.id, person_id: pid, role: "attendee",
      })));
    if (pErr) {
      // Leave nothing behind: an interaction with no participants and no links
      // is invisible in both feeds and would simply accumulate.
      await supabase.from("interactions").delete().eq("id", created.id);
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }
  }
  if (companyIds.length) {
    const { error: cErr } = await supabase.from("interaction_links").insert(
      companyIds.map((cid) => ({ interaction_id: created.id, company_id: cid })));
    if (cErr) {
      await supabase.from("interactions").delete().eq("id", created.id);
      return NextResponse.json({ error: cErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, id: created.id });
}

// DELETE ?id=<uuid> -> remove a mislogged interaction.
//
// A real delete, not a status flag. Everything else in this app is reversible
// because the record is a claim about the world that might be wrong; a meeting
// logged against the wrong fund is not a claim about the world, it is a typo.
// The cascades take the participants and links, and their delete triggers
// recompute last_interaction_at for everyone who was on it.
export async function DELETE(req: NextRequest) {
  const { deny } = await requireEditor();
  if (deny) return deny;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = db();
  const { error } = await supabase.from("interactions").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
