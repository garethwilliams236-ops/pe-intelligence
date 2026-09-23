"use client";

import { useMemo, useState } from "react";
import {
  COMPANY_FIELDS, EDITABLE, FieldDef, GEOGRAPHIES, sameValue,
} from "@/lib/fields";

// The fund's editable record, and the two ways out of the Bible.
//
// Lifted out of the Bible's slide-out panel so the fund page runs the same
// code. There were two surfaces for one fund and each could do something the
// other could not — the panel could set a website but not add a contact, the
// page the reverse — because every feature landed on whichever surface was
// open at the time. Sharing the component is the only version of "consistent"
// that stays true after the next change.
//
// It owns the draft and the save. It does not own the record: the parent
// fetched it and the parent refetches on onSaved, because the panel and the
// page each hold other things that go stale at the same moment.

export type HistoryRow = {
  field: string; old_value: string | null; new_value: string | null;
  source: string; rationale: string | null; changed_at: string;
};

const field = { padding: "7px 9px", border: "1px solid #d6d3d1", borderRadius: 6,
  fontSize: 13.5, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
const lab = { fontSize: 12, color: "#57534e", display: "block", marginBottom: 3 };
const small = { padding: "6px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
  border: "1px solid #e7e5e4", background: "#fff", color: "#44403c" };

export default function RecordEditor({
  id, record, book, columns = 1, onSaved,
}: {
  id: string;
  record: any;
  book: { company_id: string; legal_name: string }[];
  columns?: 1 | 2;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, any>>(() => {
    const start: Record<string, any> = {};
    for (const f of [...EDITABLE, ...COMPANY_FIELDS]) {
      start[f.key] = f.key === "invest_geographies"
        ? [...(record?.invest_geographies || [])]
        : record?.[f.key] ?? "";
    }
    return start;
  });
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupName, setDupName] = useState("");

  const dirty = useMemo(() =>
    [...EDITABLE, ...COMPANY_FIELDS]
      .filter((f) => !sameValue(record[f.key], draft[f.key])).map((f) => f.key),
    [record, draft]);

  async function patch(changes: Record<string, any>) {
    setBusy(true); setError(null);
    const res = await fetch("/api/investors", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: id, changes, rationale }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error) return setError(out.error);
    setRationale("");
    onSaved();
  }

  function input(f: FieldDef) {
    const changed = !sameValue(record[f.key], draft[f.key]);
    const set = (v: any) => setDraft({ ...draft, [f.key]: v });
    return (
      <div key={f.key} style={{ marginBottom: 12 }}>
        <label style={lab}>
          {f.label}
          {changed && <span style={{ color: "#b45309", marginLeft: 6 }}>changed</span>}
        </label>

        {f.editor === "select" && (
          <select style={field} value={draft[f.key] ?? ""}
            onChange={(e) => set(e.target.value)}>
            <option value="">— not set —</option>
            {(f.options || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}

        {f.editor === "chips" && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {(f.options || GEOGRAPHIES).map(([v, l]) => {
              const on = (draft[f.key] || []).includes(v);
              return (
                <button key={v} onClick={() => set(
                  on ? (draft[f.key] || []).filter((x: string) => x !== v)
                     : [...(draft[f.key] || []), v])}
                  style={{
                    padding: "5px 10px", borderRadius: 999, fontSize: 12.5,
                    cursor: "pointer",
                    border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
                    background: on ? "#1c1917" : "#fff",
                    color: on ? "#fff" : "#44403c" }}>
                  {l}
                </button>
              );
            })}
          </div>
        )}

        {(f.editor === "text" || f.editor === "number") && (
          <input style={field} type={f.editor === "number" ? "number" : "text"}
            value={draft[f.key] ?? ""} onChange={(e) => set(e.target.value)} />
        )}

        {f.editor === "textarea" && (
          <textarea style={{ ...field, minHeight: 56 }} value={draft[f.key] ?? ""}
            onChange={(e) => set(e.target.value)} />
        )}

        {f.hint && (
          <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 3 }}>{f.hint}</div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={columns === 2
        ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24,
            alignItems: "start" }
        : {}}>
        <div>{EDITABLE.map(input)}</div>
        <div>
          <div style={{ ...lab, marginBottom: 8, fontWeight: 600 }}>
            Where they are
          </div>
          {COMPANY_FIELDS.map(input)}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={lab}>Why (optional, kept with the change)</label>
        <input style={field} value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="e.g. confirmed on their site, Sept 2026" />
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: "#b91c1c", marginBottom: 8 }}>{error}</div>
      )}

      <button onClick={() => {
        const changes: Record<string, any> = {};
        for (const k of dirty) changes[k] = draft[k];
        patch(changes);
      }} disabled={busy || !dirty.length} style={{
        width: "100%", padding: "9px 0", borderRadius: 6, border: "none", fontSize: 14,
        background: dirty.length ? "#1c1917" : "#e7e5e4",
        color: dirty.length ? "#fff" : "#a8a29e",
        cursor: dirty.length ? "pointer" : "default" }}>
        {busy ? "Saving…" : dirty.length
          ? `Save ${dirty.length} change${dirty.length > 1 ? "s" : ""}`
          : "No changes"}
      </button>

      {/* Removal, kept apart from the fields above and from each other. Neither
          deletes anything; both are one click to undo. */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #f5f5f4" }}>
        <div style={{ ...lab, marginBottom: 8 }}>Take out of the Bible</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {record.status !== "defunct" ? (
            <button style={small} onClick={() => patch({ status: "defunct" })}>
              Mark defunct
            </button>
          ) : (
            <button style={small} onClick={() => patch({ status: "active" })}>
              No longer defunct
            </button>
          )}
          {record.merged_into_id && (
            <button style={small} onClick={() => patch({ merged_into_id: null })}>
              Not a duplicate
            </button>
          )}
        </div>

        {!record.merged_into_id && (
          <div style={{ marginTop: 8 }}>
            <input list={`fund-names-${id}`} style={field} value={dupName}
              onChange={(e) => setDupName(e.target.value)}
              placeholder="Duplicate of… (type the surviving fund)" />
            <datalist id={`fund-names-${id}`}>
              {book.filter((b) => b.company_id !== id)
                .map((b) => <option key={b.company_id} value={b.legal_name} />)}
            </datalist>
            {dupName && (
              <button style={{ ...small, marginTop: 6 }} onClick={() => {
                const hit = book.find((b) => b.legal_name === dupName
                  && b.company_id !== id);
                if (!hit) return setError("Pick a fund from the list.");
                patch({ merged_into_id: hit.company_id });
              }}>
                Merge into {dupName}
              </button>
            )}
            <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 4 }}>
              The duplicate keeps its evidence and points at the survivor — nothing
              is deleted.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// The audit trail, same on both surfaces. `limit` is the only difference: a
// 380px column shows the last dozen, a full page shows the lot.
export function HistoryList({ history, limit }:
  { history: HistoryRow[]; limit?: number }) {
  if (!history.length) {
    return <div style={{ fontSize: 12.5, color: "#a8a29e" }}>Nothing recorded yet.</div>;
  }
  return (
    <>
      {(limit ? history.slice(0, limit) : history).map((h, i) => (
        <div key={i} style={{ fontSize: 12.5, color: "#57534e", padding: "6px 0",
          borderTop: "1px solid #f5f5f4" }}>
          <span style={{ color: "#a8a29e" }}>
            {h.changed_at.slice(0, 10)} · {h.source}
          </span>{" "}
          {h.field}: <span style={{ color: "#a8a29e" }}>{h.old_value || "—"}</span>
          {" → "}<strong>{h.new_value || "—"}</strong>
          {h.rationale && <div style={{ color: "#a8a29e" }}>{h.rationale}</div>}
        </div>
      ))}
    </>
  );
}
