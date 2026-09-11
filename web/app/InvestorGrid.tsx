"use client";

import { useEffect, useMemo, useState } from "react";
import { ARDENT_FUND_TYPES, fundTypesLabel, sharesType } from "@/lib/rank";
import { CHEQUE_BANDS, COMPANY_FIELDS, EDITABLE, FieldDef, GEOGRAPHIES, sameValue } from "@/lib/fields";

export type Row = {
  company_id: string; legal_name: string; country_code: string | null;
  fund_types: string[]; invest_geographies: string[]; ardent_sector: string | null;
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

// Ticket size filters on the NUMBER, not on the band label. 209 funds carry a
// scraped range and no band at all; matching on the label would silently hide
// every one of them from a ticket filter, which is the same class of bug as
// filtering on HQ country instead of investment geography.
const BAND_RANGE: Record<string, [number, number]> = {
  "£0-5m": [0, 5e6],
  "£5-20m": [5e6, 20e6],
  "£20-60m": [20e6, 60e6],
  "£60-200m": [60e6, 200e6],
  "£200- £900m": [200e6, 900e6],
};

function overlapsBands(r: { cheque_min: number | null; cheque_max: number | null },
                       bands: string[]): boolean {
  if (r.cheque_min == null && r.cheque_max == null) return false;
  const lo = Number(r.cheque_min ?? 0);
  const hi = Number(r.cheque_max ?? lo);
  return bands.some((b) => {
    const range = BAND_RANGE[b];
    return range && lo <= range[1] && hi >= range[0];
  });
}

// A discreet way out to the fund's own site, for the times the only way to
// settle a question is to look at it. Deliberately small: it appears on every
// row and should read as an affordance, not a call to action.
//
// stopPropagation matters — in the grid this sits inside a row whose click
// opens the record panel, and without it you would get both.
export function WebLink({ url, label = "web" }: { url: string | null; label?: string }) {
  if (!url) return null;
  const href = url.startsWith("http") ? url : `https://${url}`;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      title={href}
      style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 4, cursor: "pointer",
        border: "1px solid #e7e5e4", color: "#78716c", textDecoration: "none",
        background: "#fff", whiteSpace: "nowrap" }}>
      {label}
    </a>
  );
}

