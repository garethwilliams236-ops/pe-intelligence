"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DIRECTION, INTERACTION_TYPE, Interaction, SENTIMENT,
  directionLabel, howLongAgo, localNow, sentimentLabel, typeLabel, when,
} from "@/lib/interactions";

// The activity feed, shared by the fund page and the contact page.
//
// One component for both because a meeting is the same event whichever door
// you came through — the only difference is which id the feed is filtered on,
// and what a new entry is attached to by default.
//
// Logging from a contact page attaches BOTH the person and their firm. That is
// what makes the two feeds agree: a call with Sarah Collins at Testcap shows on
// her record and on Testcap's, because it happened to both of them.
export default function InteractionLog({
  companyId, personId, defaultCompanyIds = [], defaultPersonIds = [],
  people = [],
}: {
  companyId?: string;
  personId?: string;
  defaultCompanyIds?: string[];
  defaultPersonIds?: string[];
  people?: { person_id: string; full_name: string }[];
}) {
  const [rows, setRows] = useState<Interaction[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = {
    interaction_type: "meeting", direction: "outbound", sentiment: "unknown",
    subject: "", body: "", location: "", duration_minutes: "",
    occurred_at: localNow(),
  };
  const [form, setForm] = useState(blank);
  const [withPeople, setWithPeople] = useState<string[]>(defaultPersonIds);

  const query = companyId ? `company_id=${companyId}` : `person_id=${personId}`;
  const load = useCallback(() => {
    fetch(`/api/interactions?${query}`).then((r) => r.json())
      .then((d) => setRows(d.rows || []));
  }, [query]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setError(null);
    const res = await fetch("/api/interactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        company_ids: defaultCompanyIds,
        person_ids: Array.from(new Set([...defaultPersonIds, ...withPeople])),
      }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error) return setError(out.error);
    setForm({ ...blank, occurred_at: localNow() });
    setWithPeople(defaultPersonIds);
    setOpen(false);
    load();
  }

  async function remove(id: string) {
    const res = await fetch(`/api/interactions?id=${id}`, { method: "DELETE" });
    const out = await res.json();
    if (out.error) return setError(out.error);
    load();
  }

  const field = { padding: "7px 9px", border: "1px solid #d6d3d1", borderRadius: 6,
    fontSize: 13.5, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
  const lbl = { fontSize: 11.5, color: "#57534e", display: "block", marginBottom: 3 };
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const last = rows?.length ? howLongAgo(rows[0].occurred_at) : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>Interactions</strong>
        <span style={{ marginLeft: 8, fontSize: 12.5, color: "#a8a29e" }}>
          {rows === null ? "…"
            : rows.length ? `${rows.length} logged, last ${last}`
            : "nothing logged"}
        </span>
        <button onClick={() => setOpen(!open)} style={{ marginLeft: "auto",
          padding: "4px 9px", borderRadius: 5, fontSize: 12, cursor: "pointer",
          border: "1px solid #d6d3d1", background: "#fff", color: "#44403c" }}>
          {open ? "Cancel" : "+ Log interaction"}
        </button>
      </div>

      {open && (
        <div style={{ padding: "12px 0", borderTop: "1px solid #e7e5e4",
          borderBottom: "1px solid #e7e5e4", marginBottom: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div>
              <label style={lbl}>Type</label>
              <select style={field} value={form.interaction_type}
                onChange={set("interaction_type")}>
                {INTERACTION_TYPE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Who started it</label>
              <select style={field} value={form.direction} onChange={set("direction")}>
                {DIRECTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>When</label>
              <input style={field} type="datetime-local" value={form.occurred_at}
                onChange={set("occurred_at")} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lbl}>Subject</label>
              <input style={field} value={form.subject} onChange={set("subject")}
                placeholder="Intro call — Project Meridian" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lbl}>Notes</label>
              <textarea style={{ ...field, minHeight: 80, fontFamily: "inherit" }}
                value={form.body} onChange={set("body")} />
            </div>
            <div>
              <label style={lbl}>Minutes</label>
              <input style={field} value={form.duration_minutes}
                onChange={set("duration_minutes")} inputMode="numeric" />
            </div>
            <div>
              <label style={lbl}>Location</label>
              <input style={field} value={form.location} onChange={set("location")} />
            </div>
            <div>
              <label style={lbl}>How it went</label>
              <select style={field} value={form.sentiment} onChange={set("sentiment")}>
                {SENTIMENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>

          {people.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <label style={lbl}>Who was there</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {people.map((p) => {
                  const on = withPeople.includes(p.person_id);
                  return (
                    <button key={p.person_id} type="button" onClick={() =>
                      setWithPeople(on
                        ? withPeople.filter((x) => x !== p.person_id)
                        : [...withPeople, p.person_id])}
                      style={{ padding: "5px 10px", borderRadius: 999, fontSize: 12.5,
                        cursor: "pointer",
                        border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
                        background: on ? "#1c1917" : "#fff",
                        color: on ? "#fff" : "#44403c" }}>
                      {p.full_name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12.5, color: "#b91c1c", marginTop: 8 }}>{error}</div>
          )}

          <button onClick={save} disabled={busy} style={{ marginTop: 12,
            padding: "7px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer",
            border: "1px solid #1c1917", background: "#1c1917", color: "#fff" }}>
            {busy ? "Saving…" : "Log it"}
          </button>
        </div>
      )}

      {rows !== null && !rows.length && !open && (
        <div style={{ fontSize: 12.5, color: "#b45309" }}>
          Nothing logged yet.
        </div>
      )}

      {(rows || []).map((r) => (
        <div key={r.id} style={{ padding: "9px 0", borderTop: "1px solid #f5f5f4" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4,
              background: "#f5f5f4", color: "#44403c" }}>
              {typeLabel(r.interaction_type)}
            </span>
            <span style={{ fontSize: 13.5 }}>
              {r.subject || <span style={{ color: "#a8a29e" }}>no subject</span>}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#a8a29e" }}>
              {when(r.occurred_at)}
            </span>
            <button onClick={() => remove(r.id)} title="Delete — for a mislogged entry"
              style={{ padding: "0 4px", fontSize: 12, cursor: "pointer",
                border: "none", background: "none", color: "#d6d3d1" }}>
              ×
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 1 }}>
            {[
              r.direction !== "not_applicable" ? directionLabel(r.direction) : null,
              r.duration_minutes ? `${r.duration_minutes} min` : null,
              r.location,
              r.sentiment !== "unknown" ? sentimentLabel(r.sentiment) : null,
              // On a contact's page the firms matter; on a fund's page the people do.
              companyId ? (r.people.length ? r.people.join(", ") : null)
                        : (r.firms.length ? r.firms.join(", ") : null),
              r.logged_by_email ? `logged by ${r.logged_by_email}` : null,
            ].filter(Boolean).join(" · ")}
          </div>
          {r.body && (
            <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5,
              whiteSpace: "pre-wrap" }}>
              {r.body}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
