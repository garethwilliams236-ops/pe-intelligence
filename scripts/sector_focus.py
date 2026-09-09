"""Promote stated sector focus from claims into investor_sector_focus.

The master list carries a free-text sector field per investor, taken from
"Industry Groups" and "Sector Vertical". It is Crunchbase-shaped, and that
creates one large trap: **332 of 812 investors say "Financial Services, Lending
and Investments"**, which describes the fund itself — every PE house is a
financial services and lending business — not what it backs. Recording that as
a sector focus would tell a retail mandate that a third of the universe
specialises in retail's opposite, with total confidence.

So those two terms are stripped whenever anything else is present, and an
investor left with nothing but them gets no focus recorded at all. Absence is
honest; a wrong sector is not.

"No Specific Sector Focus" is kept as a real answer — a stated generalist is
different from an unknown, and should not be excluded from a sector-led search.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import db      # noqa: E402

# What a fund IS, not what it backs. Dropped when any other term is present.
SELF_DESCRIPTION = {
    "financial services", "lending and investments", "lending & investments",
    "venture capital", "private equity", "investment", "investments",
}

# The same sector arrives spelled two ways and would otherwise become two
# sectors that never match each other — "health care" (67 investors) and
# "healthcare" (27) being the costly pair.
CANONICAL = {
    "health care": "Healthcare",
    "healthcare": "Healthcare",
    "fin tech": "FinTech",
    "fintech": "FinTech",
    "information technology": "Information Technology",
    "it": "Information Technology",
    "e-commerce": "Commerce and Shopping",
    "ecommerce": "Commerce and Shopping",
    "real-estate": "Real Estate",
}

GENERALIST = re.compile(r"no spec\w*ic sector|generalist|sector agnostic|"
                        r"will consider most|^general$", re.I)


def split_terms(text: str) -> list[str]:
    """Comma-separated only. "and" belongs INSIDE these category names.

    Splitting on " and " tore "Lending and Investments" into "Lending" +
    "Investments", so only the second half matched the self-description list and
    "lending" became the most common sector focus in the database — 483 times.
    It also cut "Science and Engineering", "Commerce and Shopping", "Data and
    Analytics" and "Media and Entertainment" into halves that mean nothing.
    """
    parts = re.split(r"[,;/]", text or "")
    return [re.sub(r"\s+", " ", p).strip() for p in parts if p and p.strip()]


def focus_terms(text: str) -> tuple[list[str], bool]:
    """Returns (terms, is_generalist)."""
    if GENERALIST.search(text or ""):
        return [], True
    terms = split_terms(text)
    kept = [CANONICAL.get(t.lower(), t) for t in terms
            if t.lower() not in SELF_DESCRIPTION]
    return list(dict.fromkeys(kept)), False       # dedupe, keep order


def run(conn, apply: bool) -> int:
    rows = db.all_rows(
        conn,
        """
        select c.id, c.subject_id, c.value_text, co.legal_name
        from public.claims c
        join public.companies co on co.id = c.subject_id
        where c.attribute = 'stated_sector_text' and c.status = 'candidate'
        """,
    )

    counts, stats = Counter(), Counter()
    plan = []
    for r in rows:
        terms, generalist = focus_terms(r["value_text"])
        if generalist:
            stats["generalist"] += 1
            plan.append((r, [], True))
            continue
        if not terms:
            # Nothing but self-description. Record nothing.
            stats["self_description_only"] += 1
            continue
        stats["usable"] += 1
        counts.update(t.lower() for t in terms)
        plan.append((r, terms, False))

    print(f"  {len(rows)} sector claims")
    for key, n in stats.most_common():
        print(f"    {key:24s} {n}")
    print("\n  most common usable focus terms:")
    for term, n in counts.most_common(20):
        print(f"    {term[:38]:38s} {n}")

    if not apply:
        print("\n  dry run — nothing written. Add --apply.")
        return 0

    written = 0
    for r, terms, generalist in plan:
        if generalist:
            # A stated generalist gets no sector rows — there is no sector to
            # record — but the claim is marked accepted so it is not reprocessed.
            # The ranking treats "no focus rows" as unknown, which is right here
            # too: a generalist should not be excluded from a sector search.
            db.execute(conn, "update public.claims set status = 'accepted' where id = %s",
                       (r["id"],))
            continue
        for term in terms:
            sector_id = db.scalar(
                conn,
                """
                insert into public.sectors (taxonomy, code, name, depth)
                values ('ardent', %s, %s, 1)
                on conflict (taxonomy, code) do update set name = excluded.name
                returning id
                """,
                (re.sub(r"[^a-z0-9]+", "_", term.lower()).strip("_")[:60], term),
            )
            db.execute(
                conn,
                """
                insert into public.investor_sector_focus (company_id, sector_id, weight)
                values (%s, %s, 1.000)
                on conflict (company_id, sector_id) do nothing
                """,
                (r["subject_id"], sector_id),
            )
            written += 1
        db.execute(conn, "update public.claims set status = 'accepted' where id = %s",
                   (r["id"],))
    conn.commit()
    print(f"\n  {written} focus rows written")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    with db.connect() as conn:
        return run(conn, args.apply)


if __name__ == "__main__":
    sys.exit(main())
