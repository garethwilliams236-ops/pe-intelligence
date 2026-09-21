"use client";

import { useCallback, useEffect, useState } from "react";
import { FUNCTION, SENIORITY, functionLabel, seniorityLabel } from "@/lib/contacts";
import InteractionLog from "../../InteractionLog";

// The contact record, laid out like the IB CRM's so that moving between the two
// does not mean relearning where anything is.
//
// The one structural difference is the Firms block. A contact in the CRM has an
// employer; here a person has ROLES, and the old ones are kept. That is what
// lets the page answer "we know them from Bridgepoint" three years after they
// left — the fact a banker actually wants, and the fact a single employer field
// overwrites the moment somebody updates it.
export default function ContactPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>({});
  const [roleForm, setRoleForm] = useState<any>({});
  const [roleId, setRoleId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    fetch(`/api/people?id=${id}`).then((r) => r.json()).then((d) => {
      setData(d);
      if (d?.person) {
        const p = d.person;
        setForm({
          full_name: p.full_name || "", preferred_name: p.preferred_name || "",
          first_name: p.first_name || "", middle_name: p.middle_name || "",
          last_name: p.last_name || "", linkedin_url: p.linkedin_url || "",
          location_city: p.location_city || "", location_country: p.location_country || "",
          bio: p.bio || "", do_not_contact: !!p.do_not_contact,
          last_interaction_at: (p.last_interaction_at || "").slice(0, 10),
        });
      }
      const current = (d?.roles || []).find((r: any) => r.is_current) || d?.roles?.[0];
      if (current) {
        setRoleId(current.role_id);
        setRoleForm({
          title: current.title || "", seniority: current.seniority || "other",
          function: current.function || "", email: "", phone: "",
          coverage_banker: current.coverage_banker || "",
          start_note: current.start_note || "",
          is_key_contact: !!current.is_key_contact,
        });
      }
    });
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function reveal(companyId: string) {
    const res = await fetch("/api/contact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: companyId, person_id: id }),
    });
    const out = await res.json();
    setShown((p) => ({
      ...p,
      [companyId]: out.email
        ? out.email + (out.phone ? `  ·  ${out.phone}` : "")
        : out.error || "—",
    }));
  }

  async function save() {
    setBusy(true); setError(null);
    // A blank address field means "not retyped", not "delete it" — the value was
    // never on the page to begin with, so an empty string here must not be sent.
    const changes: Record<string, unknown> = { ...form, ...roleForm };
    if (!roleForm.email) delete changes.email;
    if (!roleForm.phone) delete changes.phone;
    if (!changes.last_interaction_at) delete changes.last_interaction_at;
    const res = await fetch("/api/people", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ person_id: id, role_id: roleId, changes }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error) return setError(out.error);
    setEdit(false);
    setRoleForm((f: any) => ({ ...f, email: "", phone: "" }));
    load();
  }

  if (!data) return <main style={{ padding: 32 }}>Loading…</main>;
  if (data.error) {
    return <main style={{ padding: 32, color: "#b91c1c" }}>{data.error}</main>;
  }

  const p = data.person;
  const roles: any[] = data.roles || [];
  const current = roles.find((r) => r.is_current) || roles[0] || null;

  const card = { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10,
    padding: 16, marginBottom: 16 };
  const dt = { fontSize: 11.5, color: "#a8a29e", marginBottom: 2 };
  const dd = { fontSize: 14, marginBottom: 12 };
  const field = { padding: "7px 9px", border: "1px solid #d6d3d1", borderRadius: 6,
    fontSize: 13.5, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
  const lbl = { fontSize: 11.5, color: "#57534e", display: "block", marginBottom: 3 };
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const setRole = (k: string) => (e: any) =>
    setRoleForm({ ...roleForm, [k]: e.target.value });

  const facts: [string, any][] = [
    ["Known as", p.preferred_name],
    ["Title", current?.title],
    ["Seniority", seniorityLabel(current?.seniority)],
    ["Function", functionLabel(current?.function)],
    ["City", [p.location_city, p.location_country].filter(Boolean).join(", ")],
    ["Coverage", current?.coverage_banker],
    ["Last interaction", p.last_interaction_at
      ? p.last_interaction_at.slice(0, 10) : null],
    ["LinkedIn", p.linkedin_url ? "yes" : null],
  ];

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "28px 24px 80px" }}>
      {current && (
        <a href={`/investor/${current.company_id}`} style={{ fontSize: 13, color: "#78716c" }}>
          ← {current.company_name}
        </a>
      )}
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: "10px 0 4px",
        display: "flex", alignItems: "center", gap: 10 }}>
        {p.full_name}
        {current?.is_key_contact && (
          <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5,
            background: "#1c1917", color: "#fff", fontWeight: 400 }}>key contact</span>
        )}
        {p.linkedin_url && (
          <a href={p.linkedin_url} target="_blank" rel="noreferrer noopener"
            style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, fontWeight: 400,
              border: "1px solid #e7e5e4", color: "#78716c", textDecoration: "none" }}>
            in
          </a>
        )}
      </h1>

      {p.do_not_contact && (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: "#fef2f2",
          color: "#b91c1c", fontSize: 13, margin: "10px 0 16px" }}>
          Marked do not contact. No address for this person should be used,
          whatever else the record says.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16,
        alignItems: "start" }}>
        <div>
          <div style={card}>
            <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10 }}>
              <strong style={{ fontSize: 15 }}>Record</strong>
              <button onClick={() => setEdit(!edit)} style={{ marginLeft: "auto",
                padding: "4px 9px", borderRadius: 5, fontSize: 12, cursor: "pointer",
                border: "1px solid #d6d3d1", background: "#fff", color: "#44403c" }}>
                {edit ? "Cancel" : "Edit"}
              </button>
            </div>

            {!edit ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <div style={dt}>{label}</div>
                    <div style={dd}>
                      {value == null || value === ""
                        ? <span style={{ color: "#b45309" }}>—</span> : String(value)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={lbl}>Name</label>
                  <input style={field} value={form.full_name} onChange={set("full_name")} />
                </div>
                <div>
                  <label style={lbl}>Known as</label>
                  <input style={field} value={form.preferred_name}
                    onChange={set("preferred_name")} />
                </div>
                <div>
                  <label style={lbl}>Title</label>
                  <input style={field} value={roleForm.title} onChange={setRole("title")} />
                </div>
                <div>
                  <label style={lbl}>Seniority</label>
                  <select style={field} value={roleForm.seniority}
                    onChange={setRole("seniority")}>
                    {SENIORITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Function</label>
                  <select style={field} value={roleForm.function}
                    onChange={setRole("function")}>
                    <option value="">—</option>
                    {FUNCTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Email — leave blank to keep the current one</label>
                  <input style={field} value={roleForm.email} onChange={setRole("email")} />
                </div>
                <div>
                  <label style={lbl}>Phone — leave blank to keep the current one</label>
                  <input style={field} value={roleForm.phone} onChange={setRole("phone")} />
                </div>
                <div>
                  <label style={lbl}>City</label>
                  <input style={field} value={form.location_city}
                    onChange={set("location_city")} />
                </div>
                <div>
                  <label style={lbl}>Country (2 letters)</label>
                  <input style={field} value={form.location_country} maxLength={2}
                    onChange={set("location_country")} />
                </div>
                <div>
                  <label style={lbl}>LinkedIn</label>
                  <input style={field} value={form.linkedin_url}
                    onChange={set("linkedin_url")} />
                </div>
                <div>
                  <label style={lbl}>Last interaction</label>
                  <input style={field} type="date" value={form.last_interaction_at}
                    onChange={set("last_interaction_at")} />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={lbl}>Coverage (who at Ardent owns this relationship)</label>
                  <input style={field} value={roleForm.coverage_banker}
                    onChange={setRole("coverage_banker")} />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={lbl}>Notes</label>
                  <textarea style={{ ...field, minHeight: 70, fontFamily: "inherit" }}
                    value={form.bio} onChange={set("bio")} />
                </div>

                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 16,
                  fontSize: 12.5, color: "#44403c" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center",
                    cursor: "pointer" }}>
                    <input type="checkbox" checked={!!roleForm.is_key_contact}
                      onChange={(e) => setRoleForm({ ...roleForm,
                        is_key_contact: e.target.checked })} />
                    Key contact at {current?.company_name || "this firm"}
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center",
                    cursor: "pointer" }}>
                    <input type="checkbox" checked={!!form.do_not_contact}
                      onChange={(e) => setForm({ ...form,
                        do_not_contact: e.target.checked })} />
                    Do not contact
                  </label>
                </div>

                {error && (
                  <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: "#b91c1c" }}>
                    {error}
                  </div>
                )}

                <div style={{ gridColumn: "1 / -1" }}>
                  <button onClick={save} disabled={busy} style={{
                    padding: "7px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer",
                    border: "1px solid #1c1917", background: "#1c1917", color: "#fff" }}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            )}

            {!edit && p.bio && (
              <div style={{ borderTop: "1px solid #f5f5f4", paddingTop: 10 }}>
                <div style={dt}>Notes</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{p.bio}</div>
              </div>
            )}
          </div>

          <div style={card}>
            <InteractionLog
              personId={id}
              defaultPersonIds={[id]}
              defaultCompanyIds={current ? [current.company_id] : []}
            />
          </div>

          <div style={card}>
            <strong style={{ fontSize: 15 }}>Firms</strong>
            <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 2,
              marginBottom: 6 }}>
              Past roles are kept. Where we know someone from is usually the
              reason we can call them.
            </div>
            {roles.map((r) => (
              <div key={r.role_id} style={{ padding: "8px 0",
                borderTop: "1px solid #f5f5f4" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <a href={`/investor/${r.company_id}`}
                    style={{ fontSize: 13.5, color: "#1c1917" }}>
                    {r.company_name}
                  </a>
                  {!r.is_current && (
                    <span style={{ fontSize: 10.5, color: "#a8a29e" }}>past</span>
                  )}
                  {r.is_key_contact && (
                    <span style={{ fontSize: 10.5, padding: "1px 5px", borderRadius: 4,
                      background: "#1c1917", color: "#fff" }}>key</span>
                  )}
                  <span style={{ marginLeft: "auto" }}>
                    {shown[r.company_id] ? null : r.has_email ? (
                      <button onClick={() => reveal(r.company_id)} style={{
                        padding: "3px 8px", borderRadius: 5, fontSize: 11.5,
                        cursor: "pointer", border: "1px solid #d6d3d1",
                        background: "#fff" }}>
                        Show email
                      </button>
                    ) : (
                      <span style={{ fontSize: 11.5, color: "#a8a29e" }}>no address</span>
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "#a8a29e" }}>
                  {[r.title, seniorityLabel(r.seniority), functionLabel(r.function)]
                    .filter(Boolean).join(" · ") || "no title recorded"}
                  {r.start_date && ` · from ${r.start_date}`}
                  {r.end_date && ` to ${r.end_date}`}
                </div>
                {shown[r.company_id] && (
                  <div style={{ fontSize: 12.5, marginTop: 3 }}>
                    {shown[r.company_id].includes("@")
                      ? <a href={`mailto:${shown[r.company_id].split("  ·  ")[0]}`}>
                          {shown[r.company_id]}
                        </a>
                      : <span style={{ color: "#b45309" }}>{shown[r.company_id]}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={card}>
            <div style={dt}>Reachable</div>
            <div style={{ fontSize: 13.5, marginBottom: 12 }}>
              {current?.has_email
                ? <>Email on file{current.other_emails
                    ? ` (+${current.other_emails} more)` : ""}</>
                : <span style={{ color: "#b45309" }}>No address on file</span>}
              <div style={{ color: current?.has_phone ? "#1c1917" : "#b45309" }}>
                {current?.has_phone ? "Phone on file" : "No phone on file"}
              </div>
            </div>
            <div style={dt}>Added</div>
            <div style={{ fontSize: 13 }}>
              {p.created_at ? p.created_at.slice(0, 10) : "—"}
            </div>
            <div style={{ ...dt, marginTop: 10 }}>Last changed</div>
            <div style={{ fontSize: 13 }}>
              {p.updated_at ? p.updated_at.slice(0, 10) : "—"}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: "#a8a29e", lineHeight: 1.5,
            padding: "0 4px" }}>
            Addresses are shown one at a time, on request, and every change is
            written into the fund&rsquo;s history. Nothing on this page can be
            exported in bulk.
          </div>
        </div>
      </div>
    </main>
  );
}
