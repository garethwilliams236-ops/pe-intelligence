"""Load Investor Control Sheets into mandates and outcomes.

Reads what `ics_parse` found and writes three things:

  clients                     one per client folder
  mandates                    one per client, standing for that engagement
  mandate_investor_outcomes   one row per investor, carrying how far it got

Two deliberate constraints.

`mandate_investor_outcomes.investor_company_id` references `investors`, so only
names that resolve against the 1,285-strong master list can be recorded. That is
the right constraint — an outcome against an investor we cannot identify is not
usable evidence — but it means the match rate is the number that decides whether
this dataset is usable at all, which is why --dry-run reports it before writing.

The ICS is client-confidential: it names who a specific client approached and who
turned them down. It is registered as a `confidential` source so nothing from it
can reach a client-facing report through `is_redistributable()`.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import db                                    # noqa: E402
from scripts.ics_parse import STAGES, best_parse, discover  # noqa: E402

# The schema's own vocabulary where it has one, ours where it does not. Kept
# explicit rather than reusing the parser's names directly, so a change to the
# funnel model does not silently rewrite what is already in the table.
STAGE_TO_OUTCOME = {
    "contacted": "approached",
    "reviewing": "reviewing",
    "qualified": "qualified",
    "engaged": "engaged",
    "management": "management_meeting",
    "offer": "ioi",
    "passed": "declined",
    "not_approved": "declined",
    "no_response": "no_response",
    "on_hold": "on_hold",
}

MIN_NAME_LENGTH = 3
LINK_THRESHOLD = 0.72


def resolve(conn, name: str) -> dict | None:
    """Find this investor in the master list.

    Same rule as promotion: exact normalised match, else the claimed name
    leading a candidate's name, else a strong trigram score. Anything ambiguous
    returns nothing rather than guessing — a wrong investor on a mandate would
    corrupt the very signal this table exists to provide.
    """
    if len(name) < MIN_NAME_LENGTH:
        return None
    rows = db.all_rows(
        conn,
        """
        select i.company_id, c.legal_name,
               public.normalise_name(c.legal_name) as norm,
               extensions.similarity(public.normalise_name(c.legal_name),
                                     public.normalise_name(%s)) as sim
        from public.investors i
        join public.companies c on c.id = i.company_id
        where public.normalise_name(c.legal_name) %% public.normalise_name(%s)
           or public.normalise_name(c.legal_name) = public.normalise_name(%s)
        order by sim desc
        limit 8
        """,
        (name, name, name),
    )
    if not rows:
        return None

    want = db.scalar(conn, "select public.normalise_name(%s)", (name,)) or ""
    want_tokens = want.split()

    exact = [r for r in rows if r["norm"] == want]
    if len(exact) == 1:
        return {**exact[0], "how": "exact"}
    if len(exact) > 1:
        return None

    leads = [r for r in rows
             if r["norm"].split()[:len(want_tokens)] == want_tokens and want_tokens]
    if len(leads) == 1:
        return {**leads[0], "how": "leads"}
    if len(leads) > 1:
        return None

    strong = [r for r in rows if float(r["sim"] or 0) >= LINK_THRESHOLD]
    if len(strong) == 1:
        return {**strong[0], "how": "trigram"}
    return None


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def load(conn, *, dry_run: bool, limit: int) -> dict:
    targets = sorted(discover().items())
    if limit:
        targets = targets[:limit]

    source = db.source_id(conn, "ardent_ics")
    totals = Counter()
    how = Counter()
    unresolved: Counter = Counter()

    for client, candidates in targets:
        result, _ = best_parse(candidates)
        if "error" in result:
            totals["skipped_files"] += 1
            continue

        rows = result["rows"]
        matched = []
        for row in rows:
            hit = resolve(conn, row["name"])
            if hit:
                how[hit["how"]] += 1
                matched.append((row, hit))
            else:
                unresolved[row["name"]] += 1

        totals["clients"] += 1
        totals["rows"] += len(rows)
        totals["matched"] += len(matched)
        deep = sum(1 for r, _ in matched if STAGES.get(r["stage"] or "", 0) >= 4)
        totals["engaged_plus"] += deep
        print(f"  {client[:26]:26s} {len(matched):4d}/{len(rows):4d} matched, {deep:3d} engaged+")

        if dry_run:
            continue

        client_id = db.scalar(
            conn,
            """
            insert into public.clients (name) values (%s)
            on conflict do nothing
            returning id
            """,
            (client,),
        ) or db.scalar(conn, "select id from public.clients where name = %s", (client,))

        mandate_id = db.scalar(
            conn,
            """
            insert into public.mandates (client_id, code, name, status)
            values (%s, %s, %s, 'closed')
            on conflict (code) do update set name = excluded.name
            returning id
            """,
            (client_id, f"ics-{slug(client)}", f"{client} — from ICS"),
        )

        for row, hit in matched:
            stage = STAGE_TO_OUTCOME.get(row["stage"] or "", "approached")
            db.execute(
                conn,
                """
                insert into public.mandate_investor_outcomes
                    (mandate_id, investor_company_id, stage, notes)
                values (%s, %s, %s, %s)
                on conflict (mandate_id, investor_company_id, stage) do nothing
                """,
                (mandate_id, hit["company_id"], stage,
                 f"ICS code {row['code']} = {row['label']!r}; matched {hit['how']}"
                 if row["label"] else f"ICS code {row['code']}; matched {hit['how']}"),
            )
            totals["outcomes"] += 1
        conn.commit()

    pct = 100 * totals["matched"] / totals["rows"] if totals["rows"] else 0
    print(f"\n  {totals['clients']} clients, {totals['rows']} rows, "
          f"{totals['matched']} matched to the master list ({pct:.0f}%)")
    print(f"  {totals['engaged_plus']} of those reached engaged or deeper")
    print(f"  match method: {dict(how)}")
    if not dry_run:
        print(f"  {totals['outcomes']} outcome rows written (source {str(source)[:8]})")
    print("\n  most common unresolved names:")
    for name, n in unresolved.most_common(12):
        print(f"    {name[:44]:44s} {n}")
    return totals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    with db.connect() as conn:
        load(conn, dry_run=args.dry_run, limit=args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
