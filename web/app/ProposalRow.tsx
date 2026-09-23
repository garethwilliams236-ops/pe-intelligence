"use client";

import { useState } from "react";
import { ARDENT_FUND_TYPES, fundTypesLabel } from "@/lib/rank";
import { CHEQUE_BANDS } from "@/lib/fields";

// One scraped proposal, with accept / amend / reject.
//
// Lifted out of UpdatesPanel so the review queue and the fund page's own
// "Refresh now" use the same implementation. Two copies of this would drift,
// and the half that drifts is the amend rules — which are the half that stops
// a bad value reaching the Bible.

export type Proposal = {
  id: string; company_id: string; legal_name: string; website: string | null;
  field: string; current_value: string | null; proposed_value: string | null;
  confidence: number; evidence_url: string | null; evidence_snippet: string | null;
  created_at: string;
};

export const FIELD_LABEL: Record<string, string> = {
  address_line: "Address", postcode: "Postcode", city: "City", phone: "Switchboard",
  website: "Website", description: "Description", fund_types: "Fund type",
  contact: "Contact",
};

// Fields with a closed vocabulary amend through a dropdown, never a text box.
// Typing a fund type by hand can produce a value the enum will refuse — the
// write fails, and the queue keeps the proposal pending as though nothing
// happened. The Bible only holds these nine, so only these nine are offerable.
const OPTIONS: Record<string, [string, string][]> = {
  fund_types: ARDENT_FUND_TYPES,
  check_band: CHEQUE_BANDS,
};

// Set-valued fields amend by toggling, not by picking one. A fund can be an LBO
// house and a growth investor, and the scraper only ever proposes one of them —
// so accepting must add to what is there rather than replace it, and amending
// has to let you say the whole set.
const MULTI = new Set(["fund_types"]);

export function show(field: string, value: string | null) {
  if (value == null || value === "") return "—";
  if (MULTI.has(field)) return fundTypesLabel(value.split(",").filter(Boolean));
  // A contact is stored as "Name|email" because the proposals table holds one
  // text column per field; it should not read that way on the page.
  if (field === "contact") {
    const [name, email] = value.split("|");
    return name ? `${name} — ${email}` : email;
  }
  return value;
}

const btn = { padding: "4px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
  border: "1px solid #d6d3d1", background: "#fff", color: "#44403c" };

export default function ProposalRow({ p, onDecided }:
  { p: Proposal; onDecided: () => void }) {
  const [amending, setAmending] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: string, value?: string) {
    setBusy(true); setError(null);
    const res = await fetch("/api/proposals", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: p.id, action, value }),
    });
    const out = await res.json();
    setBusy(false);
    if (out.error) return setError(out.error);
    setAmending(undefined);
    onDecided();
  }

  // Amending a set starts from current ∪ proposed, so the common case — "yes,
  // and it is also this" — is already filled in and you untick rather than
  // retype.
  function startAmend() {
    setAmending(MULTI.has(p.field)
      ? [...new Set([
          ...(p.current_value || "").split(",").filter(Boolean),
          ...(p.proposed_value || "").split(",").filter(Boolean),
        ])].join(",")
      : p.proposed_value || "");
  }

  return (
    <div style={{ padding: "10px 0", borderTop: "1px solid #f5f5f4" }}>
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
          {amending !== undefined ? (
            MULTI.has(p.field) ? (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                {(OPTIONS[p.field] || []).map(([v, l]) => {
                  const chosen = amending.split(",").filter(Boolean);
                  const on = chosen.includes(v);
                  return (
                    <button key={v} onClick={() => setAmending(
                      (on ? chosen.filter((c) => c !== v) : [...chosen, v]).join(","))}
                      style={{
                        padding: "4px 9px", borderRadius: 999, fontSize: 12,
                        cursor: "pointer",
                        border: "1px solid " + (on ? "#1c1917" : "#e7e5e4"),
                        background: on ? "#1c1917" : "#fff",
                        color: on ? "#fff" : "#44403c" }}>
                      {l}
                    </button>
                  );
                })}
              </div>
            ) : OPTIONS[p.field] ? (
              <select autoFocus value={amending}
                onChange={(e) => setAmending(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", fontSize: 13.5,
                  border: "1px solid #1c1917", borderRadius: 6, marginTop: 3,
                  background: "#fff" }}>
                <option value="">— clear it —</option>
                {OPTIONS[p.field].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            ) : (
              <input autoFocus value={amending}
                onChange={(e) => setAmending(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", fontSize: 13.5,
                  border: "1px solid #1c1917", borderRadius: 6, marginTop: 3 }} />
            )
          ) : (
            <div style={{ fontSize: 14, marginTop: 2 }}>
              {show(p.field, p.proposed_value)}
            </div>
          )}
          {p.evidence_snippet && (
            <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 4 }}>
              &ldquo;{p.evidence_snippet}&rdquo;
              {p.evidence_url && (
                <> · <a href={p.evidence_url} target="_blank" rel="noreferrer"
                  style={{ color: "#78716c" }}>source</a></>
              )}
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 4 }}>{error}</div>
          )}
        </div>

        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
          {amending !== undefined ? (
            <>
              <button style={{ ...btn, borderColor: "#1c1917" }} disabled={busy}
                onClick={() => decide("amend", amending)}>
                Save
              </button>
              <button style={btn} onClick={() => setAmending(undefined)}>Cancel</button>
            </>
          ) : (
            <>
              <button style={{ ...btn, borderColor: "#1c1917" }} disabled={busy}
                onClick={() => decide("accept")}>
                Accept
              </button>
              <button style={btn} disabled={busy} onClick={startAmend}>Amend</button>
              <button style={{ ...btn, color: "#b91c1c" }} disabled={busy}
                onClick={() => decide("reject")}>
                Reject
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
