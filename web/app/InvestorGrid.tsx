"use client";

import { useEffect, useMemo, useState } from "react";
import { ARDENT_FUND_TYPES, fundTypeLabel } from "@/lib/rank";
import { COMPANY_FIELDS, EDITABLE, FieldDef, GEOGRAPHIES, sameValue } from "@/lib/fields";

export type Row = {
  company_id: string; legal_name: string; country_code: string | null;
  fund_type: string | null; invest_geographies: string[]; ardent_sector: string | null;
  check_band: string | null; cheque_min: number | null; cheque_max: number | null;
  cheque_source: string | null; engagement_level: string | null;
  quality_score: number | null; priority: string | null; last_audited: string | null;
  grade: string | null; never_approach: boolean; holdings: number;
  status: string; status_note: string | null; merged_into_id: string | null;
  merged_into_name: string | null; hidden: boolean;
  team_size: number; team_with_email: number;
  key_contact: string | null; key_contact_title: string | null;
  key_contact_has_email: boolean;
  city: string | null; website: string | null; address_line: string | null;
  postcode: string | null; phone: string | null;
};

type History = {
  field: string; old_value: string | null; new_value: string | null;
  source: string; rationale: string | null; changed_at: string;
};

export type TeamMember = {
  person_id: string; full_name: string; title: string | null; seniority: string;
  is_key_contact: boolean; has_email: boolean; linkedin_url: string | null;
  is_current: boolean;
};

const MISSING = "__none__";

export function quantum(r: { check_band: string | null; cheque_min: number | null;
  cheque_max: number | null }) {
  if (r.check_band) return r.check_band;
  if (r.cheque_min == null && r.cheque_max == null) return null;
  const m = (v: number | null) => (v == null ? "?" : `${(Number(v) / 1e6).toFixed(0)}m`);
  return `${m(r.cheque_min)}–${m(r.cheque_max)} (scraped)`;
}

const gap = { color: "#b45309", fontSize: 12 };

