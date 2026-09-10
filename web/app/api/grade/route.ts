import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// A grade supersedes rather than overwrites, so "why is this house an A" always
// has an answer with a date against it.
export async function POST(req: NextRequest) {
  const { company_id, grade, never_approach, rationale } = await req.json();
  if (!company_id) {
    return NextResponse.json({ error: "company_id required" }, { status: 400 });
  }
  const supabase = db();

  const { error: closeErr } = await supabase
    .from("investor_grades")
    .update({ superseded_at: new Date().toISOString() })
    .eq("company_id", company_id)
    .is("superseded_at", null);
  if (closeErr) return NextResponse.json({ error: closeErr.message }, { status: 500 });

  if (!grade && !never_approach) return NextResponse.json({ ok: true, cleared: true });

  const { error } = await supabase.from("investor_grades").insert({
    company_id,
    grade: grade || "c",
    never_approach: !!never_approach,
    rationale: rationale || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
