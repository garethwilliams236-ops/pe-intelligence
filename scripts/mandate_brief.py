"""Capture and promote a mandate's brief.

The ICS says which investors were approached. It does not say what they were
approached *about* — and a ranking cannot be tested without knowing the question
it was meant to answer. So the 43 mandates loaded in WP6 carry a client name and
nothing else: no sector, no size, no stage.

A brief can arrive four ways, and all of them write to the same place:

  set        an analyst types it                     source `manual`      0.95
  extract    read from the client's Exec Summary     `ardent_client_docs` 0.85
  infer      register and public web                 `inferred`           0.60
  status     what is known and what is missing

Every field is written as a *claim* against the mandate, exactly as portfolio
companies were in WP4, and promotion takes the highest-confidence claim per
attribute. So a hand-entered EBITDA beats an extracted one, an extracted one
beats an inferred one, and every populated field can say where it came from —
which is what lets a ranking be defended rather than merely asserted.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import db     # noqa: E402

VERSION = "1"

# Confidence by route, not by field. The ordering is the whole point.
SOURCE_CONFIDENCE = {
    "manual": 0.950,
    "ardent_client_docs": 0.850,
    "inferred": 0.600,
}

# Attribute -> (column on mandates, how to read the value)
FIELDS = {
    "sector":       ("sector_id", "sector"),
    "country":      ("country_code", "text"),
    "revenue":      ("revenue_gbp", "numeric"),
    "ebitda":       ("ebitda_gbp", "numeric"),
    "ev":           ("expected_ev_gbp", "numeric"),
    "raise":        ("expected_ev_gbp", "numeric"),
    "type":         ("mandate_type", "text"),
    "description":  ("business_description", "text"),
}

# The schema's comment lists sell_side | buy_side | growth_capital | debt |
# strategic_review. The client folders also hold LP fundraises and continuation
# funds (Truffle), which are a different universe of investors entirely, so the
# vocabulary is extended here rather than forced into the nearest existing value.
MANDATE_TYPES = {
    "sell_side", "buy_side", "growth_capital", "debt", "strategic_review",
    "lp_fundraise", "continuation_fund", "secondary",
}


def mandates(conn, code: str | None = None) -> list[dict]:
    return db.all_rows(
        conn,
        """
        select m.id, m.code, m.name, m.mandate_type, m.country_code,
               m.revenue_gbp, m.ebitda_gbp, m.expected_ev_gbp,
               s.name as sector,
               (select count(*) from public.mandate_investor_outcomes o
                 where o.mandate_id = m.id) as investors
        from public.mandates m
        left join public.sectors s on s.id = m.sector_id
        where (%s::text is null or m.code = %s)
        order by investors desc, m.name
        """,
        (code, code),
    )


def cmd_status(conn, args) -> int:
    rows = mandates(conn, args.code)
    known = 0
    for r in rows:
        have = [k for k, v in (("sector", r["sector"]), ("type", r["mandate_type"]),
                               ("country", r["country_code"]), ("rev", r["revenue_gbp"]),
                               ("ebitda", r["ebitda_gbp"]), ("ev", r["expected_ev_gbp"]))
                if v not in (None, "sell_side")]
        if have:
            known += 1
        print(f"  {(r['code'] or '')[:28]:28s} {r['investors']:4d} investors   "
              f"{', '.join(have) if have else '— no brief —'}")
    print(f"\n  {len(rows)} mandates, {known} with any brief captured")
    print("  fill one in with:  mandate_brief.py set --code ics-monument "
          "--sector 'Financial services' --type growth_capital --revenue 12000000")
    return 0


def write_claim(conn, mandate_id, attribute, *, text=None, numeric=None,
                source_code="manual") -> None:
    db.execute(
        conn,
        """
        insert into public.claims
            (subject_table, subject_id, attribute, value_text, value_numeric,
             currency, status, confidence, licence_class, extracted_by,
             extraction_version)
        values ('mandates', %s, %s, %s, %s, %s, 'candidate', %s, 'confidential',
                %s, %s)
        """,
        (mandate_id, attribute, text, numeric,
         "GBP" if numeric is not None else None,
         SOURCE_CONFIDENCE[source_code], source_code, VERSION),
    )


def resolve_sector(conn, name: str) -> str:
    """Ardent's own sector labels, kept in their own taxonomy.

    Deliberately not SIC: the ICS and the master list talk in terms a banker
    uses ("Financial services", "Consumer"), and forcing those onto SIC codes
    would lose the vocabulary the matching actually needs.
    """
    return db.scalar(
        conn,
        """
        insert into public.sectors (taxonomy, code, name, depth)
        values ('ardent', lower(replace(%s, ' ', '_')), %s, 1)
        on conflict (taxonomy, code) do update set name = excluded.name
        returning id
        """,
        (name, name),
    )


def cmd_set(conn, args) -> int:
    row = db.one(conn, "select id, name from public.mandates where code = %s", (args.code,))
    if not row:
        print(f"no mandate with code {args.code!r} — run status to list them")
        return 1

    written = []
    for flag, (column, kind) in FIELDS.items():
        value = getattr(args, flag, None)
        if value is None:
            continue
        if flag == "type" and value not in MANDATE_TYPES:
            print(f"unknown mandate type {value!r}; expected one of {sorted(MANDATE_TYPES)}")
            return 1
        if kind == "numeric":
            write_claim(conn, row["id"], column, numeric=value, source_code=args.source)
        elif kind == "sector":
            sector_id = resolve_sector(conn, value)
            write_claim(conn, row["id"], column, text=str(sector_id), source_code=args.source)
        else:
            write_claim(conn, row["id"], column, text=value, source_code=args.source)
        written.append(flag)

    if not written:
        print("nothing to set — pass at least one of "
              + ", ".join(f"--{f}" for f in FIELDS))
        return 1
    conn.commit()
    print(f"  {row['name']}: wrote {len(written)} claims ({', '.join(written)})")
    return cmd_promote(conn, args)


def cmd_promote(conn, args) -> int:
    """Highest-confidence claim per attribute wins, and is recorded as accepted."""
    rows = db.all_rows(
        conn,
        """
        select distinct on (c.subject_id, c.attribute)
               c.id, c.subject_id, c.attribute, c.value_text, c.value_numeric,
               c.confidence, c.extracted_by
        from public.claims c
        where c.subject_table = 'mandates' and c.status = 'candidate'
          and (%s::text is null
               or c.subject_id = (select id from public.mandates where code = %s))
        order by c.subject_id, c.attribute, c.confidence desc, c.created_at desc
        """,
        (args.code, args.code),
    )
    for r in rows:
        column = r["attribute"]
        if column not in {v[0] for v in FIELDS.values()}:
            continue
        value = r["value_numeric"] if r["value_numeric"] is not None else r["value_text"]
        # sector_id is a uuid column and the claim carries it as text; Postgres
        # will not cast a text parameter into a uuid column on its own.
        cast = "::uuid" if column == "sector_id" else ""
        db.execute(
            conn,
            f"update public.mandates set {column} = %s{cast}, updated_at = now() "
            f"where id = %s",
            (value, r["subject_id"]),
        )
        db.execute(conn, "update public.claims set status = 'accepted' where id = %s", (r["id"],))
    conn.commit()
    if rows:
        print(f"  promoted {len(rows)} attributes")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("status", help="what is known and what is missing")
    p.add_argument("--code")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("set", help="type a brief for one mandate")
    p.add_argument("--code", required=True)
    p.add_argument("--source", default="manual", choices=sorted(SOURCE_CONFIDENCE))
    p.add_argument("--sector")
    p.add_argument("--country")
    p.add_argument("--type", dest="type")
    p.add_argument("--description")
    p.add_argument("--revenue", type=float)
    p.add_argument("--ebitda", type=float)
    p.add_argument("--ev", type=float)
    p.add_argument("--raise", dest="raise", type=float)
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("promote", help="apply the best claim per attribute")
    p.add_argument("--code")
    p.set_defaults(func=cmd_promote)

    args = ap.parse_args()
    with db.connect() as conn:
        return args.func(conn, args)


if __name__ == "__main__":
    sys.exit(main())