export default function InvestorGrid() {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [onlyGaps, setOnlyGaps] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/investors${showHidden ? "?hidden=1" : ""}`);
    setData(await res.json());
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [showHidden]);

  const rows: Row[] = data?.rows || [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (needle && !r.legal_name.toLowerCase().includes(needle)) return false;
      if (typeFilter.length && !typeFilter.includes(r.fund_type || MISSING)) return false;
      if (onlyGaps === "fund_type" && r.fund_type) return false;
      if (onlyGaps === "cheque" && r.cheque_min != null) return false;
      if (onlyGaps === "geography" && (r.invest_geographies || []).length) return false;
      if (onlyGaps === "contact" && r.key_contact) return false;
      return true;
    });
  }, [rows, q, typeFilter, onlyGaps]);

  function toggleType(key: string) {
    setTypeFilter((p) => p.includes(key) ? p.filter((k) => k !== key) : [...p, key]);
  }

  const chip = (on: boolean) => ({
    padding: "5px 10px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
    border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
    background: on ? "#1c1917" : "#fff", color: on ? "#fff" : "#44403c",
  });

  const th = { textAlign: "left" as const, fontWeight: 500, fontSize: 12, color: "#78716c",
    padding: "8px 10px", borderBottom: "1px solid #e7e5e4", position: "sticky" as const,
    top: 0, background: "#fafaf9" };
  const td = { padding: "8px 10px", borderBottom: "1px solid #f5f5f4", fontSize: 13.5,
    verticalAlign: "top" as const };

  if (!data) return <p style={{ color: "#78716c", fontSize: 14 }}>Loading the list…</p>;
  if (data.error) return <p style={{ color: "#b91c1c" }}>{data.error}</p>;

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: "#78716c", fontSize: 14, margin: "0 0 14px" }}>
          The Investor Bible — the whole book, as Ardent records it. Click any fund to correct it — fund type
          and cheque band are the two the ranking leans on hardest. Every change is kept.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {([
            ["fund_type", "no fund type", data.total - data.with_fund_type],
            ["cheque", "no cheque size", data.total - data.with_cheque],
            ["geography", "no geography", data.total - data.with_geography],
            ["contact", "no named contact",
              data.rows.filter((r: Row) => !r.key_contact).length],
          ] as [string, string, number][]).map(([key, name, missing]) => (
            <button key={key} onClick={() => setOnlyGaps(onlyGaps === key ? null : key)}
              style={{ ...chip(onlyGaps === key), padding: "6px 12px" }}>
              {missing} {name}
            </button>
          ))}
          <span style={{ fontSize: 12.5, color: "#a8a29e", alignSelf: "center" }}>
            of {data.total}
          </span>

          {/* Hidden rows are never deleted, so the count is always shown even
              when the rows themselves are not. */}
          <button onClick={() => setShowHidden(!showHidden)}
            style={{ ...chip(showHidden), padding: "6px 12px", marginLeft: "auto" }}
            title={`${data.defunct_count} defunct, ${data.duplicate_count} duplicates`}>
            {showHidden ? "Hide" : "Show"} {data.hidden_count} defunct / duplicate
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12,
          alignItems: "center" }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…"
            style={{ padding: "7px 10px", border: "1px solid #d6d3d1", borderRadius: 6,
              fontSize: 13.5, width: 220 }} />
          {ARDENT_FUND_TYPES.map(([key, name]) => (
            <button key={key} onClick={() => toggleType(key)} style={chip(typeFilter.includes(key))}>
              {name}
            </button>
          ))}
          <button onClick={() => toggleType(MISSING)} style={{
            ...chip(typeFilter.includes(MISSING)), fontStyle: "italic" }}>
            unclassified
          </button>
          {(typeFilter.length > 0 || q || onlyGaps) && (
            <button onClick={() => { setTypeFilter([]); setQ(""); setOnlyGaps(null); }}
              style={{ ...chip(false), color: "#a8a29e" }}>clear</button>
          )}
        </div>

        <p style={{ fontSize: 13, color: "#78716c", margin: "0 0 8px" }}>
          {filtered.length} shown
        </p>

        <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10,
          overflow: "auto", maxHeight: "70vh" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>Investor</th>
                <th style={th}>Fund type</th>
                <th style={th}>Invests in</th>
                <th style={th}>Cheque</th>
                <th style={th}>Key contact</th>
                <th style={th}>Team</th>
                <th style={th}>Audited</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.company_id} onClick={() => setOpenId(r.company_id)}
                  style={{ cursor: "pointer",
                    background: openId === r.company_id ? "#f5f5f4" : "#fff",
                    opacity: r.hidden ? 0.55 : 1 }}>
                  <td style={td}>
                    {r.legal_name}
                    {r.status === "defunct" && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "#b91c1c" }}>defunct</span>
                    )}
                    {r.merged_into_id && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "#b91c1c" }}>
                        duplicate of {r.merged_into_name}
                      </span>
                    )}
                    {r.never_approach && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "#b91c1c" }}>
                        never approach
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {r.fund_type ? fundTypeLabel(r.fund_type) : <span style={gap}>—</span>}
                  </td>
                  <td style={td}>
                    {(r.invest_geographies || []).length
                      ? r.invest_geographies.join("/") : <span style={gap}>—</span>}
                  </td>
                  <td style={td}>{quantum(r) || <span style={gap}>—</span>}</td>
                  <td style={td}>
                    {r.key_contact
                      ? <>{r.key_contact}
                          {r.key_contact_title && (
                            <div style={{ fontSize: 11.5, color: "#a8a29e" }}>
                              {r.key_contact_title}
                            </div>
                          )}
                        </>
                      : <span style={gap}>—</span>}
                  </td>
                  <td style={{ ...td, color: "#a8a29e", fontSize: 12.5 }}>
                    {r.team_size || ""}
                    {r.team_with_email ? ` · ${r.team_with_email} reachable` : ""}
                  </td>
                  <td style={{ ...td, color: "#a8a29e", fontSize: 12.5 }}>
                    {r.last_audited || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {openId && (
        <RecordPanel id={openId} book={rows} onClose={() => setOpenId(null)} onSaved={load} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The skyscraper. Narrow it is for correcting one field; widened it becomes the
// whole record, contact half included, without losing the list behind it.
// ---------------------------------------------------------------------------
function RecordPanel({ id, book, onClose, onSaved }:
  { id: string; book: Row[]; onClose: () => void; onSaved: () => void }) {
  const [record, setRecord] = useState<any>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [dupName, setDupName] = useState("");
  // 380px is right for correcting one field and wrong for reading a firm. The
  // panel grows rather than the record living on a separate page you lose the
  // list to get to.
  const [size, setSize] = useState<"narrow" | "wide" | "full">("narrow");

  async function refresh() {
    const d = await (await fetch(`/api/investors?id=${id}`)).json();
    setRecord(d.investor);
    setTeam(d.team || []);
    setHistory(d.history || []);
    const start: Record<string, any> = {};
    for (const f of [...EDITABLE, ...COMPANY_FIELDS]) {
      start[f.key] = f.key === "invest_geographies"
        ? [...(d.investor?.invest_geographies || [])]
        : d.investor?.[f.key] ?? "";
    }
    setDraft(start);
  }

  useEffect(() => {
    setRecord(null); setDraft({}); setRationale(""); setDupName("");
    refresh();
    /* eslint-disable-next-line */
  }, [id]);

  const dirty = useMemo(() => {
    if (!record) return [];
    return [...EDITABLE, ...COMPANY_FIELDS]
      .filter((f) => !sameValue(record[f.key], draft[f.key])).map((f) => f.key);
  }, [record, draft]);

  async function patch(changes: Record<string, any>) {
    setBusy(true);
    const res = await fetch("/api/investors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: id, changes, rationale }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error) return alert(out.error);
    setRationale("");
    onSaved();
    refresh();
  }

  const box: Record<string, any> = size === "full"
    ? { position: "fixed", inset: 20, zIndex: 50, background: "#fff",
        border: "1px solid #e7e5e4", borderRadius: 10, padding: 22,
        overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.18)" }
    : { width: size === "wide" ? 760 : 380, flexShrink: 0, background: "#fff",
        border: "1px solid #e7e5e4", borderRadius: 10, padding: 16,
        position: "sticky", top: 16, maxHeight: "88vh", overflow: "auto" };
  const expanded = size !== "narrow";
  const field = { padding: "7px 9px", border: "1px solid #d6d3d1", borderRadius: 6,
    fontSize: 13.5, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
  const lab = { fontSize: 12, color: "#57534e", display: "block", marginBottom: 3 };
  const small = { padding: "6px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
    border: "1px solid #e7e5e4", background: "#fff", color: "#44403c" };

  if (!record) return <div style={box}>Loading…</div>;

  const keyContact = team.find((t) => t.is_key_contact) || null;

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
        <strong style={{ fontSize: expanded ? 19 : 15 }}>{record.legal_name}</strong>
        <button onClick={() => setSize(
            size === "narrow" ? "wide" : size === "wide" ? "full" : "narrow")}
          title={size === "full" ? "Back to the column" : "Wider"}
          style={{ marginLeft: "auto", ...small, padding: "3px 9px" }}>
          {size === "narrow" ? "⤢ Wider" : size === "wide" ? "⤢ Full screen" : "⤡ Collapse"}
        </button>
        <button onClick={onClose} style={{ border: "none",
          background: "none", cursor: "pointer", color: "#a8a29e", fontSize: 18 }}>×</button>
      </div>
      <a href={`/investor/${id}`} style={{ fontSize: 12.5, color: "#1c1917" }}>
        Open as its own page →
      </a>

      {record.hidden && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 6,
          background: "#fef2f2", color: "#b91c1c", fontSize: 12.5 }}>
          {record.status === "defunct" ? "Marked defunct." : ""}
          {record.merged_into_name ? ` Duplicate of ${record.merged_into_name}.` : ""}
          {" "}Hidden from the Bible and never ranked.
        </div>
      )}

      <p style={{ fontSize: 12, color: "#a8a29e", margin: "10px 0 14px" }}>
        {record.country_code ? `Office ${record.country_code}` : "No office country on file"}
        {record.holdings ? ` · ${record.holdings} portfolio companies captured` : ""}
      </p>

      <div style={expanded
        ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }
        : {}}>
      <div>
      <ContactCard companyId={id} person={keyContact} teamSize={team.length} />

      {EDITABLE.map((f: FieldDef) => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={lab}>
            {f.label}
            {dirty.includes(f.key) && (
              <span style={{ color: "#b45309", marginLeft: 6 }}>changed</span>
            )}
          </label>

          {f.editor === "select" && (
            <select style={field} value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
              <option value="">— not set —</option>
              {(f.options || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          )}

          {f.editor === "chips" && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {GEOGRAPHIES.map(([v, l]) => {
                const on = (draft[f.key] || []).includes(v);
                return (
                  <button key={v} onClick={() => setDraft({
                    ...draft,
                    [f.key]: on ? (draft[f.key] || []).filter((x: string) => x !== v)
                                : [...(draft[f.key] || []), v],
                  })} style={{
                    padding: "5px 10px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
                    border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
                    background: on ? "#1c1917" : "#fff", color: on ? "#fff" : "#44403c" }}>
                    {l}
                  </button>
                );
              })}
            </div>
          )}

          {(f.editor === "text" || f.editor === "number") && (
            <input style={field} type={f.editor === "number" ? "number" : "text"}
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          )}

          {f.editor === "textarea" && (
            <textarea style={{ ...field, minHeight: 56 }} value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          )}

          {f.hint && (
            <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 3 }}>{f.hint}</div>
          )}
        </div>
      ))}

      </div>

      {/* The contact half. Only worth the space once the panel is open wide,
          and it is the half an analyst reads rather than edits. */}
      {expanded && (
        <div>
          <div style={{ ...lab, marginBottom: 8, fontWeight: 600 }}>Contact</div>
          {COMPANY_FIELDS.map((f: FieldDef) => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <label style={lab}>
                {f.label}
                {!sameValue(record[f.key], draft[f.key]) && (
                  <span style={{ color: "#b45309", marginLeft: 6 }}>changed</span>
                )}
              </label>
              {f.editor === "textarea"
                ? <textarea style={{ ...field, minHeight: 48 }} value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                : <input style={field} value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />}
              {f.hint && (
                <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 3 }}>{f.hint}</div>
              )}
            </div>
          ))}

          <div style={{ ...lab, margin: "16px 0 8px", fontWeight: 600 }}>
            Team — {team.length || "nobody"} on file
            {team.length ? `, ${team.filter((t) => t.has_email).length} reachable` : ""}
          </div>
          <TeamList companyId={id} team={team} />
        </div>
      )}
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={lab}>Why (optional, kept with the change)</label>
        <input style={field} value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="e.g. confirmed on their site, Sept 2026" />
      </div>

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
            <input list="fund-names" style={field} value={dupName}
              onChange={(e) => setDupName(e.target.value)}
              placeholder="Duplicate of… (type the surviving fund)" />
            <datalist id="fund-names">
              {book.filter((b) => b.company_id !== id)
                .map((b) => <option key={b.company_id} value={b.legal_name} />)}
            </datalist>
            {dupName && (
              <button style={{ ...small, marginTop: 6 }} onClick={() => {
                const hit = book.find((b) => b.legal_name === dupName &&
                  b.company_id !== id);
                if (!hit) return alert("Pick a fund from the list.");
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

      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 12, color: "#57534e", marginBottom: 6 }}>
          History {history.length ? `(${history.length})` : ""}
        </div>
        {!history.length && (
          <div style={{ fontSize: 12.5, color: "#a8a29e" }}>Nothing recorded yet.</div>
        )}
        {history.slice(0, 12).map((h, i) => (
          <div key={i} style={{ fontSize: 12, color: "#57534e", padding: "5px 0",
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
  );
}

// One row per person, each with its own reveal. Shared by the panel and the
// fund page so an address is fetched exactly one way, whichever screen asked.
export function TeamList({ companyId, team }:
  { companyId: string; team: TeamMember[] }) {
  const [shown, setShown] = useState<Record<string, string>>({});

  async function reveal(personId: string) {
    const res = await fetch("/api/contact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: companyId, person_id: personId }),
    });
    const out = await res.json();
    setShown((p) => ({
      ...p,
      [personId]: out.email
        ? out.email + (out.phone ? `  ·  ${out.phone}` : "")
        : out.error || "—",
    }));
  }

  if (!team.length) {
    return <div style={{ fontSize: 12.5, color: "#b45309" }}>
      No people captured for this firm yet.
    </div>;
  }

  return (
    <div>
      {team.map((t) => (
        <div key={t.person_id} style={{ padding: "7px 0",
          borderTop: "1px solid #f5f5f4" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 13.5 }}>{t.full_name}</span>
            {t.is_key_contact && (
              <span style={{ fontSize: 10.5, padding: "1px 5px", borderRadius: 4,
                background: "#1c1917", color: "#fff" }}>key</span>
            )}
            {t.linkedin_url && (
              <a href={t.linkedin_url} target="_blank" rel="noreferrer"
                style={{ fontSize: 11.5, color: "#a8a29e" }}>in</a>
            )}
            <span style={{ marginLeft: "auto" }}>
              {shown[t.person_id] ? null : t.has_email ? (
                <button onClick={() => reveal(t.person_id)} style={{
                  padding: "3px 8px", borderRadius: 5, fontSize: 11.5, cursor: "pointer",
                  border: "1px solid #d6d3d1", background: "#fff" }}>
                  Show email
                </button>
              ) : (
                <span style={{ fontSize: 11.5, color: "#a8a29e" }}>no address</span>
              )}
            </span>
          </div>
          {t.title && (
            <div style={{ fontSize: 11.5, color: "#a8a29e" }}>{t.title}</div>
          )}
          {shown[t.person_id] && (
            <div style={{ fontSize: 12.5, marginTop: 2 }}>
              {shown[t.person_id].includes("@")
                ? <a href={`mailto:${shown[t.person_id].split("  ·  ")[0]}`}>
                    {shown[t.person_id]}
                  </a>
                : <span style={{ color: "#b45309" }}>{shown[t.person_id]}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// The address is not in the page until it is asked for. Everything else knows
// only whether one exists.
export function ContactCard({ companyId, person, teamSize }:
  { companyId: string; person: TeamMember | null; teamSize: number }) {
  const [email, setEmail] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setEmail(null); setPhone(null); setErr(null); }, [person?.person_id]);

  if (!person) {
    return (
      <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8,
        padding: "10px 12px", marginBottom: 14, fontSize: 12.5, color: "#b45309" }}>
        No named contact on file
        {teamSize ? ` — ${teamSize} people known at this firm` : ""}.
      </div>
    );
  }

  async function reveal() {
    setBusy(true); setErr(null);
    const res = await fetch("/api/contact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: companyId, person_id: person!.person_id }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error) return setErr(out.error);
    setEmail(out.email);
    setPhone(out.phone || null);
  }

  return (
    <div style={{ background: "#f5f5f4", borderRadius: 8, padding: "10px 12px",
      marginBottom: 14 }}>
      <div style={{ fontSize: 11.5, color: "#a8a29e", marginBottom: 2 }}>Key contact</div>
      <div style={{ fontSize: 14 }}>{person.full_name}</div>
      {person.title && (
        <div style={{ fontSize: 12, color: "#78716c" }}>{person.title}</div>
      )}
      <div style={{ marginTop: 7 }}>
        {email ? (
          <>
            <a href={`mailto:${email}`} style={{ fontSize: 13, color: "#1c1917" }}>{email}</a>
            {phone && <div style={{ fontSize: 12.5, color: "#57534e" }}>{phone}</div>}
          </>
        ) : person.has_email ? (
          <button onClick={reveal} disabled={busy} style={{
            padding: "5px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
            border: "1px solid #d6d3d1", background: "#fff" }}>
            {busy ? "…" : "Show email"}
          </button>
        ) : (
          <span style={{ fontSize: 12.5, color: "#b45309" }}>No address on file</span>
        )}
        {err && <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 4 }}>{err}</div>}
      </div>
    </div>
  );
}
