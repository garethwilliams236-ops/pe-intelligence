"use client";

import { useCallback, useEffect, useState } from "react";
import { ContactCard, TeamList, TeamMember, WebLink } from "../../InvestorGrid";
import AddContact from "../../AddContact";
import InteractionLog from "../../InteractionLog";
import RefreshFund from "../../RefreshFund";
import RecordEditor, { HistoryList } from "../../RecordEditor";

// The fund's own page. Same capabilities as the Bible's slide-out panel, and
// the same components — the record editor, the team, the refresh, the log and
// the history are all imported by both. What differs is room: this lays the
// editor out in two columns and shows the whole history rather than the last
// twelve, because it is not living in a 380px column.
export default function FundPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [data, setData] = useState<any>(null);
  const [book, setBook] = useState<any[]>([]);
  const [version, setVersion] = useState(0);
  const load = useCallback(() => {
    fetch(`/api/investors?id=${id}`).then((r) => r.json()).then((d) => {
      setData(d);
      setVersion((v) => v + 1);
    });
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // The whole book, only for the "duplicate of…" picker. The panel is handed
  // this by the grid it lives in; a page opened cold has to ask.
  useEffect(() => {
    fetch("/api/investors?hidden=1").then((r) => r.json())
      .then((d) => setBook(d.rows || []));
  }, []);

  if (!data) return <main style={{ padding: 32 }}>Loading…</main>;
  if (data.error) return <main style={{ padding: 32, color: "#b91c1c" }}>{data.error}</main>;

  const r = data.investor;
  const team: TeamMember[] = data.team || [];
  const keyContact = team.find((t) => t.is_key_contact) || null;

  const card = { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10,
    padding: 16, marginBottom: 16 };
  const summary = [
    r.country_code ? `Office ${r.country_code}` : "No office country on file",
    r.grade ? `grade ${String(r.grade).toUpperCase()}` : null,
    r.last_audited ? `last audited ${r.last_audited}` : null,
    r.holdings
      ? `${r.holdings} portfolio companies captured${r.latest_year ? `, most recent ${r.latest_year}` : ""}`
      : "no portfolio evidence captured yet",
  ].filter(Boolean).join(" · ");

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px 80px" }}>
      <a href="/" style={{ fontSize: 13, color: "#78716c" }}>← Investor Bible</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: "10px 0 4px",
        display: "flex", alignItems: "center", gap: 10 }}>
        {r.legal_name}
        <WebLink url={r.website} />
      </h1>

      {r.hidden && (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: "#fef2f2",
          color: "#b91c1c", fontSize: 13, marginBottom: 16 }}>
          {r.status === "defunct" && "Marked defunct. "}
          {r.merged_into_name && `Duplicate of ${r.merged_into_name}. `}
          Hidden from the Bible and excluded from every ranking. Nothing has been
          deleted — this can be reversed from the Bible.
          {r.status_note && <div style={{ marginTop: 4 }}>{r.status_note}</div>}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 16,
        alignItems: "start" }}>
        <div>
          <p style={{ fontSize: 12, color: "#a8a29e", margin: "0 0 14px" }}>
            {summary}
          </p>

          <div style={card}>
            <RecordEditor key={version} id={id} record={r} book={book}
              columns={2} onSaved={load} />
          </div>

          <div style={card}>
            <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10 }}>
              <strong style={{ fontSize: 15 }}>Team</strong>
              <span style={{ marginLeft: 8, fontSize: 12.5, color: "#a8a29e" }}>
                {team.length
                  ? `${team.length} on file, ${team.filter((t) => t.has_email).length} with an address`
                  : "nobody on file"}
              </span>
            </div>
            <TeamList companyId={id} team={team} />
            <AddContact companyId={id} onAdded={load} />
          </div>

          <div style={card}>
            <RefreshFund companyId={id} hasWebsite={!!r.website} onApplied={load} />
          </div>

          <div style={card}>
            <InteractionLog
              companyId={id}
              defaultCompanyIds={[id]}
              people={team.map((t) => ({ person_id: t.person_id,
                full_name: t.full_name }))}
            />
          </div>

          <div style={card}>
            <strong style={{ fontSize: 15 }}>History</strong>
            <div style={{ marginTop: 6 }}>
              <HistoryList history={data.history || []} />
            </div>
          </div>
        </div>

        <div>
          <div style={card}>
            <ContactCard companyId={id} person={keyContact} teamSize={team.length} />
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
              {[r.address_line, r.city, r.postcode].filter(Boolean).join(", ") || (
                <span style={{ color: "#b45309" }}>No address on file</span>
              )}
              {r.phone && <div>{r.phone}</div>}
              {r.website && (
                <div>
                  <a href={r.website.startsWith("http") ? r.website : `https://${r.website}`}
                    target="_blank" rel="noreferrer">{r.website}</a>
                </div>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: "#78716c" }}>
              {r.holdings
                ? `${r.holdings} portfolio companies captured${r.latest_year ? `, most recent ${r.latest_year}` : ""}`
                : "No portfolio evidence captured yet"}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