export default function InvestorGrid() {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [bandFilter, setBandFilter] = useState<string[]>([]);
  const [ticket, setTicket] = useState("");
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
      if (typeFilter.length) {
        // Overlap, not equality — a fund that is both LBO and growth belongs in
        // an LBO filter. MISSING is its own selectable bucket for finding gaps.
        const untyped = !(r.fund_types || []).length;
        const wanted = typeFilter.filter((t) => t !== MISSING);
        const hit = (untyped && typeFilter.includes(MISSING))
          || (wanted.length > 0 && sharesType(r.fund_types, wanted));
        if (!hit) return false;
      }
      if (bandFilter.length && !overlapsBands(r, bandFilter)) return false;
      // An exact figure is a different question from a band — "who can write
      // £8m" rather than "who plays in the £5-20m bracket" — so it narrows
      // alongside the bands rather than replacing them.
      if (ticket) {
        const want = Number(ticket.replace(/\D/g, ""));
        if (want) {
          if (r.cheque_min == null && r.cheque_max == null) return false;
          const lo = Number(r.cheque_min ?? 0);
          const hi = Number(r.cheque_max ?? lo);
          if (want < lo || want > hi) return false;
        }
      }
      if (onlyGaps === "fund_type" && (r.fund_types || []).length) return false;
      if (onlyGaps === "cheque" && r.cheque_min != null) return false;
      if (onlyGaps === "geography" && (r.invest_geographies || []).length) return false;
      if (onlyGaps === "contact" && r.key_contact) return false;
      return true;
    });
  }, [rows, q, typeFilter, bandFilter, ticket, onlyGaps]);

  function toggleType(key: string) {
    setTypeFilter((p) => p.includes(key) ? p.filter((k) => k !== key) : [...p, key]);
  }

  const chip = (on: boolean) => ({
    padding: "5px 10px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
    border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
    background: on ? "#1c1917" : "#fff", color: on ? "#fff" : "#44403c",
  });

  const filterLabel = { fontSize: 12, color: "#78716c", width: 76,
    display: "inline-block" as const };

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

        {/* One filter per line, in the order an analyst narrows: who is it,
            what do they write, what do they back. */}
        <div style={{ marginBottom: 10 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…"
            style={{ padding: "8px 11px", border: "1px solid #d6d3d1", borderRadius: 6,
              fontSize: 14, width: 320 }} />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10,
          alignItems: "center" }}>
          <span style={{ ...filterLabel }}>Fund type</span>
          {ARDENT_FUND_TYPES.map(([key, name]) => (
            <button key={key} onClick={() => toggleType(key)} style={chip(typeFilter.includes(key))}>
              {name}
            </button>
          ))}
          <button onClick={() => toggleType(MISSING)} style={{
            ...chip(typeFilter.includes(MISSING)), fontStyle: "italic" }}>
            unclassified
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10,
          alignItems: "center" }}>
          <span style={{ ...filterLabel }}>Ticket size</span>
          {CHEQUE_BANDS.map(([key, name]) => (
            <button key={key} onClick={() => setBandFilter(
              bandFilter.includes(key) ? bandFilter.filter((b) => b !== key)
                                       : [...bandFilter, key])}
              style={chip(bandFilter.includes(key))}>
              {name}
            </button>
          ))}
          <span style={{ fontSize: 12, color: "#a8a29e" }}>or exactly</span>
          <input value={ticket ? Number(ticket.replace(/\D/g, "")).toLocaleString("en-GB") : ""}
            onChange={(e) => setTicket(e.target.value.replace(/\D/g, ""))}
            placeholder="£"
            style={{ width: 120, padding: "5px 9px", border: "1px solid #d6d3d1",
              borderRadius: 6, fontSize: 13 }} />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14,
          alignItems: "center" }}>
          <span style={{ ...filterLabel }}>Sector focus</span>
          <span style={{ fontSize: 12.5, color: "#a8a29e", fontStyle: "italic" }}>
            to be decided — the sector vocabulary needs settling before this can
            filter on anything meaningful
          </span>
        </div>

        {(typeFilter.length > 0 || bandFilter.length > 0 || q || ticket || onlyGaps) && (
          <button onClick={() => { setTypeFilter([]); setBandFilter([]); setQ("");
            setTicket(""); setOnlyGaps(null); }}
            style={{ ...chip(false), color: "#a8a29e", marginBottom: 12 }}>
            clear filters
          </button>
        )}

        {/* Stats as one line rather than a column. They are reference, not
            controls, and a 230px sidebar cost the table a fifth of the window
            for seven short facts. The gap figures still filter — click one. */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
          gap: 4, fontSize: 12.5, fontStyle: "italic", color: "#78716c",
          margin: "0 0 10px" }}>
          <span style={{ fontStyle: "normal", fontWeight: 600, color: "#57534e",
            marginRight: 4 }}>Bible stats</span>
          {([
            [null, `${data.total} funds`],
            ["fund_type", `${data.total - data.with_fund_type} no fund type`],
            ["cheque", `${data.total - data.with_cheque} no cheque size`],
            ["geography", `${data.total - data.with_geography} no geography`],
            ["contact", `${rows.filter((r) => !r.key_contact).length} no contact`],
            [null, `${data.defunct_count} defunct`],
            [null, `${data.duplicate_count} duplicate`],
          ] as [string | null, string][]).map(([key, text], i) => (
            <span key={text} style={{ display: "inline-flex", alignItems: "center" }}>
              {i > 0 && <span style={{ color: "#d6d3d1", margin: "0 6px" }}>·</span>}
              {key ? (
                <span onClick={() => setOnlyGaps(onlyGaps === key ? null : key)}
                  title="Click to show only these"
                  style={{ cursor: "pointer",
                    color: onlyGaps === key ? "#1c1917" : "#b45309",
                    fontWeight: onlyGaps === key ? 600 : 400,
                    textDecoration: "underline", textDecorationStyle: "dotted",
                    textDecorationColor: "#e7e5e4", textUnderlineOffset: 3 }}>
                  {text}
                </span>
              ) : <span>{text}</span>}
            </span>
          ))}
          <label style={{ marginLeft: 12, display: "inline-flex", gap: 5,
            alignItems: "center", cursor: "pointer", fontStyle: "normal" }}>
            <input type="checkbox" checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)} />
            show defunct and duplicate
          </label>
        </div>

        <p style={{ fontSize: 13, color: "#78716c", margin: "0 0 8px" }}>
          {filtered.length} shown
        </p>

        <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10,
          overflow: "auto", maxHeight: "74vh" }}>
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
                    {r.legal_name}{" "}
                    <WebLink url={r.website} />
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
                    {(r.fund_types || []).length
                      ? fundTypesLabel(r.fund_types) : <span style={gap}>—</span>}
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
      <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <a href={`/investor/${id}`} style={{ fontSize: 12.5, color: "#1c1917" }}>
          Open as its own page →
        </a>
        <WebLink url={record.website} />
      </span>

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
              {(f.options || GEOGRAPHIES).map(([v, l]) => {
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
