"use client";

import { useEffect, useMemo, useState } from "react";
import { fundTypeLabel } from "@/lib/rank";

type Proposal = {
  id: string; company_id: string; legal_name: string; website: string | null;
  field: string; current_value: string | null; proposed_value: string | null;
  confidence: number; evidence_url: string | null; evidence_snippet: string | null;
  created_at: string;
};

type Run = {
  id: string; started_at: string; finished_at: string | null; trigger: string;
  attempted: number; fetched: number; proposed: number; failed: number;
  notes: string | null;
};

const FIELD_LABEL: Record<string, string> = {
  address_line: "Address", postcode: "Postcode", city: "City", phone: "Switchboard",
  website: "Website", description: "Description", fund_type: "Fund type",
};

function show(field: string, value: string | null) {
  if (value == null || value === "") return "—";
  return field === "fund_type" ? fundTypeLabel(value) : value;
}

export default function UpdatesPanel() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [amending, setAmending] = useState<Record<string, string>>({});

  async function load() {
    setData(await (await fetch("/api/proposals")).json());
  }
  useEffect(() => { load(); }, []);

  async function decide(id: string, action: string, value?: string) {
    setBusy(id);
    const res = await fetch("/api/proposals", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action, value }),
    });
    const out = await res.json();
    setBusy(null);
    if (out.error) return alert(out.error);
    setAmending((a) => { const n = { ...a }; delete n[id]; return n; });
    load();
  }

  async function runNow() {
    setRunning(true);
    const res = await fetch("/api/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: "manual" }),
    });
    const out = await res.json();
    setRunning(false);
    if (out.error) return alert(out.error);
    alert(`Looked at ${out.attempted} funds, reached ${out.fetched}, ` +
      `${out.proposed} changes proposed, ${out.failed} unreachable. ` +
      `${out.seconds}s.${out.stopped_early ? " Stopped on the time budget — run again for the rest." : ""}`);
    load();
  }

  const rows: Proposal[] = data?.rows || [];

  // Grouped by fund: reviewing eight fields for one firm in a block beats
  // bouncing between firms field by field.
  const byFund = useMemo(() => {
    const map = new Map<string, Proposal[]>();
    for (const r of rows) {
      const list = map.get(r.company_id) || [];
      list.push(r);
      map.set(r.company_id, list);
    }
    return [...map.entries()];
  }, [rows]);

  const btn = { padding: "4px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
    border: "1px solid #d6d3d1", background: "#fff", color: "#44403c" };

  if (!data) return <p style={{ color: "#78716c", fontSize: 14 }}>Loading the queue…</p>;
  if (data.error) return <p style={{ color: "#b91c1c" }}>{data.error}</p>;

  const last: Run | undefined = data.runs?.[0];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <p style={{ color: "#78716c", fontSize: 14, margin: 0, flex: 1 }}>
          Twenty funds a night, read from their own websites. Nothing here has touched
          the Bible — accepting one writes it through with the same audit trail as
          your own edits, rejecting one records that the site was wrong.
        </p>
        <button onClick={runNow} disabled={running} style={{
          ...btn, padding: "8px 14px", background: "#1c1917", color: "#fff",
          border: "none", fontSize: 13.5 }}>
          {running ? "Running…" : "Run now"}
        </button>
      </div>

      <p style={{ fontSize: 12.5, color: "#a8a29e", marginTop: 0, marginBottom: 18 }}>
        {last
          ? `Last run ${new Date(last.started_at).toLocaleString("en-GB")} (${last.trigger}): ` +
            `${last.fetched}/${last.attempted} reached, ${last.proposed} proposed, ` +
            `${last.failed} unreachable.` + (last.notes ? ` ${last.notes}` : "")
          : "No run yet."}
        {" "}{data.reviewed} reviewed to date.
      </p>

      {!rows.length && (
        <p style={{ fontSize: 14, color: "#78716c" }}>
          Nothing waiting. The next batch runs overnight.
        </p>
      )}

      {byFund.map(([companyId, items]) => (
        <div key={companyId} style={{ background: "#fff", border: "1px solid #e7e5e4",
          borderRadius: 10, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
            <strong style={{ fontSize: 15 }}>{items[0].legal_name}</strong>
            <a href={`/investor/${companyId}`} style={{ fontSize: 12.5, color: "#78716c" }}>
              fund page →
            </a>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#a8a29e" }}>
              {items.length} proposed
            </span>
          </div>

          {items.map((p) => (
            <div key={p.id} style={{ padding: "10px 0", borderTop: "1px solid #f5f5f4" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ width: 96, fontSize: 12, color: "#78716c", paddingTop: 2 }}>
                  {FIELD_LABEL[p.field] || p.field}
                  <div style={{ fontSize: 11,
                    color: p.confidence >= 0.7 ? "#a8a29e" : "#b45309" }}>
                    {Math.round(p.confidence * 100)}% sure
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "#a8a29e",
                    textDecoration: p.current_value ? "line-through" : "none" }}>
                    {show(p.field, p.current_value)}
                  </div>
                  {amending[p.id] !== undefined ? (
                    <input autoFocus value={amending[p.id]}
                      onChange={(e) => setAmending({ ...amending, [p.id]: e.target.value })}
                      style={{ width: "100%", padding: "6px 8px", fontSize: 13.5,
                        border: "1px solid #1c1917", borderRadius: 6, marginTop: 3 }} />
                  ) : (
                    <div style={{ fontSize: 14, marginTop: 2 }}>
                      {show(p.field, p.proposed_value)}
                    </div>
                  )}
                  {p.evidence_snippet && (
                    <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 4 }}>
                      “{p.evidence_snippet}”
                      {p.evidence_url && (
                        <> · <a href={p.evidence_url} target="_blank" rel="noreferrer"
                          style={{ color: "#78716c" }}>source</a></>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                  {amending[p.id] !== undefined ? (
                    <>
                      <button style={{ ...btn, borderColor: "#1c1917" }}
                        disabled={busy === p.id}
                        onClick={() => decide(p.id, "amend", amending[p.id])}>
                        Save
                      </button>
                      <button style={btn} onClick={() => setAmending((a) => {
                        const n = { ...a }; delete n[p.id]; return n;
                      })}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button style={{ ...btn, borderColor: "#1c1917" }}
                        disabled={busy === p.id}
                        onClick={() => decide(p.id, "accept")}>
                        Accept
                      </button>
                      <button style={btn} disabled={busy === p.id}
                        onClick={() => setAmending({
                          ...amending, [p.id]: p.proposed_value || "" })}>
                        Amend
                      </button>
                      <button style={{ ...btn, color: "#b91c1c" }} disabled={busy === p.id}
                        onClick={() => decide(p.id, "reject")}>
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
