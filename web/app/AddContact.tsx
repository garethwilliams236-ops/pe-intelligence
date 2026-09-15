"use client";

import { useState } from "react";
import { FUNCTION, SENIORITY } from "@/lib/contacts";

// Adding a person to a fund. Folded shut by default: the Team card is read far
// more often than it is written to, and a permanent eight-field form at the
// bottom of it would make the common case look like data entry.
//
// The fields are the CRM's, so a contact created here and a contact created in
// the CRM carry the same information and neither one is the poor relation.
export default function AddContact({ companyId, onAdded }:
  { companyId: string; onAdded?: () => void }) {
  const blank = {
    full_name: "", preferred_name: "", title: "", seniority: "other",
    function: "", email: "", phone: "", linkedin_url: "",
    location_city: "", location_country: "", coverage_banker: "", bio: "",
  };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [keyContact, setKeyContact] = useState(false);
  const [doNotContact, setDoNotContact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupes, setDupes] = useState<{ person_id: string; full_name: string;
    title: string | null }[] | null>(null);

  async function save(force: boolean) {
    setBusy(true); setError(null);
    const res = await fetch("/api/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form, company_id: companyId, is_key_contact: keyContact,
        do_not_contact: doNotContact, force,
      }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error === "possible_duplicate") return setDupes(out.candidates);
    if (out.error) return setError(out.error);
    setForm(blank); setKeyContact(false); setDoNotContact(false);
    setDupes(null); setOpen(false);
    onAdded?.();
  }

  const field = { padding: "7px 9px", border: "1px solid #d6d3d1", borderRadius: 6,
    fontSize: 13.5, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
  const lbl = { fontSize: 11.5, color: "#57534e", display: "block", marginBottom: 3 };
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        marginTop: 10, padding: "5px 10px", borderRadius: 6, fontSize: 12.5,
        cursor: "pointer", border: "1px solid #d6d3d1", background: "#fff",
        color: "#44403c" }}>
        + Add contact
      </button>
    );
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #e7e5e4" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={lbl}>Name</label>
          <input style={field} value={form.full_name} onChange={set("full_name")}
            placeholder="Sarah Collins" autoFocus />
        </div>
        <div>
          <label style={lbl}>Known as</label>
          <input style={field} value={form.preferred_name}
            onChange={set("preferred_name")} placeholder="Sal" />
        </div>
        <div>
          <label style={lbl}>Title</label>
          <input style={field} value={form.title} onChange={set("title")}
            placeholder="Partner, Healthcare" />
        </div>
        <div>
          <label style={lbl}>Seniority</label>
          <select style={field} value={form.seniority} onChange={set("seniority")}>
            {SENIORITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Function</label>
          <select style={field} value={form.function} onChange={set("function")}>
            <option value="">—</option>
            {FUNCTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Email</label>
          <input style={field} value={form.email} onChange={set("email")}
            placeholder="s.collins@fund.com" />
        </div>
        <div>
          <label style={lbl}>Phone</label>
          <input style={field} value={form.phone} onChange={set("phone")} />
        </div>
        <div>
          <label style={lbl}>City</label>
          <input style={field} value={form.location_city}
            onChange={set("location_city")} placeholder="London" />
        </div>
        <div>
          <label style={lbl}>LinkedIn</label>
          <input style={field} value={form.linkedin_url}
            onChange={set("linkedin_url")} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={lbl}>Coverage (who at Ardent owns this relationship)</label>
          <input style={field} value={form.coverage_banker}
            onChange={set("coverage_banker")} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 12.5,
        color: "#44403c" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={keyContact}
            onChange={(e) => setKeyContact(e.target.checked)} />
          Key contact
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={doNotContact}
            onChange={(e) => setDoNotContact(e.target.checked)} />
          Do not contact
        </label>
      </div>

      {keyContact && (
        <div style={{ fontSize: 11.5, color: "#78716c", marginTop: 6 }}>
          A fund has one key contact. If there is already one, they will be stood
          down and the handover recorded in the history.
        </div>
      )}

      {dupes && (
        <div style={{ marginTop: 10, padding: "9px 11px", borderRadius: 7,
          background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12.5,
          color: "#92400e" }}>
          Already at this firm:{" "}
          {dupes.map((d) => d.full_name + (d.title ? ` (${d.title})` : "")).join(", ")}.
          <div style={{ marginTop: 6 }}>
            <button onClick={() => save(true)} disabled={busy} style={{
              padding: "4px 9px", borderRadius: 5, fontSize: 12, cursor: "pointer",
              border: "1px solid #d6d3d1", background: "#fff" }}>
              Different person — add anyway
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: "#b91c1c" }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => save(false)} disabled={busy || !form.full_name.trim()}
          style={{ padding: "7px 14px", borderRadius: 6, fontSize: 13,
            cursor: "pointer", border: "1px solid #1c1917",
            background: form.full_name.trim() ? "#1c1917" : "#a8a29e", color: "#fff" }}>
          {busy ? "Saving…" : "Save contact"}
        </button>
        <button onClick={() => { setOpen(false); setForm(blank); setDupes(null);
          setError(null); }}
          style={{ padding: "7px 14px", borderRadius: 6, fontSize: 13,
            cursor: "pointer", border: "1px solid #e7e5e4", background: "#fff",
            color: "#78716c" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
