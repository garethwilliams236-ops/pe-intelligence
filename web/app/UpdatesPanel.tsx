"use client";

import { useEffect, useMemo, useState } from "react";
import { WebLink } from "./InvestorGrid";
import ProposalRow, { Proposal } from "./ProposalRow";

type Run = {
  id: string; started_at: string; finished_at: string | null; trigger: string;
  attempted: number; fetched: number; proposed: number; failed: number;
  notes: string | null;
};

export default function UpdatesPanel() {
  const [data, setData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [scope, setScope] = useState("oldest");
  const [goal, setGoal] = useState("all");

  async function load() {
    setData(await (await fetch("/api/proposals")).json());
  }
  useEffect(() => { load(); }, []);

  async function runNow() {
    setRunning(true);
    const res = await fetch("/api/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: "manual", scope, goal }),
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
        {/* Which funds, and what to look for. The nightly job runs "oldest /
            everything"; these are for the afternoon you decide to fix one thing
            across the whole book. */}
        <select value={scope} onChange={(e) => setScope(e.target.value)}
          style={{ ...btn, padding: "7px 9px" }}>
          <option value="oldest">longest since checked</option>
          <option value="no_contact">funds with no named contact</option>
          <option value="no_address">funds with no address</option>
          <option value="no_fund_type">funds with no fund type</option>
          <option value="no_website">funds with no website</option>
        </select>
        <select value={goal} onChange={(e) => setGoal(e.target.value)}
          style={{ ...btn, padding: "7px 9px" }}>
          <option value="all">look for everything</option>
          <option value="contacts">contacts only</option>
          <option value="address">address and phone only</option>
          <option value="profile">description and type only</option>
          <option value="website">find a website</option>
        </select>
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
            {/* The scraper read this site — being able to look at it yourself is
                the difference between reviewing a proposal and trusting one. */}
            <WebLink url={items[0].website} />
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#a8a29e" }}>
              {items.length} proposed
            </span>
          </div>

          {items.map((p) => (
            <ProposalRow key={p.id} p={p} onDecided={load} />
          ))}
        </div>
      ))}
    </div>
  );
}
