"""Turn candidate claims into investments.

This is the first step that writes to the typed tables, and the first that
guesses. The guesses are about identity: is the "Sedex" on LDC's portfolio page
the Sedex already in `companies`, or a different one? Three outcomes:

  linked      confident match against an existing company
  created     no acceptable match, so a new company row
  ambiguous   several plausible matches within a whisker of each other —
              nothing is written, and the alternatives are recorded for review

Every decision is logged in `promotions`, and `undo_promotion_run()` reverses a
whole run. Nothing here is meant to be trusted blindly; it is meant to be
inspectable and undoable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from . import db

VERSION = "1"

# Tuning. Deliberately conservative: a wrong link is worse than a duplicate
# company, because a duplicate is visible and a wrong link is not.
EXACT = 1.0
LINK_THRESHOLD = 0.72       # below this we would rather create than link
AMBIGUOUS_MARGIN = 0.05     # runner-up this close means we cannot choose
MIN_NAME_LENGTH = 3         # "IO" and "CAP" are real but unmatchable on their own


@dataclass
class Decision:
    action: str
    company_id: str | None = None
    matched_name: str | None = None
    similarity: float | None = None
    alternatives: list[dict] | None = None
    note: str | None = None


def candidates(conn, name: str, investor_company_id: str) -> list[dict]:
    """Existing companies that might be this portfolio company.

    Trigram alone is not enough: "Sedex" against "Sedex Information Exchange
    Limited" scores about 0.2, because similarity punishes the length gap. But
    sponsor sites publish trading names and registries hold legal names, so that
    is the normal case, not the edge case. The word-boundary LIKE clauses below
    catch it, and still use the trigram GIN index.

    Sponsors are excluded — a portfolio company is not a PE house — as is the
    investor itself, which otherwise matches its own portfolio entries.
    """
    return db.all_rows(
        conn,
        """
        with q as (select public.normalise_name(%s) as key)
        select c.id, c.legal_name, c.name_key, c.country_code,
               extensions.similarity(c.name_key, q.key) as sim,
               (c.name_key = q.key) as exact
        from public.companies c, q
        where c.merged_into_id is null
          and c.id <> %s
          and not ('sponsor' = any(c.company_types))
          and q.key is not null
          and (   c.name_key = q.key
               or c.name_key like q.key || ' %%'
               or c.name_key like '%% ' || q.key
               or c.name_key like '%% ' || q.key || ' %%'
               or c.name_key %% q.key)
        order by exact desc, sim desc
        limit 8
        """,
        (name, investor_company_id),
    )


def _tokens(key: str | None) -> list[str]:
    return [t for t in (key or "").split() if t]


def _contains_name(claim_tokens: list[str], cand_tokens: list[str]) -> bool:
    """Is the claimed name the leading part of the candidate's name?

    Leading, not merely present: "Sedex" heads "Sedex Information Exchange", but
    "Group" appearing somewhere inside a name means nothing. Requiring the first
    token to match is what stops "Harvest" linking to "Spring Harvest Foods".
    """
    if not claim_tokens or len(claim_tokens) > len(cand_tokens):
        return False
    return cand_tokens[:len(claim_tokens)] == claim_tokens


def decide(conn, name: str, investor_company_id: str) -> Decision:
    if not name or len(name.strip()) < MIN_NAME_LENGTH:
        return Decision("skipped", note="name too short to match on")

    rows = candidates(conn, name, investor_company_id)
    if not rows:
        return Decision("created")

    exact = [r for r in rows if r["exact"]]
    if len(exact) == 1:
        return Decision("linked", exact[0]["id"], exact[0]["legal_name"], EXACT)
    if len(exact) > 1:
        return Decision("ambiguous",
                        alternatives=[{"id": str(r["id"]), "name": r["legal_name"], "sim": 1.0}
                                      for r in exact],
                        note="several companies share this exact name")

    claim_key = db.scalar(conn, "select public.normalise_name(%s)", (name,))
    claim_tokens = _tokens(claim_key)

    # Trading name heading a longer legal name — the common case.
    leading = [r for r in rows if _contains_name(claim_tokens, _tokens(r["name_key"]))]
    if len(leading) == 1:
        r = leading[0]
        return Decision("linked", r["id"], r["legal_name"], 0.900,
                        note="claimed name heads the registered name")
    if len(leading) > 1:
        return Decision("ambiguous",
                        alternatives=[{"id": str(r["id"]), "name": r["legal_name"],
                                       "sim": float(r["sim"] or 0)} for r in leading],
                        note=f"{len(leading)} companies start with this name")

    best = rows[0]
    best_sim = float(best["sim"] or 0)
    if best_sim < LINK_THRESHOLD:
        return Decision("created", note=f"best match {best['legal_name']!r} at {best_sim:.2f}")

    runners = [r for r in rows[1:] if float(r["sim"] or 0) >= best_sim - AMBIGUOUS_MARGIN]
    if runners:
        alts = [{"id": str(r["id"]), "name": r["legal_name"], "sim": float(r["sim"])}
                for r in [best] + runners]
        return Decision("ambiguous", alternatives=alts,
                        note=f"{len(alts)} candidates within {AMBIGUOUS_MARGIN}")

    return Decision("linked", best["id"], best["legal_name"], round(best_sim, 3))


def claims_to_promote(conn, limit: int, investor: str | None) -> list[dict]:
    """Portfolio-company claims, with their dates attached where they exist."""
    return db.all_rows(
        conn,
        f"""
        select p.id as claim_id, p.subject_id as investor_company_id,
               p.value_text as name, p.value_json as detail,
               inv.legal_name as investor_name,
               d.value_json as dates
        from public.claims p
        join public.companies inv on inv.id = p.subject_id
        left join public.claims d
               on d.subject_id = p.subject_id
              and d.attribute = 'portfolio_company_dates'
              and lower(d.value_text) = lower(p.value_text)
        where p.attribute = 'portfolio_company'
          and p.status = 'candidate'
          {"and inv.legal_name ilike %(investor)s" if investor else ""}
        order by inv.legal_name, p.value_text
        limit %(limit)s
        """,
        {"limit": limit, "investor": f"%{investor}%"} if investor
        else {"limit": limit},
    )


def _year_to_date(year) -> str | None:
    try:
        y = int(year)
    except (TypeError, ValueError):
        return None
    return f"{y:04d}-01-01" if 1900 <= y <= 2100 else None


def run(conn, *, limit: int, investor: str | None, dry_run: bool,
        verbose: bool = False) -> dict:
    rows = claims_to_promote(conn, limit, investor)
    stats = {"considered": len(rows), "linked": 0, "created": 0,
             "ambiguous": 0, "skipped": 0, "investments": 0}

    run_id = None
    if not dry_run:
        run_id = db.scalar(
            conn,
            """
            insert into public.promotion_runs (algorithm_version, parameters)
            values (%s, %s) returning id
            """,
            (VERSION, json.dumps({"limit": limit, "investor": investor,
                                  "link_threshold": LINK_THRESHOLD,
                                  "ambiguous_margin": AMBIGUOUS_MARGIN})),
        )

    for row in rows:
        decision = decide(conn, row["name"], row["investor_company_id"])
        stats[decision.action if decision.action != "linked" else "linked"] += 1

        if verbose or dry_run:
            detail = decision.matched_name or (decision.note or "")
            sim = f" {decision.similarity:.2f}" if decision.similarity else ""
            print(f"  {decision.action:9s} {row['investor_name'][:22]:22s} "
                  f"{row['name'][:34]:34s} {detail[:40]}{sim}")

        if dry_run:
            continue

        company_id = decision.company_id
        if decision.action == "created":
            company_id = db.scalar(
                conn,
                """
                insert into public.companies
                    (legal_name, company_types, confidence, promotion_run_id)
                values (%s, '{portfolio_company}'::public.company_type[], 0.600, %s)
                returning id
                """,
                (row["name"], run_id),
            )

        db.execute(
            conn,
            """
            insert into public.promotions
                (run_id, claim_id, action, target_table, target_id,
                 matched_name, similarity, alternatives, note)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (run_id, row["claim_id"], decision.action,
             "companies" if company_id else None, company_id,
             decision.matched_name, decision.similarity,
             json.dumps(decision.alternatives) if decision.alternatives else None,
             decision.note),
        )

        if decision.action in ("ambiguous", "skipped") or not company_id:
            continue

        dates = row["dates"] or {}
        entry = _year_to_date(dates.get("entry_year"))
        exit_ = _year_to_date(dates.get("exit_year"))
        status = dates.get("status") or (row["detail"] or {}).get("status")
        made = db.scalar(
            conn,
            """
            insert into public.investments
                (investor_company_id, portfolio_company_id, entry_date, exit_date,
                 entry_precision, exit_precision, status, source_id, licence_class,
                 confidence, promotion_run_id)
            values (%s, %s, %s::date, %s::date,
                    %s::public.date_precision, %s::public.date_precision,
                    coalesce(%s, 'unknown')::public.investment_status,
                    (select id from public.sources where code = 'sponsor_site'),
                    'public_attributable', %s, %s)
            on conflict do nothing
            returning id
            """,
            (row["investor_company_id"], company_id, entry, exit_,
             # Only the year was published, so say so rather than implying that
             # 1 January is the real date.
             "year" if entry else None,
             "year" if exit_ else None,
             status if status in ("current", "realised") else None,
             0.600 if entry else 0.450, run_id),
        )
        if made:
            stats["investments"] += 1
            db.execute(conn, "update public.claims set status = 'accepted' where id = %s",
                       (row["claim_id"],))

    if not dry_run:
        db.execute(
            conn,
            """
            update public.promotion_runs
               set finished_at = now(), status = 'ok', claims_considered = %s,
                   linked = %s, created = %s, ambiguous = %s, investments_made = %s
             where id = %s
            """,
            (stats["considered"], stats["linked"], stats["created"],
             stats["ambiguous"], stats["investments"], run_id),
        )
        conn.commit()
        stats["run_id"] = str(run_id)

    return stats
