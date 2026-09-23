"use client";

import { useCallback, useEffect, useState } from "react";
import ProposalRow, { Proposal } from "./ProposalRow";

// Refresh this one fund, now, while you watch.
//
// Same scraper and the same propose-don't-apply rule as the nightly job — the
// button skips the queue, not the review. Nothing it finds touches the record
// until you accept it, because a robot reading a website at 3pm is no more
// authoritative than one reading it at 3am.
//
// The wait is real: it fetches up to six pages off the firm's own site. So the
// button says what it is doing rather than spinning silently, and anything
// already pending is shown before you press it — pressing Refresh on a fund
// with four unreviewed proposals would otherwise report "0 proposed" and look
// broken, when what it means is "you have not looked at the last lot".
const GOALS: [string, string][] = [
  ["all", "everything"],
  ["contacts", "contacts only"],
  ["address", "address and phone"],
  ["profile", "description and type"],
  ["website", "find a website"],
];

export default function RefreshFund({ companyId, hasWebsite, onApplied }:
  { companyId: string; hasWebsite: boolean; onApplied?: () => void }) {
  const [rows, setRows] = useState<Proposal[] | null>(null);
  const [goal, setGoal] = useState(hasWebsite ? "all" : "website");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/proposals?company_id=${companyId}`)
      .then((r) => r.json())
      .then((d) => setRows(d.rows || []));
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  async function run() {
    setRunning(true); setError(null); setResult(null);
    const res = await fetch("/api/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: "manual", company_id: companyId, goal }),
    });
    const out = await res.json();
    setRunning(false);
    if (out.error) { setError(out.error); return; }
    setResult(
      out.fetched === 0
        ? `Could not read the site (${out.seconds}s). Check the website on the record.`
        : out.proposed === 0
          ? `Read the site in ${out.seconds}s — nothing new to propose.`
          : `Read the site in ${out.seconds}s — ${out.proposed} change${out.proposed === 1 ? "" : "s"} proposed below.`);
    load();
  }

  const btn = { padding: "4px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
    border: "1px solid #d6d3d1", background: "#fff", color: "#44403c" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>Refresh</strong>
        <span style={{ fontSize: 12.5, color: "#a8a29e" }}>
          {rows === null ? "…"
            : rows.length ? `${rows.length} awaiting review`
            : "nothing pending"}
        </span>
        <select value={goal} onChange={(e) => setGoal(e.target.value)}
          style={{ ...btn, marginLeft: "auto", padding: "5px 8px" }}>
          {GOALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button onClick={run} disabled={running} style={{
          ...btn, padding: "6px 12px", background: running ? "#a8a29e" : "#1c1917",
          color: "#fff", border: "none", fontSize: 13 }}>
          {running ? "Reading the site…" : "Refresh now"}
        </button>
      </div>

      {!hasWebsite && (
        <div style={{ fontSize: 12.5, color: "#b45309", marginBottom: 6 }}>
          No website on file — the only thing a refresh can do is go looking for one.
        </div>
      )}

      {result && (
        <div style={{ fontSize: 12.5, color: "#57534e", marginBottom: 4 }}>{result}</div>
      )}
      {error && (
        <div style={{ fontSize: 12.5, color: "#b91c1c", marginBottom: 4 }}>{error}</div>
      )}

      {(rows || []).map((p) => (
        <ProposalRow key={p.id} p={p} onDecided={() => { load(); onApplied?.(); }} />
      ))}
    </div>
  );
}
