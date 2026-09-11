"use client";

import { useState } from "react";
import { ARDENT_FUND_TYPES, fundTypesLabel } from "@/lib/rank";

type Result = {
  company_id: string; legal_name: string; country_code: string | null;
  fund_types: string[]; invest_geographies: string[]; check_band: string | null;
  cheque_min: number | null; cheque_max: number | null; cheque_source: string | null;
  stated: number; revealed: number | null; holdings: number;
  grade: string | null; reasons: Record<string, string>;
};

// Shown on every row: 849 of 1,285 investors have no cheque range at all, and a
// fund scoring zero on size because we lack the data looks identical to one
// that genuinely cannot write the cheque unless the range is on the page.
function cheque(r: Result) {
  if (r.cheque_source === "ardent_band" && r.check_band) return r.check_band;
  if (r.cheque_min == null && r.cheque_max == null) return "cheque size unknown";
  const m = (v: number | null) => (v == null ? "?" : `${(Number(v) / 1e6).toFixed(0)}m`);
  return `${m(r.cheque_min)}–${m(r.cheque_max)}`;
}

// Money reads as digits in the box and as a magnitude underneath it. Both,
// because the failure this prevents is a wrong number of zeros — 800000000 and
// 80000000 look identical at a glance, and the second one silently ranks a
// different market.
function grouped(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits ? Number(digits).toLocaleString("en-GB") : "";
}

function magnitude(raw: string): string {
  const n = Number((raw || "").replace(/\D/g, ""));
  if (!n) return "";
  if (n >= 1e9) return `£${(n / 1e9).toFixed(n % 1e9 ? 2 : 0)}bn`;
  if (n >= 1e6) return `£${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}m`;
  if (n >= 1e3) return `£${(n / 1e3).toFixed(0)}k`;
  return `£${n}`;
}

const SIGNAL_LABEL: Record<string, string> = {
  sector_fit: "Sector", size_fit: "Cheque", deal_type_fit: "Fund type",
  geography_fit: "Geography", thesis_similarity: "Portfolio",
  recent_activity: "Activity",
};

