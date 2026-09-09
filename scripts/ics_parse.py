"""Read Ardent Investor Control Sheets.

The ICS is the document PE Intelligence exists to automate: it takes the master
investor list and records which investors were judged relevant for one client,
then tracks how far each got. That makes it both the ground truth for a ranking
and the shape of the product's own output.

Layout notes, learned from the template and from Monument, MishiPay and Truffle:

  * A status legend sits in columns E/F somewhere in the first dozen rows.
  * A header row follows, starting at column B with "No.", the investor name in
    C and "Status" in D. Its row number moves between files (11, 12, 13 seen).
  * The funnel columns after that are stable in name, not in position.
  * Columns past ~Q are client-specific: Tier, Tranche, Location, per-client
    comments.
  * A workbook may hold more than one control-sheet tab.

The important trap: **the codes are not stable across files**. "A" is
"Appraising - Pre DD" in Monument and "Contacted" in MishiPay; "I" is
"Reviewing Internally" in one and "Received IM" in another. So the legend is
read per file and mapped to a canonical stage here, never assumed.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys
from collections import Counter, defaultdict

import openpyxl

ROOT = "/mnt/c/Users/gwill/Ardent Advisors"

# Canonical funnel. The ordinal is what a ranking can be scored against: an
# investor who reached management discussion is stronger evidence of fit than
# one who never replied, and a pass is evidence against.
STAGES = {
    "contacted": 1,
    "reviewing": 2,
    "qualified": 3,
    "engaged": 4,
    "management": 5,
    "offer": 6,
    "passed": 0,
    "on_hold": 0,
    "no_response": 0,
    "not_approved": 0,
}

# Matched against the legend *label* in the file, longest phrase first so
# "management discussion" wins over "discussion".
LABEL_TO_STAGE = [
    (r"final offer|offer made|initial offer|first offer", "offer"),
    (r"management discussion|management discuss|mang\.? m(ee)?t|"
     r"management p[er]s[e]?[nt]tation|mgt pres", "management"),
    (r"product demonstration|demo", "management"),
    (r"discussions? with ardent|engaged|due diligence", "engaged"),
    (r"qualified", "qualified"),
    (r"reviewing internally|received im|reviewing|appraising", "reviewing"),
    (r"contacted|approach|initial contact|active", "contacted"),
    (r"priority approved|approved", "qualified"),
    (r"not approved|declined", "not_approved"),
    (r"on hold", "on_hold"),
    (r"no response|senescent|lapsed|dormant", "no_response"),
    (r"pass", "passed"),
]

NAME_HEADERS = {"investors", "investor", "acquiror", "acquirors", "name", "company"}
FUNNEL_HEADERS = {
    "initial email", "initial call / meeting", "initial call/meeting", "exec sum",
    "mgt pres", "nda", "im", "model", "first offer", "final offer",
    "process letter", "mang. mtg", "final offer instuctions", "last contact",
}


def _clean(value) -> str:
    return re.sub(r"\s+", " ", str(value)).strip() if value is not None else ""


def read_legend(ws, before_row: int) -> dict[str, str]:
    """Code -> label, from the block above the table.

    `before_row` is the header row, and the bound matters: the legend is a label
    with its code in the next cell along, which is also the shape of a data row
    (investor name, then status). Searching the whole top of the sheet read
    "83 North" as the label for code P on sheets whose table starts at row 5.
    The legend always sits above the header, so that is the only place to look.
    """
    legend = {}
    for row in ws.iter_rows(min_row=1, max_row=max(1, before_row - 1),
                            max_col=12, values_only=True):
        for i in range(len(row) - 1):
            label, code = _clean(row[i]), _clean(row[i + 1])
            if label and code and len(code) <= 3 and code.isalpha() and len(label) > 3:
                legend.setdefault(code.upper(), label)
    return legend


def stage_for(label: str) -> str | None:
    low = label.lower()
    for pattern, stage in LABEL_TO_STAGE:
        if re.search(pattern, low):
            return stage
    return None


def find_header(ws) -> tuple[int, dict[str, int]] | None:
    """Locate the header row by content and map header text -> column index."""
    for i, row in enumerate(ws.iter_rows(min_row=1, max_row=25, max_col=40, values_only=True), 1):
        cells = {j: _clean(c).lower() for j, c in enumerate(row, 1) if _clean(c)}
        if "status" not in cells.values():
            continue
        if not (NAME_HEADERS & set(cells.values())):
            continue
        return i, {v: j for j, v in cells.items()}
    return None


def control_sheets(wb):
    """Every control-sheet tab, fullest first — a workbook can hold several."""
    skip = ("raw", "history", "process", "summary", "deliverable", "chase", "bounce")
    named = [s for s in wb.sheetnames
             if "control sheet" in s.lower() and not any(k in s.lower() for k in skip)]
    if named:
        return sorted(named, key=lambda t: -(wb[t].max_row or 0))
    # Gorgeous Shop III carries the whole template tab set with no tab actually
    # called "Control Sheet", so fall back to any tab that yields a header row.
    other = [s for s in wb.sheetnames if not any(k in s.lower() for k in skip)]
    return sorted(other, key=lambda t: -(wb[t].max_row or 0))[:4]


def parse(path: str) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    tabs = control_sheets(wb)
    if not tabs:
        return {"path": path, "error": f"no control sheet tab (tabs: {wb.sheetnames[:5]})"}

    ws = wb[tabs[0]]
    header = find_header(ws)
    if not header:
        return {"path": path, "tab": tabs[0], "legend": {}, "error": "no header row found"}

    header_row, columns = header
    legend = read_legend(ws, header_row)
    name_col = next((columns[h] for h in columns if h in NAME_HEADERS), None)
    status_col = columns.get("status")
    type_col = columns.get("type")
    if not name_col or not status_col:
        return {"path": path, "tab": tabs[0], "error": "no name or status column"}

    rows, blanks = [], 0
    for row in ws.iter_rows(min_row=header_row + 1, max_col=max(columns.values()), values_only=True):
        name = _clean(row[name_col - 1]) if len(row) >= name_col else ""
        if not name:
            blanks += 1
            if blanks > 15:      # trailing empties, not a gap mid-list
                break
            continue
        blanks = 0
        code = _clean(row[status_col - 1]).upper() if len(row) >= status_col else ""
        label = legend.get(code, "")
        rows.append({
            "name": name,
            "code": code,
            "label": label,
            "stage": stage_for(label) if label else None,
            "type": _clean(row[type_col - 1]) if type_col and len(row) >= type_col else "",
        })

    return {"path": path, "tab": tabs[0], "tabs": len(tabs), "header_row": header_row,
            "legend": legend, "columns": sorted(columns), "rows": rows}


def discover() -> dict[str, list[str]]:
    """Candidate ICS files per client, newest first, across both client trees.

    Returns every candidate rather than one guess. Modification time on a
    OneDrive-synced folder says when a file was last touched by sync, not which
    file is the substantive one — AppyWay has ~50 control sheets and picking the
    newest mtime returned one with 3 rows in it. The caller tries candidates in
    order until one actually parses.

    Filename dates are no better a guide: they appear as "Dec 2019", "01 05 20",
    "21 08 03" and "13 July 2020" across the corpus.
    """
    found = defaultdict(list)
    for path in glob.glob(os.path.join(ROOT, "*Clients - Documents/*/**/*.xls*"), recursive=True):
        low = path.lower()
        if "/distribution" not in low or "~$" in low:
            continue
        if any(skip in low for skip in ("xold", "template")):
            continue
        if "control sheet" not in low and " ics" not in low and "/ics" not in low:
            continue
        client = path.split("Documents/")[1].split("/")[0]
        found[client].append(path)

    def rank(path: str):
        # Prefer a live file over an archived copy, then most recently touched.
        archived = any(a in path.lower() for a in ("/archive", "/.archive", "/old "))
        return (archived, -os.path.getmtime(path))

    return {c: sorted(ps, key=rank) for c, ps in found.items()}


def best_parse(candidates: list[str], min_rows: int = 5) -> tuple[dict, int]:
    """Best candidate, not merely the first that parses. Returns (result, tried).

    Two changes learned from the first survey. A sheet with no legend block is
    still worth keeping — Houzecheck has 264 rows and no legend, and discarding
    it lost more data than any other single decision. And taking the first
    passing file settled for a 33-row sheet at AppyWay, which has 87 candidates.

    So every candidate is scored on (has a legend, number of rows) and the best
    wins, stopping early once one is clearly good enough to save opening the
    rest — these are large workbooks pulled down from OneDrive.
    """
    best, best_key, last = None, (-1, -1), {"error": "no candidates"}
    tried = 0
    for path in candidates[:8]:
        tried += 1
        if path.lower().endswith(".xls"):
            last = {"path": path, "error": "legacy .xls (needs xlrd or conversion)"}
            continue
        try:
            result = parse(path)
        except Exception as exc:
            name = type(exc).__name__
            last = {"path": path, "error":
                    "legacy .xls saved under an .xlsx name" if name == "BadZipFile" else name}
            continue
        if "error" in result:
            last = result
            continue

        key = (1 if result["legend"] else 0, len(result["rows"]))
        if key > best_key:
            best, best_key = result, key
        if result["legend"] and len(result["rows"]) >= 20:
            break                      # clearly the real thing; stop opening files

    if best and len(best["rows"]) >= min_rows:
        return best, tried
    if best:
        last = {"path": best["path"], "error": f"thin ({len(best['rows'])} rows)"}
    return last, tried


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--path", help="parse one file instead of surveying")
    args = ap.parse_args()

    if args.path:
        targets = {"(single)": [args.path]}
    else:
        targets = discover()
        print(f"{len(targets)} clients with candidate ICS files\n")

    items = sorted(targets.items())
    if args.limit:
        items = items[:args.limit]

    totals, unmapped, rejects = Counter(), Counter(), []
    for client, candidates in items:
        result, tried = best_parse(candidates)
        if "error" in result:
            print(f"{client[:24]:24s} -- {result['error']}  (tried {tried} of {len(candidates)})")
            rejects.append((client, result["error"]))
            totals["failed"] += 1
            continue

        rows = result["rows"]
        staged = [r for r in rows if r["stage"]]
        for r in rows:
            if r["code"] and not r["stage"]:
                unmapped[(r["code"], r["label"])] += 1
        types = Counter(r["type"] for r in rows if r["type"])
        totals["clients"] += 1
        totals["rows"] += len(rows)
        totals["staged"] += len(staged)
        deep = sum(1 for r in staged if STAGES.get(r["stage"], 0) >= 4)
        print(f"{client[:24]:24s} rows={len(rows):4d} staged={len(staged):4d} "
              f"engaged+={deep:3d} hdr={result['header_row']:2d} "
              f"{dict(types.most_common(2)) if types else ''}")

    print(f"\n{totals['clients']} parsed, {totals['failed']} unusable, "
          f"{totals['rows']} rows, {totals['staged']} with a mapped stage")
    if unmapped:
        print("\nstatus codes with no canonical stage:")
        for (code, label), n in unmapped.most_common(15):
            shown = label[:44] or "(code not in that file's legend)"
            print(f"  {code:4s} {shown:44s} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
