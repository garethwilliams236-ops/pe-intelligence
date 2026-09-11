"use client";

import { useState } from "react";
import { ARDENT_FUND_TYPES } from "@/lib/rank";
import { CHEQUE_BANDS, GEOGRAPHIES } from "@/lib/fields";

// Adding a fund by hand. Same vocabulary as everywhere else — fund types and
// cheque bands are chosen, never typed — so a hand-entered fund is filterable
// and rankable from the moment it is saved rather than being a row that looks
// right and matches nothing.
export default function AddFundPanel({ onAdded }: { onAdded?: () => void }) {
  const blank = {
    legal_name: "", website: "", country_code: "GB", city: "", address_line: "",
    postcode: "", phone: "", ardent_sector: "", check_band: "", priority: "",
    key_investments: "", description: "",
    contact_name: "", contact_title: "", contact_email: "",
  };
  const [form, setForm] = useState(blank);
  const [fundTypes, setFundTypes] = useState<string[]>([]);
  const [geos, setGeos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupes, setDupes] = useState<{ id: string; legal_name: string }[] | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save(force: boolean) {
    setBusy(true); setError(null);
    const res = await fetch("/api/investors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form, fund_types: fundTypes, invest_geographies: geos, force,
      }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error === "possible_duplicate") return setDupes(out.candidates);
    if (out.error) return setError(out.error);
    setDone(out.company_id);
    setForm(blank); setFundTypes([]); setGeos([]); setDupes(null);
    onAdded?.();
  }

  const field = { padding: "8px 10px", border: "1px solid #d6d3d1", borderRadius: 6,
    fontSize: 14, width: "100%", boxSizing: "border-box" as const, background: "#fff" };
  const label = { fontSize: 12, color: "#57534e", display: "block", marginBottom: 4 };
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const chips = (all: [string, string][], chosen: string[], toggle: (v: string) => void) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {all.map(([v, l]) => {
        const on = chosen.includes(v);
        return (
          <button key={v} type="button" onClick={() => toggle(v)} style={{
            padding: "6px 11px", borderRadius: 999, fontSize: 13, cursor: "pointer",
            border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
            background: on ? "#1c1917" : "#fff", color: on ? "#fff" : "#44403c" }}>
            {l}
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ color: "#78716c", fontSize: 14, margin: "0 0 18px" }}>
        For a fund that isn&rsquo;t in the book yet. Only the name is required — everything
        else can be filled in later from the record, and the nightly refresh will
        propose what it can read off the website.
      </p>

      {done && (
        <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10,
          padding: 14, marginBottom: 16, fontSize: 13.5 }}>
          Added. <a href={`/investor/${done}`} style={{ color: "#1c1917" }}>
            Open the fund page →
          </a>
        </div>
      )}

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "2fr 1fr",
        background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10, padding: 16 }}>
        <div><label style={label}>Fund name *</label>
          <input style={field} value={form.legal_name} onChange={set("legal_name")}
            placeholder="e.g. Livingbridge" /></div>
        <div><label style={label}>Website</label>
          <input style={field} value={form.website} onChange={set("website")}
            placeholder="livingbridge.com" /></div>

        <div style={{ gridColumn: "1 / -1" }}>
          <label style={label}>Fund type — one or more</label>
          {chips(ARDENT_FUND_TYPES, fundTypes, (v) =>
            setFundTypes(fundTypes.includes(v)
              ? fundTypes.filter((x) => x !== v) : [...fundTypes, v]))}
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <label style={label}>Invests in</label>
          {chips(GEOGRAPHIES, geos, (v) =>
            setGeos(geos.includes(v) ? geos.filter((x) => x !== v) : [...geos, v]))}
        </div>

        <div><label style={label}>Sector</label>
          <input style={field} value={form.ardent_sector} onChange={set("ardent_sector")} /></div>
        <div><label style={label}>Cheque band</label>
          <select style={field} value={form.check_band} onChange={set("check_band")}>
            <option value="">— not set —</option>
            {CHEQUE_BANDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>

        <div><label style={label}>Address</label>
          <input style={field} value={form.address_line} onChange={set("address_line")} /></div>
        <div><label style={label}>Postcode</label>
          <input style={field} value={form.postcode} onChange={set("postcode")} /></div>
        <div><label style={label}>City</label>
          <input style={field} value={form.city} onChange={set("city")} /></div>
        <div><label style={label}>Country</label>
          <input style={field} value={form.country_code}
            onChange={(e) => setForm({ ...form, country_code: e.target.value.toUpperCase() })} /></div>
        <div><label style={label}>Switchboard</label>
          <input style={field} value={form.phone} onChange={set("phone")} /></div>
        <div><label style={label}>Priority</label>
          <input style={field} value={form.priority} onChange={set("priority")} /></div>

        <div style={{ gridColumn: "1 / -1", borderTop: "1px solid #f5f5f4", paddingTop: 12 }}>
          <div style={{ ...label, fontWeight: 600, marginBottom: 8 }}>Key contact</div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr" }}>
            <input style={field} value={form.contact_name} onChange={set("contact_name")}
              placeholder="Name" />
            <input style={field} value={form.contact_title} onChange={set("contact_title")}
              placeholder="Title" />
            <input style={field} value={form.contact_email} onChange={set("contact_email")}
              placeholder="Email" />
          </div>
        </div>

        <div style={{ gridColumn: "1 / -1" }}><label style={label}>Key investments</label>
          <textarea style={{ ...field, minHeight: 56 }} value={form.key_investments}
            onChange={set("key_investments")} /></div>

        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => save(false)} disabled={busy || !form.legal_name.trim()}
            style={{ padding: "9px 18px", borderRadius: 6, border: "none", fontSize: 14,
              background: form.legal_name.trim() ? "#1c1917" : "#e7e5e4",
              color: form.legal_name.trim() ? "#fff" : "#a8a29e",
              cursor: form.legal_name.trim() ? "pointer" : "default" }}>
            {busy ? "Saving…" : "Add to the Bible"}
          </button>
          {error && <span style={{ color: "#b91c1c", fontSize: 13 }}>{error}</span>}
        </div>
      </div>

      {/* The duplicate gate. Shown rather than hidden behind a confirm dialog,
          because the useful outcome is usually "open the one that exists", not
          "add it anyway". */}
      {dupes && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10,
          padding: 16, marginTop: 14 }}>
          <strong style={{ fontSize: 14 }}>Already in the book, or close to it</strong>
          <div style={{ fontSize: 13, color: "#57534e", margin: "6px 0 10px" }}>
            Adding a second row for the same house is how the book ended up with
            Carlyle three times. Check these first.
          </div>
          {dupes.map((d) => (
            <div key={d.id} style={{ fontSize: 13.5, padding: "3px 0" }}>
              <a href={`/investor/${d.id}`} style={{ color: "#1c1917" }}>{d.legal_name}</a>
            </div>
          ))}
          <button onClick={() => save(true)} disabled={busy} style={{
            marginTop: 10, padding: "7px 14px", borderRadius: 6, fontSize: 13,
            border: "1px solid #d6d3d1", background: "#fff", cursor: "pointer" }}>
            None of these — add it anyway
          </button>
        </div>
      )}
    </div>
  );
}