export default function RankPanel() {
  const [form, setForm] = useState({
    sector: "Retail technology",
    country_code: "GB",
    expected_ev_gbp: "8000000",
    business_description:
      "Retail checkout technology; scan-and-go mobile self-checkout for grocery and convenience retailers; payments, computer vision, in-store shopper app",
  });
  const [fundTypes, setFundTypes] = useState<string[]>([]);
  const [top, setTop] = useState(50);
  const [hardGeo, setHardGeo] = useState(true);
  const [hardType, setHardType] = useState(true);
  const [hardSector, setHardSector] = useState(false);
  const [hardSize, setHardSize] = useState(false);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  function toggleType(key: string) {
    setFundTypes((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  }

  async function run() {
    setBusy(true);
    const hard = [...(hardGeo ? ["geography"] : []), ...(hardType ? ["fund_type"] : []),
      ...(hardSector ? ["sector"] : []), ...(hardSize ? ["size"] : [])];
    const res = await fetch("/api/rank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, fund_types: fundTypes, hard_filters: hard, top }),
    });
    setData(await res.json());
    setBusy(false);
  }

  async function grade(company_id: string, value: string | null) {
    await fetch("/api/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company_id,
        grade: value === "x" ? null : value,
        never_approach: value === "x",
      }),
    });
    run();
  }

  function csv() {
    const rows = (data?.results || []) as Result[];
    const head = ["Rank", "Investor", "Fund type", "Geographies", "Cheque",
      "Stated fit", "Evidence", "Holdings", "Grade", "Why"];
    const body = rows.map((r, i) => [
      i + 1, r.legal_name, fundTypesLabel(r.fund_types),
      (r.invest_geographies || []).join("/"), cheque(r), r.stated,
      r.revealed ?? "", r.holdings, r.grade || "",
      Object.entries(r.reasons).map(([k, v]) => `${SIGNAL_LABEL[k] || k}: ${v}`).join(" | "),
    ]);
    const text = [head, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `ics-${form.sector.replace(/\W+/g, "-").toLowerCase()}.csv`;
    a.click();
  }

  const field = { padding: "8px 10px", border: "1px solid #d6d3d1", borderRadius: 6,
    fontSize: 14, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
  const label = { fontSize: 12, color: "#57534e", display: "block", marginBottom: 4 };

  return (
    <div>
      <p style={{ color: "#78716c", fontSize: 14, margin: "0 0 20px" }}>
        Enter the mandate. Investors are scored on what they say about themselves and
        on who they have actually backed — never on whether they engaged before.
      </p>

      <section style={{ display: "grid", gap: 12, gridTemplateColumns: "2fr 1fr 1fr",
        background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10, padding: 16 }}>
        <div><label style={label}>Sector</label>
          <input style={field} value={form.sector}
            onChange={(e) => setForm({ ...form, sector: e.target.value })} /></div>
        <div><label style={label}>Country</label>
          <input style={field} value={form.country_code}
            onChange={(e) => setForm({ ...form, country_code: e.target.value.toUpperCase() })} /></div>
        <div><label style={label}>Size / raise (£)</label>
          <input style={field} inputMode="numeric" value={grouped(form.expected_ev_gbp)}
            onChange={(e) => setForm({
              ...form,
              // Store digits, show groups. Keeping the commas in state would
              // send "8,000,000" to the API, where Number() makes it NaN.
              expected_ev_gbp: e.target.value.replace(/\D/g, ""),
            })} />
          <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 3, minHeight: 14 }}>
            {magnitude(form.expected_ev_gbp)}
          </div></div>

        <div style={{ gridColumn: "1 / -1" }}>
          <label style={label}>
            Fund type — Ardent&rsquo;s categories. Select none to leave it open.
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ARDENT_FUND_TYPES.map(([key, name]) => {
              const on = fundTypes.includes(key);
              return (
                <button key={key} onClick={() => toggleType(key)} style={{
                  padding: "6px 11px", borderRadius: 999, fontSize: 13, cursor: "pointer",
                  border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
                  background: on ? "#1c1917" : "#fff", color: on ? "#fff" : "#44403c" }}>
                  {name}
                </button>
              );
            })}
            {fundTypes.length > 0 && (
              <button onClick={() => setFundTypes([])} style={{
                padding: "6px 11px", borderRadius: 999, fontSize: 13, cursor: "pointer",
                border: "1px solid #e7e5e4", background: "#fff", color: "#a8a29e" }}>
                clear
              </button>
            )}
          </div>
        </div>

        <div style={{ gridColumn: "1 / -1" }}><label style={label}>Business description</label>
          <textarea style={{ ...field, minHeight: 64 }} value={form.business_description}
            onChange={(e) => setForm({ ...form, business_description: e.target.value })} /></div>

        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 16, alignItems: "center",
          flexWrap: "wrap" }}>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={hardGeo} onChange={(e) => setHardGeo(e.target.checked)} />
            {" "}Country is absolute
          </label>
          <label style={{ fontSize: 13 }} title="Excludes funds whose Ardent fund type is not one you selected. Funds with no fund type on file are kept — that is a gap in our data, not a mismatch.">
            <input type="checkbox" checked={hardType} onChange={(e) => setHardType(e.target.checked)} />
            {" "}Fund type is absolute
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={hardSector} onChange={(e) => setHardSector(e.target.checked)} />
            {" "}Sector is absolute
          </label>
          <label style={{ fontSize: 13 }} title="Excludes funds whose stated cheque range cannot cover the mandate. Funds with no cheque range on file are kept — that is a gap in our data, not a mismatch.">
            <input type="checkbox" checked={hardSize} onChange={(e) => setHardSize(e.target.checked)} />
            {" "}Cheque size is absolute
          </label>
          <label style={{ fontSize: 13, marginLeft: "auto" }}>
            Show top{" "}
            <input type="number" min={5} max={300} step={5} value={top}
              onChange={(e) => setTop(Number(e.target.value) || 50)}
              style={{ width: 62, padding: "5px 7px", border: "1px solid #d6d3d1",
                borderRadius: 5, fontSize: 13 }} />
          </label>
          <button onClick={run} disabled={busy} style={{
            padding: "9px 18px", borderRadius: 6, border: "none", background: "#1c1917",
            color: "#fff", fontSize: 14, cursor: "pointer" }}>
            {busy ? "Ranking…" : "Rank investors"}
          </button>
          {data && <button onClick={csv} style={{ padding: "9px 14px", borderRadius: 6,
            border: "1px solid #d6d3d1", background: "#fff", fontSize: 14, cursor: "pointer" }}>
            Export ICS
          </button>}
        </div>
      </section>

      {data?.error && <p style={{ color: "#b91c1c", marginTop: 20 }}>{data.error}</p>}

      {data?.results && (
        <>
          <p style={{ fontSize: 13, color: "#78716c", margin: "20px 0 8px" }}>
            {data.considered} in the universe · <strong>{data.qualified}</strong> qualified ·{" "}
            {data.results.length} shown · of those shown,{" "}
            <strong>{data.with_fund_type}</strong> have a fund type,{" "}
            <strong>{data.with_cheque}</strong> a cheque range,{" "}
            <strong>{data.with_evidence}</strong> portfolio evidence
            {Object.keys(data.excluded || {}).length > 0 && (
              <> · excluded: {Object.entries(data.excluded)
                .map(([k, v]) => `${v} ${k}`).join(", ")}</>
            )}
          </p>

          {data.results.map((r: Result, i: number) => (
            <div key={r.company_id} style={{ background: "#fff", border: "1px solid #e7e5e4",
              borderRadius: 10, padding: "12px 16px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ color: "#a8a29e", fontSize: 13, width: 22 }}>{i + 1}</span>
                <strong style={{ fontSize: 15 }}>{r.legal_name}</strong>
                <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4,
                  background: (r.fund_types || []).length ? "#f5f5f4" : "#fffbeb",
                  color: (r.fund_types || []).length ? "#57534e" : "#b45309" }}>
                  {fundTypesLabel(r.fund_types) || "fund type?"}
                </span>
                <span style={{ fontSize: 11, color: (r.invest_geographies || []).length ? "#a8a29e" : "#b45309" }}>
                  {(r.invest_geographies || []).length
                    ? r.invest_geographies.join("/") : "geography?"}
                </span>
                <span style={{ fontSize: 11, color: r.cheque_min == null ? "#b45309" : "#a8a29e" }}>
                  {cheque(r)}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 13, color: "#57534e" }}>
                  fit <strong>{r.stated.toFixed(2)}</strong>
                  {r.revealed !== null
                    ? <> · evidence <strong>{r.revealed.toFixed(2)}</strong> ({r.holdings})</>
                    : <span style={{ color: "#a8a29e" }}> · no portfolio data</span>}
                </span>
                <span style={{ display: "flex", gap: 3 }}>
                  {["a", "b", "c", "d", "x"].map((g) => (
                    <button key={g} onClick={() => grade(r.company_id, g)}
                      title={g === "x" ? "Never approach" : `Grade ${g.toUpperCase()}`}
                      style={{ width: 24, height: 24, fontSize: 11, borderRadius: 4, cursor: "pointer",
                        border: "1px solid " + (r.grade === g ? "#1c1917" : "#e7e5e4"),
                        background: r.grade === g ? "#1c1917" : "#fff",
                        color: r.grade === g ? "#fff" : g === "x" ? "#b91c1c" : "#57534e" }}>
                      {g.toUpperCase()}
                    </button>
                  ))}
                </span>
              </div>
              <div style={{ marginTop: 6, marginLeft: 32, fontSize: 13, color: "#44403c" }}>
                {Object.entries(r.reasons).map(([k, v]) => (
                  <div key={k}>
                    <span style={{ color: "#a8a29e", display: "inline-block", width: 74 }}>
                      {SIGNAL_LABEL[k] || k}
                    </span>
                    {v}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
