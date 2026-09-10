"use client";

import { useEffect, useState } from "react";
import { fundTypeLabel } from "@/lib/rank";
import { ContactCard, TeamList, TeamMember, quantum } from "../../InvestorGrid";

// The full record. The skyscraper in the book is for a quick correction; this is
// where the whole team lives, and where the provenance of every field is
// readable rather than truncated to twelve lines.
export default function FundPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch(`/api/investors?id=${id}`).then((r) => r.json()).then(setData);
  }, [id]);

  if (!data) return <main style={{ padding: 32 }}>Loading…</main>;
  if (data.error) return <main style={{ padding: 32, color: "#b91c1c" }}>{data.error}</main>;

  const r = data.investor;
  const team: TeamMember[] = data.team || [];
  const keyContact = team.find((t) => t.is_key_contact) || null;

  const card = { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10,
    padding: 16, marginBottom: 16 };
  const dt = { fontSize: 11.5, color: "#a8a29e", marginBottom: 2 };
  const dd = { fontSize: 14, marginBottom: 12 };

  const facts: [string, any][] = [
    ["Fund type", r.fund_type ? fundTypeLabel(r.fund_type) : null],
    ["Cheque", quantum(r)],
    ["Invests in", (r.invest_geographies || []).join(" / ") || null],
    ["Sector", r.ardent_sector],
    ["Office", r.country_code],
    ["Quality", r.quality_score],
    ["Priority", r.priority],
    ["Engagement", r.engagement_level],
    ["Last audited", r.last_audited],
    ["Grade", r.grade ? r.grade.toUpperCase() : null],
  ];

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px 80px" }}>
      <a href="/" style={{ fontSize: 13, color: "#78716c" }}>← Investor Bible</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: "10px 0 4px" }}>{r.legal_name}</h1>

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
          <div style={card}>
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
            {r.key_investments && (
              <>
                <div style={dt}>Key investments</div>
                <div style={{ fontSize: 13.5 }}>{r.key_investments}</div>
              </>
            )}
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
          </div>

          <div style={card}>
            <strong style={{ fontSize: 15 }}>History</strong>
            {!data.history?.length && (
              <p style={{ fontSize: 13, color: "#a8a29e", margin: "8px 0 0" }}>
                Nothing recorded yet.
              </p>
            )}
            {(data.history || []).map((h: any, i: number) => (
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
