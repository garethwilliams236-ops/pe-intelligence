import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireEditor, requireUser } from "@/lib/auth";
import { FUNCTION_KEYS, SENIORITY_KEYS, normaliseName, splitName } from "@/lib/contacts";

export const dynamic = "force-dynamic";

// The person, and every firm they have worked at. The second half is the point:
// a partner who left Bridgepoint for Inflexion is one record with two roles, and
// the contact page can then answer "where do I know them from" — which the CRM
// answers the same way and a flat contacts table cannot answer at all.
//
// No address is returned, here or anywhere else that lists. has_email says one
// exists; /api/contact hands over the value, for one person at one firm, on
// request. That rule is what keeps a screen from becoming a mailing list.
export async function GET(req: NextRequest) {
  const { deny } = await requireUser();
  if (deny) return deny;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = db();
  const { data: person, error } = await supabase
    .from("people")
    .select("id, full_name, first_name, middle_name, last_name, preferred_name, bio, linkedin_url, location_city, location_country, do_not_contact, last_interaction_at, custom_fields, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!person) return NextResponse.json({ error: "No such contact." }, { status: 404 });

  const { data: roles } = await supabase
    .from("person_roles")
    .select("id, company_id, title, seniority, function, is_key_contact, start_date, end_date, is_current, coverage_banker, start_note, email, phone, emails, phones, companies(legal_name, website)")
    .eq("person_id", id)
    .order("is_current", { ascending: false });

  // email and phone are read so the booleans can be computed, then dropped on
  // the floor. They are deliberately not spread into the response object.
  const safeRoles = (roles || []).map((r: any) => ({
    role_id: r.id,
    company_id: r.company_id,
    company_name: r.companies?.legal_name || null,
    company_website: r.companies?.website || null,
    title: r.title,
    seniority: r.seniority,
    function: r.function,
    is_key_contact: r.is_key_contact,
    start_date: r.start_date,
    end_date: r.end_date,
    is_current: r.is_current,
    coverage_banker: r.coverage_banker,
    start_note: r.start_note,
    has_email: !!r.email,
    has_phone: !!r.phone || (r.phones || []).length > 0,
    other_emails: Math.max(0, (r.emails || []).length - 1),
  }));

  return NextResponse.json({ person, roles: safeRoles });
}

// POST -> add a person to a fund by hand.
//
// A contact is two rows, not one: `people` is the human being, `person_roles`
// is them AT THIS FIRM. That split is why the address, the phone and the title
// hang off the role — when somebody moves house to a rival, the old address
// stops working and this schema says so rather than keeping a dead address
// against a live name.
//
// CONFIDENTIAL. The address written here joins Ardent's master list under the
// same terms as the rest: it is never returned by a list endpoint and never
// leaves in bulk. This route writes one; /api/contact reads one back.
export async function POST(req: NextRequest) {
  const { viewer, deny } = await requireEditor();
  if (deny) return deny;

  const body = await req.json();
  const companyId = String(body?.company_id || "").trim();
  const fullName = String(body?.full_name || "").trim();
  if (!companyId || !fullName) {
    return NextResponse.json(
      { error: "company_id and full_name required" }, { status: 400 });
  }

  const supabase = db();

  // The same duplicate refusal the Add-a-fund form has, for the same reason:
  // this book already carries funds three times over because nothing ever
  // stopped a second one being typed. Compared against who is already at THIS
  // firm, not against every person in the database — two different Sarah
  // Collinses at two different houses are two people.
  if (!body.force) {
    const { data: existing } = await supabase
      .from("v_investor_team")
      .select("person_id, full_name, title")
      .eq("company_id", companyId);
    const want = normaliseName(fullName);
    const clash = (existing || []).filter(
      (t: any) => normaliseName(t.full_name || "") === want);
    if (clash.length) {
      return NextResponse.json(
        { error: "possible_duplicate", candidates: clash }, { status: 409 });
    }
  }

  const seniority = SENIORITY_KEYS.includes(body.seniority) ? body.seniority : "other";
  const fn = FUNCTION_KEYS.includes(body.function) ? body.function : null;
  const parts = splitName(fullName);

  const { data: person, error: personErr } = await supabase
    .from("people")
    .insert({
      full_name: fullName,
      first_name: body.first_name || parts.first_name,
      middle_name: body.middle_name || parts.middle_name,
      last_name: body.last_name || parts.last_name,
      preferred_name: body.preferred_name || null,
      linkedin_url: body.linkedin_url || null,
      bio: body.bio || null,
      location_city: body.location_city || null,
      location_country: body.location_country || null,
      do_not_contact: !!body.do_not_contact,
      confidence: 1.0,
    })
    .select("id")
    .single();
  if (personErr) {
    return NextResponse.json({ error: personErr.message }, { status: 500 });
  }

  // At most one key contact per firm — a partial unique index enforces it, so
  // the previous holder is stood down first rather than the insert failing.
  // Which one Ardent actually calls is a real fact about the relationship, so
  // the handover gets its own audit row.
  let demoted: string | null = null;
  if (body.is_key_contact) {
    const { data: current } = await supabase
      .from("v_investor_team")
      .select("person_id, full_name")
      .eq("company_id", companyId)
      .eq("is_key_contact", true)
      .maybeSingle();
    if (current) {
      await supabase
        .from("person_roles")
        .update({ is_key_contact: false })
        .eq("company_id", companyId)
        .eq("person_id", current.person_id);
      demoted = current.full_name;
    }
  }

  const email = String(body.email || "").trim() || null;
  const phone = String(body.phone || "").trim() || null;

  const { error: roleErr } = await supabase.from("person_roles").insert({
    person_id: person.id,
    company_id: companyId,
    title: body.title || null,
    seniority,
    function: fn,
    email,
    emails: email ? [email] : [],
    phone,
    phones: phone ? [phone] : [],
    coverage_banker: body.coverage_banker || null,
    start_note: body.start_note || null,
    is_key_contact: !!body.is_key_contact,
  });
  if (roleErr) {
    // The person row would otherwise be left stranded with no firm — nothing
    // in the UI can reach a person with no role, so it would simply rot.
    await supabase.from("people").delete().eq("id", person.id);
    return NextResponse.json({ error: roleErr.message }, { status: 500 });
  }

  const trail: Record<string, unknown>[] = [{
    company_id: companyId,
    field: "contact_added",
    old_value: null,
    new_value: fullName + (body.title ? ` — ${body.title}` : ""),
    source: "analyst",
    rationale: body.rationale || "added by hand",
    changed_by: viewer.id,
  }];
  if (demoted) {
    trail.push({
      company_id: companyId,
      field: "key_contact",
      old_value: demoted,
      new_value: fullName,
      source: "analyst",
      rationale: body.rationale || "key contact changed by hand",
      changed_by: viewer.id,
    });
  }
  await supabase.from("investor_field_history").insert(trail);

  return NextResponse.json({ ok: true, person_id: person.id, demoted });
}

// Fields an analyst may change. Whitelisted rather than passed through: the
// client sends an object, and without this list a typo becomes a new column's
// worth of nonsense or a write to something nobody meant to expose.
const PERSON_FIELDS = ["full_name", "first_name", "middle_name", "last_name",
  "preferred_name", "bio", "linkedin_url", "location_city", "location_country",
  "do_not_contact", "last_interaction_at"];

const ROLE_FIELDS = ["title", "seniority", "function", "email", "phone",
  "coverage_banker", "start_note", "start_date", "end_date"];

// PATCH -> edit a contact.
//
// The audit trail hangs off the FUND, not the person, because that is the only
// history screen this app has and because a change to a contact is a change to
// what is known about that fund. `contact.` prefixes the field name so the fund
// history reads "contact.title" rather than colliding with the fund's own.
export async function PATCH(req: NextRequest) {
  const { viewer, deny } = await requireEditor();
  if (deny) return deny;

  const body = await req.json();
  const personId = String(body?.person_id || "").trim();
  const roleId = String(body?.role_id || "").trim();
  const changes = (body?.changes || {}) as Record<string, unknown>;
  if (!personId) {
    return NextResponse.json({ error: "person_id required" }, { status: 400 });
  }

  const supabase = db();
  const trail: Record<string, unknown>[] = [];

  // A person-level change needs a fund to file the audit row against. The
  // current role is the honest choice: it is where this edit was made from.
  const { data: anchor } = await supabase
    .from("person_roles")
    .select("id, company_id")
    .eq("person_id", personId)
    .order("is_current", { ascending: false })
    .limit(1)
    .maybeSingle();
  const anchorCompany = anchor?.company_id || null;

  const { data: person } = await supabase
    .from("people").select("*").eq("id", personId).maybeSingle();
  if (!person) return NextResponse.json({ error: "No such contact." }, { status: 404 });

  const personUpdate: Record<string, unknown> = {};
  for (const field of PERSON_FIELDS) {
    if (!(field in changes)) continue;
    let value: unknown = changes[field];
    if (typeof value === "string" && value.trim() === "") value = null;
    if (field === "do_not_contact") value = !!changes[field];
    const before = (person as any)[field] ?? null;
    if (String(before ?? "") === String(value ?? "")) continue;
    personUpdate[field] = value;
    if (anchorCompany) {
      trail.push({
        company_id: anchorCompany, field: `contact.${field}`,
        old_value: before == null ? null : String(before),
        new_value: value == null ? null : String(value),
        source: "analyst", rationale: body.rationale || null, changed_by: viewer.id,
      });
    }
  }

  const roleUpdate: Record<string, unknown> = {};
  let role: any = null;
  if (roleId) {
    const { data } = await supabase
      .from("person_roles").select("*").eq("id", roleId).maybeSingle();
    role = data;
    if (!role || role.person_id !== personId) {
      return NextResponse.json({ error: "That role is not this person's." },
        { status: 400 });
    }
    for (const field of ROLE_FIELDS) {
      if (!(field in changes)) continue;
      let value: unknown = changes[field];
      if (typeof value === "string" && value.trim() === "") value = null;
      if (field === "seniority" && !SENIORITY_KEYS.includes(String(value))) continue;
      if (field === "function" && value !== null
          && !FUNCTION_KEYS.includes(String(value))) continue;
      const before = role[field] ?? null;
      if (String(before ?? "") === String(value ?? "")) continue;
      roleUpdate[field] = value;
      // The address itself never goes into the audit trail — the trail is read
      // on a screen that is not allowed to show one. That it changed is recorded.
      const redact = field === "email" || field === "phone";
      trail.push({
        company_id: role.company_id, field: `contact.${field}`,
        old_value: redact ? (before ? "(set)" : null)
                          : before == null ? null : String(before),
        new_value: redact ? (value ? "(set)" : null)
                          : value == null ? null : String(value),
        source: "analyst", rationale: body.rationale || null, changed_by: viewer.id,
      });
    }
    // Keep the array columns and the primary in step, so the contact page and
    // anything reading emails[] do not disagree about the current address.
    if ("email" in roleUpdate) {
      roleUpdate.emails = roleUpdate.email ? [roleUpdate.email] : [];
    }
    if ("phone" in roleUpdate) {
      roleUpdate.phones = roleUpdate.phone ? [roleUpdate.phone] : [];
    }

    // One key contact per firm, enforced by a partial unique index. Stand the
    // previous holder down first or the update simply fails.
    if (changes.is_key_contact !== undefined
        && !!changes.is_key_contact !== !!role.is_key_contact) {
      if (changes.is_key_contact) {
        const { data: held } = await supabase
          .from("person_roles")
          .select("id, person_id")
          .eq("company_id", role.company_id)
          .eq("is_key_contact", true)
          .maybeSingle();
        if (held && held.id !== roleId) {
          await supabase.from("person_roles")
            .update({ is_key_contact: false }).eq("id", held.id);
        }
      }
      roleUpdate.is_key_contact = !!changes.is_key_contact;
      trail.push({
        company_id: role.company_id, field: "contact.is_key_contact",
        old_value: role.is_key_contact ? person.full_name : null,
        new_value: changes.is_key_contact ? person.full_name : null,
        source: "analyst", rationale: body.rationale || null, changed_by: viewer.id,
      });
    }
  }

  if (Object.keys(personUpdate).length) {
    const { error } = await supabase
      .from("people").update(personUpdate).eq("id", personId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (Object.keys(roleUpdate).length) {
    const { error } = await supabase
      .from("person_roles").update(roleUpdate).eq("id", roleId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (trail.length) {
    await supabase.from("investor_field_history").insert(trail);
  }

  return NextResponse.json({ ok: true, changed: trail.length });
}
