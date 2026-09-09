"""Rank investors for a mandate, and say why.

Two families of signal, and the distinction matters more than the arithmetic:

  STATED    what the fund says about itself — strategy, cheque range, geography.
            Covers all 1,285 investors, so it is comparable across the universe.

  REVEALED  who it has actually backed — the portfolio companies the crawler
            found, their names and descriptions, and how recently.
            Covers ~45 investors today. That is 3.5% of the universe.

**Past engagement is deliberately not a signal.** The `prior_approach` value
exists in the match_signal enum and is not used here. A fund passing on a
mandate reflects its timing, fund cycle or a portfolio conflict far more often
than fit, so scoring on it would penalise the busiest and most relevant houses.
The ICS outcomes are for checking this ranking, never for building it.

The coverage gap forces one design decision. If revealed fit simply added to a
total, the ranking would put the houses we happen to have crawled on top — an
artefact of the crawl schedule, not a judgement about fit. So the two families
are scored and displayed **separately**: stated fit ranks the universe, revealed
fit is shown as corroboration where it exists, and an investor is never marked
down for having no portfolio data yet.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import db      # noqa: E402

VERSION = "1"

WEIGHTS = {
    "sector_fit": 0.35,
    "size_fit": 0.25,
    "deal_type_fit": 0.20,
    "geography_fit": 0.20,
}
REVEALED_WEIGHTS = {
    "thesis_similarity": 0.65,
    "recent_activity": 0.35,
}

# Which strategies a mandate type implies. A fund can hold several.
TYPE_TO_STRATEGY = {
    "growth_capital": {"growth", "venture"},
    "sell_side": {"buyout", "growth"},
    "buy_side": {"buyout"},
    "debt": {"credit", "mezzanine"},
    "lp_fundraise": {"fund_of_funds", "secondaries"},
    "continuation_fund": {"secondaries", "buyout"},
    "secondary": {"secondaries"},
    "strategic_review": {"buyout", "growth"},
}

# A mandate is written in a banker's vocabulary and the investor's sector focus
# comes from Crunchbase's. "Retail technology" and "Commerce and Shopping" mean
# the same thing and share no words, so both sides are mapped to concepts before
# comparison. Deliberately small and explicit — a large synonym table would be
# unauditable, and a wrong bridge is worse than a missing one.
CONCEPTS = {
    "commerce": {"retail", "retailer", "retailers", "consumer", "shopping",
                 "commerce", "ecommerce", "e-commerce", "checkout", "grocery",
                 "store", "stores", "merchandising", "brand", "brands", "fashion"},
    "software": {"software", "saas", "platform", "application", "applications",
                 "apps", "cloud"},
    "technology": {"technology", "information", "digital", "tech"},
    "internet": {"internet", "online", "marketplace", "services"},
    "data": {"data", "analytics", "artificial", "intelligence", "machine",
             "vision", "learning"},
    "fintech": {"fintech", "payments", "payment", "lending", "banking",
                "insurance", "insurtech", "wealth"},
    "health": {"health", "healthcare", "medical", "clinical", "pharma",
               "biotechnology", "biotech", "diagnostics", "care"},
    "media": {"media", "entertainment", "content", "publishing", "gaming"},
    "industrial": {"manufacturing", "industrial", "engineering", "science",
                   "materials", "chemicals"},
    "energy": {"energy", "renewable", "cleantech", "climate", "sustainability"},
    "property": {"property", "estate", "proptech", "construction", "housing"},
    "transport": {"transport", "transportation", "logistics", "mobility",
                  "automotive", "supply"},
    "mobile": {"mobile", "telecom", "telecoms", "wireless", "connectivity"},
    "security": {"security", "privacy", "cyber", "identity"},
    "hardware": {"hardware", "electronics", "devices", "semiconductor", "robotics"},
    "commercial": {"sales", "marketing", "recruitment", "staffing", "education"},
}


def concepts(words: set[str]) -> set[str]:
    return {c for c, vocab in CONCEPTS.items() if words & vocab}


STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "over", "under",
    "company", "companies", "business", "businesses", "group", "limited", "ltd",
    "plc", "uk", "market", "markets", "leading", "provider", "providers",
    "services", "service", "solutions", "solution", "platform", "based",
    "products", "product", "customers", "clients", "million", "growth",
}


def keywords(text: str) -> set[str]:
    words = re.findall(r"[a-z][a-z0-9\-]{3,}", (text or "").lower())
    return {w for w in words if w not in STOPWORDS}


def mandate(conn, code: str) -> dict | None:
    return db.one(
        conn,
        """
        select m.id, m.code, m.name, m.mandate_type, m.country_code,
               m.revenue_gbp, m.ebitda_gbp, m.expected_ev_gbp,
               m.business_description, m.hard_filters,
               coalesce(m.required_country_codes,
                        array[m.country_code]::char(2)[]) as required_countries,
               s.name as sector
        from public.mandates m
        left join public.sectors s on s.id = m.sector_id
        where m.code = %s
        """,
        (code,),
    )


def candidates(conn) -> list[dict]:
    return db.all_rows(
        conn,
        """
        select i.company_id, c.legal_name, c.country_code,
               i.min_cheque_raw, i.max_cheque_raw, i.cheque_currency,
               array_remove(array_agg(distinct s.strategy::text), null) as strategies,
               array_remove(array_agg(distinct sec.name), null) as focus,
               max(gr.grade) as grade,
               bool_or(gr.never_approach) as never_approach
        from public.investors i
        join public.companies c on c.id = i.company_id
        left join public.v_investor_current_grade gr on gr.company_id = i.company_id
        left join public.investor_strategies s on s.company_id = i.company_id
        left join public.investor_sector_focus f on f.company_id = i.company_id
        left join public.sectors sec on sec.id = f.sector_id
        where c.merged_into_id is null
        group by i.company_id, c.legal_name, c.country_code,
                 i.min_cheque_raw, i.max_cheque_raw, i.cheque_currency
        """,
    )


def portfolios(conn) -> dict[str, dict]:
    """Per investor: the text of what it has backed, and how recently.

    Text comes from the claims rather than the promoted `companies` rows,
    because promotion writes only a name — the descriptions the crawler
    captured stay on the claim, and they are what makes a thesis match
    explainable rather than a bare name collision.
    """
    text_rows = db.all_rows(
        conn,
        """
        select subject_id,
               string_agg(coalesce(value_text, '') || ' ' ||
                          coalesce(value_json->>'description', ''), ' ') as blob,
               count(*) as holdings
        from public.claims
        where subject_table = 'investors' and attribute = 'portfolio_company'
        group by subject_id
        """,
    )
    recency = db.all_rows(
        conn,
        """
        select investor_company_id,
               max(extract(year from entry_date))::int as latest,
               count(*) filter (where entry_date > now() - interval '4 years') as recent
        from public.investments
        where entry_date is not null
        group by investor_company_id
        """,
    )
    out: dict[str, dict] = defaultdict(dict)
    for r in text_rows:
        out[str(r["subject_id"])] = {"blob": r["blob"] or "", "holdings": r["holdings"],
                                     "latest": None, "recent": 0}
    for r in recency:
        key = str(r["investor_company_id"])
        out.setdefault(key, {"blob": "", "holdings": 0})
        out[key]["latest"] = r["latest"]
        out[key]["recent"] = r["recent"]
    return out


def named_matches(blob: str, wanted: set[str], limit: int = 3) -> list[str]:
    """Which holdings matched, so the reason can name them rather than assert."""
    hits = []
    for line in re.split(r"(?<=[a-z])\s(?=[A-Z])|\n", blob):
        if len(hits) >= limit:
            break
        if keywords(line) & wanted:
            name = line.strip()[:48]
            if name and name not in hits:
                hits.append(name)
    return hits


def excluded_by(m: dict, inv: dict, wanted_concepts: set[str]) -> str | None:
    """Absolute disqualifications, checked before any scoring.

    A fund outside the mandate's geography is not a 40%-good answer, it is not
    an answer, and a strong sector score must not be able to drag it back in.
    Which criteria are absolute is the mandate's decision, not the engine's.

    Every exclusion is returned with its reason so the run can report what it
    threw away — a ranking that silently drops candidates is not auditable.
    """
    if inv.get("never_approach"):
        return "graded never-approach"

    hard = set(m.get("hard_filters") or [])
    if "geography" in hard:
        required = [c for c in (m.get("required_countries") or []) if c]
        if required:
            if not inv.get("country_code"):
                return "geography unknown"
            if inv["country_code"] not in required:
                return f"outside {'/'.join(required)}"

    if "sector" in hard and wanted_concepts:
        focus = [f for f in (inv.get("focus") or []) if f]
        if not focus:
            return "no stated sector focus"
        if not (concepts(keywords(" ".join(focus))) & wanted_concepts):
            return "sector mismatch"

    if "size" in hard:
        target = m.get("expected_ev_gbp") or m.get("revenue_gbp")
        lo, hi = inv.get("min_cheque_raw"), inv.get("max_cheque_raw")
        if target and lo is not None and hi is not None:
            if not (float(lo) <= float(target) <= float(hi)):
                return "cheque range excludes the mandate"

    return None


def score(m: dict, inv: dict, port: dict | None, wanted: set[str],
          wanted_concepts: set[str]) -> dict:
    stated, revealed, reasons = {}, {}, {}

    # -- stated sector focus ---------------------------------------------
    focus = [f for f in (inv.get("focus") or []) if f]
    if focus and wanted_concepts:
        theirs = concepts(keywords(" ".join(focus)))
        shared = wanted_concepts & theirs
        stated["sector_fit"] = len(shared) / len(wanted_concepts)
        if shared:
            matched = [f for f in focus if concepts(keywords(f)) & shared]
            reasons["sector_fit"] = f"states focus on {', '.join(matched[:3])}"

    # -- deal type -------------------------------------------------------
    expected = TYPE_TO_STRATEGY.get(m.get("mandate_type") or "sell_side", set())
    held = set(inv["strategies"] or [])
    if expected and held:
        overlap = held & expected
        stated["deal_type_fit"] = len(overlap) / len(expected) if overlap else 0.0
        if overlap:
            reasons["deal_type_fit"] = f"invests in {', '.join(sorted(overlap))}"

    # -- cheque size -----------------------------------------------------
    target = m.get("expected_ev_gbp") or m.get("revenue_gbp")
    lo, hi = inv.get("min_cheque_raw"), inv.get("max_cheque_raw")
    if target and (lo is not None or hi is not None):
        lo = float(lo or 0)
        hi = float(hi or lo * 10 or 0)
        target = float(target)
        if lo <= target <= hi:
            stated["size_fit"] = 1.0
            reasons["size_fit"] = f"writes {lo/1e6:.0f}–{hi/1e6:.0f}m, mandate at {target/1e6:.0f}m"
        else:
            # Distance in orders of magnitude, so being 2x out is not the same
            # as being 50x out.
            edge = lo if target < lo else hi
            ratio = max(target, edge) / max(min(target, edge), 1)
            stated["size_fit"] = max(0.0, 1 - (ratio - 1) / 4)

    # -- geography -------------------------------------------------------
    if m.get("country_code") and inv.get("country_code"):
        same = inv["country_code"] == m["country_code"]
        stated["geography_fit"] = 1.0 if same else 0.4
        if same:
            reasons["geography_fit"] = f"based in {inv['country_code']}"

    # -- revealed: what they have actually backed ------------------------
    if port and port.get("blob"):
        held_words = keywords(port["blob"])
        if wanted:
            shared = wanted & held_words
            revealed["thesis_similarity"] = min(1.0, len(shared) / max(len(wanted), 1) * 2)
            if shared:
                names = named_matches(port["blob"], wanted)
                reasons["thesis_similarity"] = (
                    f"portfolio overlaps on {', '.join(sorted(shared)[:5])}"
                    + (f" — e.g. {'; '.join(names)}" if names else "")
                )
    if port and port.get("recent") is not None:
        revealed["recent_activity"] = min(1.0, (port.get("recent") or 0) / 5)
        if port.get("latest"):
            reasons["recent_activity"] = (
                f"{port.get('recent', 0)} investments in the last 4 years, "
                f"most recent {port['latest']}")

    def blend(scores: dict, weights: dict) -> float:
        """Normalise over ALL weights, not just the ones we could compute.

        Dividing by the present weights treats a missing signal as "not
        applicable" and hands a perfect score to an investor whose entire case
        is being in the right country: Accelerator London scored 1.00 on
        geography alone and tied with Apax, which matched on strategy, cheque
        size and geography too. Missing data is unknown, not neutral, so an
        absent signal contributes nothing and completeness is rewarded.
        """
        if not scores:
            return 0.0
        return sum(scores.get(k, 0.0) * w for k, w in weights.items()) / sum(weights.values())

    return {
        "stated": round(blend(stated, WEIGHTS), 4),
        "revealed": round(blend(revealed, REVEALED_WEIGHTS), 4) if revealed else None,
        "signals": {**stated, **revealed},
        "reasons": reasons,
        "holdings": (port or {}).get("holdings", 0),
    }


def run(conn, code: str, top: int, apply: bool) -> int:
    m = mandate(conn, code)
    if not m:
        print(f"no mandate with code {code!r}")
        return 1

    wanted = keywords(" ".join(filter(None, [m.get("business_description"),
                                             m.get("sector"), m.get("name")])))
    print(f"  {m['name']}")
    print(f"  type={m['mandate_type']} country={m['country_code']} "
          f"ev={m['expected_ev_gbp']} sector={m['sector']}")
    wanted_concepts = concepts(wanted)
    print(f"  {len(wanted)} keywords -> concepts: {', '.join(sorted(wanted_concepts))}\n")

    port = portfolios(conn)
    rows = candidates(conn)
    scored, excluded = [], Counter()
    for inv in rows:
        reason = excluded_by(m, inv, wanted_concepts)
        if reason:
            excluded[reason] += 1
            continue
        s = score(m, inv, port.get(str(inv["company_id"])), wanted, wanted_concepts)
        if s["stated"] <= 0 and not s["revealed"]:
            continue
        scored.append({**inv, **s})

    if excluded:
        print(f"  hard filters ({', '.join(sorted(set(m.get('hard_filters') or [])))}) "
              f"excluded {sum(excluded.values())}:")
        for reason, n in excluded.most_common(6):
            print(f"      {reason:34s} {n}")
        print()

    # Stated fit ranks the universe; revealed fit breaks ties and corroborates.
    # Adding them would rank the crawl schedule, not the investors.
    scored.sort(key=lambda r: (-(r["stated"]), -(r["revealed"] or 0)))
    with_evidence = sum(1 for r in scored if r["revealed"] is not None)
    print(f"  {len(scored)} scoreable investors, {with_evidence} with portfolio evidence\n")

    for rank, r in enumerate(scored[:top], 1):
        ev = f"{r['revealed']:.2f}" if r["revealed"] is not None else "  — "
        grade = f"  grade {r['grade'].upper()}" if r.get("grade") else ""
        print(f"  {rank:2d}. {r['legal_name'][:34]:34s} stated {r['stated']:.2f}   "
              f"evidence {ev}  ({r['holdings']} holdings){grade}")
        for signal, why in list(r["reasons"].items())[:3]:
            print(f"        {signal:18s} {why[:96]}")

    if not apply:
        print("\n  dry run — nothing written. Add --apply to record the run.")
        return 0

    run_id = db.scalar(
        conn,
        """
        insert into public.match_runs
            (mandate_id, algorithm_version, parameters, candidate_count,
             returned_count, status, finished_at, is_current)
        values (%s, %s, %s, %s, %s, 'ok', now(), false)
        returning id
        """,
        (m["id"], VERSION,
         json.dumps({"stated": WEIGHTS, "revealed": REVEALED_WEIGHTS,
                     "engagement_used": False}),
         len(rows), min(top, len(scored))),
    )
    for rank, r in enumerate(scored[:top], 1):
        match_id = db.scalar(
            conn,
            """
            insert into public.investor_matches
                (run_id, investor_company_id, rank, total_score, score_breakdown,
                 headline_rationale)
            values (%s, %s, %s, %s, %s, %s)
            returning id
            """,
            (run_id, r["company_id"], rank, r["stated"],
             json.dumps({"stated": r["stated"], "revealed": r["revealed"],
                         "signals": r["signals"]}),
             "; ".join(list(r["reasons"].values())[:2])[:400]),
        )
        for signal, why in r["reasons"].items():
            weight = WEIGHTS.get(signal) or REVEALED_WEIGHTS.get(signal) or 0
            db.execute(
                conn,
                """
                insert into public.investor_match_reasons
                    (match_id, signal, raw_score, weight, narrative)
                values (%s, %s::public.match_signal, %s, %s, %s)
                on conflict (match_id, signal) do nothing
                """,
                (match_id, signal, r["signals"].get(signal, 0), weight, why[:500]),
            )
    conn.commit()
    print(f"\n  run {str(run_id)[:8]} recorded, {min(top, len(scored))} matches")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", required=True, help="mandate code, e.g. ics-monument")
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    with db.connect() as conn:
        return run(conn, args.code, args.top, args.apply)


if __name__ == "__main__":
    sys.exit(main())
