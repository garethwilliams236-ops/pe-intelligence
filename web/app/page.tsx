"use client";

import { useState } from "react";
import InvestorGrid from "./InvestorGrid";
import RankPanel from "./RankPanel";
import UpdatesPanel from "./UpdatesPanel";

// Three jobs. The Bible is the record; Updates is what a robot proposes adding
// to it and is the only way anything automated gets in; Rank is where the record
// gets used. The Bible opens first because the other two are worth nothing until
// it is right.
const TABS: [string, string][] = [
  ["investors", "Investor Bible"],
  ["updates", "Updates"],
  ["rank", "Rank a mandate"],
];

export default function Page() {
  const [tab, setTab] = useState("investors");

  return (
    <main style={{ maxWidth: 1560, margin: "0 auto", padding: "28px 24px 80px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 14px" }}>PE Intelligence</h1>

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e7e5e4",
        marginBottom: 20 }}>
        {TABS.map(([key, name]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: "9px 16px", fontSize: 14, cursor: "pointer", background: "none",
            border: "none", borderBottom: "2px solid " + (tab === key ? "#1c1917" : "transparent"),
            color: tab === key ? "#1c1917" : "#78716c",
            fontWeight: tab === key ? 600 : 400, marginBottom: -1 }}>
            {name}
          </button>
        ))}
      </div>

      {tab === "investors" ? <InvestorGrid />
        : tab === "updates" ? <UpdatesPanel />
        : <RankPanel />}
    </main>
  );
}
