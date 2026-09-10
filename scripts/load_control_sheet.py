"""Load the Investor Control Sheet — the master record WP2 missed.

WP2 read four tabs of the master workbook and never opened this one, which is
why the ranking has been working from HQ country instead of investment
geography, from Crunchbase categories instead of Ardent's own sector
vocabulary, and with no fund type at all.

This MERGES rather than replaces. The sheet has 991 named investors against the
1,285 already loaded from other tabs, so it is a better-curated core, not a
superset. Where it states a value it wins, because it is maintained by hand for
exactly this purpose; where it is silent the existing value stands.

One field deliberately does NOT win: the cheque band. The sheet fills 228 of
them as bands (£5-20m); `InvestorBase Data` already gave 413 as numeric ranges.
The band is recorded for display, and the numeric range is left as the thing
size filtering uses.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import openpyxl                       # noqa: E402
from crawler import db                # noqa: E402

WORKBOOK = ("/mnt/c/Users/gwill/Ardent Advisors/Operations and Marketing - Documents/"
            "Investors/Salesforce Master Investor List/"
            "Master Investor List GW Version - 26 2 09.xlsx")
TAB = "Investor Control Sheet"
HEADER_ROW = 12

FUND_TYPE = {
    "VC": "vc", "VCT": "vct", "MBO": "mbo", "LBO": "lbo", "LP": "lp",
    "FO": "family_office", "HNW": "hnw", "AM": "multi_strategy_am",
    "CSO": "corp_strategy_office",
}

# The sheet's geography codes are compound: NA-UK means the fund invests in
# North America AND the UK. Treating "NA-UK" as a single opaque value would
# hide 291 investors from every UK mandate.
GEOGRAPHY = {
    "UK": ["UK"], "EU": ["EU"], "ASIA": ["ASIA"],
    "EU-UK": ["EU", "UK"], "NA-UK": ["NA", "UK"], "ASIA-UK": ["ASIA", "UK"],
    "NA": ["NA"], "US": ["NA"], "GLOBAL": ["UK", "EU", "NA", "ASIA"],
}

COLUMNS = {          # 1-indexed, from the sheet's own header row
    "name": 2, "record_type": 3, "type": 4, "last_audited": 5, "fund_type": 6,
    "contact": 7, "email": 8, "engagement": 11, "office": 12, "quality": 14,
    "geography": 15, "sector": 16, "check_band": 17, "key_investments": 24,
    "comments": 25, "priority": 26,
}


def clean(value) -> str:
    return re.sub(r"\s+", " ", str(value)).strip() if value not in (None, "") else ""


def rows_from_sheet() -> list[dict]:
    wb = openpyxl.load_workbook(WORKBOOK, read_only=True, data_only=True)
    ws = wb[TAB]
    out = []
    for row in ws.iter_rows(min_row=HEADER_ROW + 1, max_col=27, values_only=True):
        name = clean(row[COLUMNS["name"] - 1])
        if not name:
            continue
        rec = {k: clean(row[i - 1]) for k, i in COLUMNS.items()}
        rec["name"] = name
        raw = row[COLUMNS["last_audited"] - 1]
        rec["last_audited"] = raw.date().isoformat() if hasattr(raw, "date") else None
        out.append(rec)
    return out


def geographies(code: str) -> list[str]:
    key = code.upper().replace(" ", "")
    if key in GEOGRAPHY:
        return GEOGRAPHY[key]
    # Unrecognised compound like "NA-EU-UK": split and keep the parts we know.
    parts = [p for p in re.split(r"[-/,]", key) if p in GEOGRAPHY]
    seen: list[str] = []
    for p in parts:
        for g in GEOGRAPHY[p]:
            if g not in seen:
                seen.append(g)
    return seen


def resolve(conn, name: str) -> str | None:
    """Match against the existing universe. Exact normalised name first, then a
    single leading-token candidate — the same rule promotion and Companies House
    use. Anything ambiguous returns nothing rather than writing to the wrong fund.

    The exact match gets a query of its own, and neither query carries a LIMIT.
    Folded into one statement with a trigram arm and `limit 8`, the exact row was
    being truncated away before Python ever saw it: "Activa Capital" is a trigram
    neighbour of 217 other funds, because almost every fund in the book is
    "<something> Capital". Postgres returned eight arbitrary near-misses. That one
    line lost 568 of 991 control-sheet rows.

    The fallback matches on the first token rather than by similarity. It is a
    plain equality test, so there is no threshold to tune and no LIKE
    metacharacter to escape, and containment is then checked in Python.
    """
    exact = db.all_rows(
        conn,
        """
        select i.company_id
        from public.investors i join public.companies c on c.id = i.company_id
        where public.normalise_name(c.legal_name) = public.normalise_name(%s)
        """,
        (name,),
    )
    if len(exact) == 1:
        return exact[0]["company_id"]
    if exact:
        return None          # fragmented entity — needs a merge, not a coin toss

    want = db.scalar(conn, "select public.normalise_name(%s)", (name,)) or ""
    tokens = want.split()
    if not tokens:
        return None
    rows = db.all_rows(
        conn,
        """
        select i.company_id, public.normalise_name(c.legal_name) as norm
        from public.investors i join public.companies c on c.id = i.company_id
        where split_part(public.normalise_name(c.legal_name), ' ', 1) = %s
        """,
        (tokens[0],),
    )
    leads = [r for r in rows if r["norm"].split()[:len(tokens)] == tokens]
    return leads[0]["company_id"] if len(leads) == 1 else None


def apply_field(conn, company_id, field: str, value, stats: Counter) -> None:
    """Set a field and record what it was. The import is auditable like any
    analyst edit — an override with no trail is indistinguishable from a bug."""
    current = db.one(
        conn, f"select {field}::text as v from public.investors where company_id = %s",
        (company_id,),
    )
    old = current["v"] if current else None
    new = str(value) if value is not None else None
    if (old or "") == (new or ""):
        return
    db.execute(
        conn,
        f"update public.investors set {field} = %s where company_id = %s",
        (value, company_id),
    )
    db.execute(
        conn,
        """
        insert into public.investor_field_history
            (company_id, field, old_value, new_value, source)
        values (%s, %s, %s, %s, 'ics_import')
        """,
        (company_id, field, old, new),
    )
    stats[field] += 1


def run(conn, dry_run: bool) -> int:
    records = rows_from_sheet()
    stats, unmatched = Counter(), []
    print(f"  {len(records)} named rows in {TAB!r}\n")

    for rec in records:
        company_id = resolve(conn, rec["name"])
        if not company_id:
            unmatched.append(rec["name"])
            continue
        stats["matched"] += 1
        if dry_run:
            continue

        ft = FUND_TYPE.get(rec["fund_type"].upper())
        if ft:
            apply_field(conn, company_id, "fund_type", ft, stats)
        geos = geographies(rec["geography"]) if rec["geography"] else []
        if geos:
            apply_field(conn, company_id, "invest_geographies", geos, stats)
        for field, key in (("ardent_sector", "sector"), ("engagement_level", "engagement"),
                           ("check_band", "check_band"), ("priority", "priority"),
                           ("key_investments", "key_investments")):
            if rec[key]:
                apply_field(conn, company_id, field, rec[key], stats)
        if rec["quality"].isdigit():
            apply_field(conn, company_id, "quality_score", int(rec["quality"]), stats)
        if rec["last_audited"]:
            apply_field(conn, company_id, "last_audited", rec["last_audited"], stats)
        conn.commit()

    print(f"  matched to the existing universe: {stats['matched']}")
    print(f"  unmatched (not yet in the database): {len(unmatched)}")
    for field, n in sorted(stats.items()):
        if field != "matched":
            print(f"    set {field:22s} {n}")
    if unmatched:
        print(f"\n  first unmatched names: {', '.join(unmatched[:10])}")
    if dry_run:
        print("\n  dry run — nothing written. Add --apply.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    with db.connect() as conn:
        return run(conn, not args.apply)


if __name__ == "__main__":
    sys.exit(main())
