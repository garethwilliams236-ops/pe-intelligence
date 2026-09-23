"use client";

import { useEffect, useRef, useState } from "react";

export type Option = { key: string; label: string; count?: number; italic?: boolean };

// A closed multi-choice dropdown, for filters whose vocabulary is long enough
// that a row of chips wraps onto three lines.
//
// The button carries the summary — "Fund type: LBO, VC" or "3 selected" — so a
// narrowed list says what narrowed it without the panel being open. A filter
// you cannot see the state of is a filter that quietly hides half the book.
//
// Counts sit beside each option because the most useful thing to know before
// ticking a box is whether it will return anything.
export default function MultiSelect({
  label, options, value, onChange, width = 210,
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else, and on Escape. Without the first, opening a
  // second dropdown leaves the first hanging over the table.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const chosen = options.filter((o) => value.includes(o.key));
  const summary = !chosen.length ? "Any"
    : chosen.length <= 2 ? chosen.map((o) => o.label).join(", ")
    : `${chosen.length} selected`;

  function toggle(key: string) {
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  }

  return (
    <div ref={box} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{
          width, textAlign: "left", padding: "6px 10px", borderRadius: 6,
          fontSize: 13, cursor: "pointer", background: "#fff",
          border: "1px solid " + (chosen.length ? "#1c1917" : "#d6d3d1"),
          color: chosen.length ? "#1c1917" : "#78716c",
          display: "flex", alignItems: "center", gap: 6,
        }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap" }}>
          {summary}
        </span>
        <span style={{ marginLeft: "auto", color: "#a8a29e", fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40,
          minWidth: width, maxHeight: 320, overflowY: "auto", background: "#fff",
          border: "1px solid #d6d3d1", borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,.10)", padding: 4,
        }}>
          {chosen.length > 0 && (
            <button type="button" onClick={() => onChange([])}
              style={{ display: "block", width: "100%", textAlign: "left",
                padding: "5px 8px", fontSize: 12, color: "#a8a29e", cursor: "pointer",
                border: "none", background: "none" }}>
              clear {label.toLowerCase()}
            </button>
          )}
          {options.map((o) => {
            const on = value.includes(o.key);
            return (
              <label key={o.key} style={{
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                padding: "6px 8px", borderRadius: 5, fontSize: 13,
                background: on ? "#f5f5f4" : "transparent",
                fontStyle: o.italic ? "italic" : "normal",
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(o.key)} />
                <span style={{ whiteSpace: "nowrap" }}>{o.label}</span>
                {o.count != null && (
                  <span style={{ marginLeft: "auto", paddingLeft: 12, fontSize: 11.5,
                    color: "#a8a29e" }}>
                    {o.count}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
