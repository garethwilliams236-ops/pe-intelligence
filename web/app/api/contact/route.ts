import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// One address, for one named person, at one fund. Deliberately a POST that
// takes both ids and returns a single string.
//
// The addresses are named individuals' work contacts from Ardent's confidential
// master list. Every other endpoint returns has_email instead, so no screen and
// no export can assemble a mailing list — reaching an address requires opening
// a fund and asking for that person. The lookup is by person AND company
// because the address belongs to the role, not the name.
export async function POST(req: NextRequest) {
  const { company_id, person_id } = await req.json();
  if (!company_id || !person_id) {
    return NextResponse.json({ error: "company_id and person_id required" }, { status: 400 });
  }
  const supabase = db();
  const { data, error } = await supabase
    .from("person_roles")
    .select("email, phone")
    .eq("company_id", company_id)
    .eq("person_id", person_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.email) {
    return NextResponse.json({ error: "No address on file for this person here." },
      { status: 404 });
  }
  return NextResponse.json({ email: data.email, phone: data.phone || null });
}
