"""Match companies to the Companies House register.

Two commands, deliberately separate:

  enrich ch          search the register and record what it found as *claims*
  enrich ch --accept turn high-confidence claims into company_identifiers,
                     SIC sectors and a country code

Keeping them apart means a bad matching run is inspectable before anything
touches the typed tables, and the accept step can be re-run with a stricter
threshold without re-querying the API.

Nothing here needs a migration: WP1 already provided `company_identifiers`
with a `companies_house` scheme, a `sectors` table with a `taxonomy` column,
and the `companies_house` source row.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import db
from .companies_house import CompaniesHouse

# Bumped when the scoring rule changes, so claims written by an older, looser
# matcher stay distinguishable from these. v2 stopped treating a high trigram
# score with a differing first token as a match.
VERSION = "2"

ACCEPT_SCORE = 0.85         # write an identifier at or above this
REVIEW_SCORE = 0.60         # below this we do not even record a candidate
AMBIGUOUS_MARGIN = 0.08

# A dissolved company can still be the right match — plenty of portfolio
# companies were dissolved after a trade sale — but an active one with the
# same name is a better bet.
STATUS_BONUS = {"active": 0.06, "open": 0.06}
STATUS_PENALTY = {"dissolved": -0.10, "liquidation": -0.04, "converted-closed": -0.06}


# Forms of incorporation, which carry no identity: "Card Factory plc" and
# "Card Factory Limited" are the same name. Deliberately NOT including group,
# holdings, company or co — those are part of what a business is called, and
# `normalise_name` strips them, which is right for retrieval and wrong here.
_LEGAL_FORMS = {
    "limited", "ltd", "plc", "llp", "lp", "llc", "inc", "incorporated",
    "gmbh", "ag", "kg", "kgaa", "se", "nv", "bv", "sa", "sas", "sarl", "srl",
    "spa", "ab", "as", "aps", "oy", "oyj", "sl", "sau", "ug", "eurl", "snc",
}
_PUNCTUATION = re.compile(r"[^a-z0-9]+")


def _tokens(name: str) -> list[str]:
    """Identity tokens: lowercased, depunctuated, legal form and article removed.

    Stricter than `normalise_name`, on purpose. Because that function strips
    "co", "group" and "holdings", "Aims" came out equal to "AIMS & CO LTD" and
    "BOAL Group" equal to "BOAL LIMITED" — different companies scored 1.0. Here
    only the form of incorporation is discarded, so "Deb Group" leads "Deb Group
    Holdings Limited" (a strong match) rather than being identical to it.

    A leading "The" is dropped, since the register writes "THE AMBASSADOR
    THEATRE GROUP LIMITED" for what its own website calls Ambassador Theatre
    Group.
    """
    tokens = [t for t in _PUNCTUATION.sub(" ", name.lower()).split()
              if t and t not in _LEGAL_FORMS]
    if len(tokens) > 1 and tokens[0] == "the":
        tokens = tokens[1:]
    return tokens


@dataclass
class Match:
    number: str | None = None
    name: str | None = None
    score: float = 0.0
    status: str | None = None
    incorporated: str | None = None
    alternatives: list[dict] | None = None
    note: str | None = None
    kind: str | None = None     # exact | leads | fuzzy


def _score(conn, wanted: str, candidate_name: str, status: str | None) -> tuple[float, str]:
    """Name closeness, nudged by company status. Returns (score, kind).

    Same containment rule as promotion: a trading name that heads the
    registered name is a strong signal, because that is how the register
    differs from a sponsor's website.

    The *kind* matters as much as the score. A high trigram similarity with a
    different first token is not a match — "A-Plan Insurance" scores 0.639
    against "AA Insurance Holdings" and "Adb Airfield Solutions" scores 0.82
    against "AAS Airfield Solutions", and both are wrong companies. Trigram
    similarity measures shared letters, not shared identity, so `fuzzy` is
    reported separately and never becomes a company number on its own.
    """
    row = db.one(
        conn,
        """
        select public.normalise_name(%s) as want,
               public.normalise_name(%s) as got,
               extensions.similarity(public.normalise_name(%s),
                                     public.normalise_name(%s)) as sim
        """,
        (wanted, candidate_name, wanted, candidate_name),
    )
    sim = float(row["sim"] or 0)
    # Identity is judged on the raw names; `normalise_name` is used only for the
    # trigram fallback, where its heavier stripping helps rather than hurts.
    want_tokens, got_tokens = _tokens(wanted), _tokens(candidate_name)
    if not want_tokens or not got_tokens:
        return 0.0, "fuzzy"

    if want_tokens == got_tokens:
        base, kind = 1.0, "exact"
    else:
        leads = (len(want_tokens) < len(got_tokens)
                 and got_tokens[:len(want_tokens)] == want_tokens)
        base, kind = (0.90, "leads") if leads else (sim, "fuzzy")

    key = (status or "").lower()
    score = base + STATUS_BONUS.get(key, 0) + STATUS_PENALTY.get(key, 0)
    return max(0.0, min(1.0, score)), kind


def _incorporated_year(item: dict) -> int | None:
    created = item.get("date_of_creation") or ""
    return int(created[:4]) if created[:4].isdigit() else None


def find(conn, ch: CompaniesHouse, name: str, entry_year: int | None = None) -> Match:
    items = ch.search(name)
    if not items:
        return Match(note="no results")

    scored, too_young = [], 0
    for item in items:
        candidate = item.get("title") or item.get("company_name") or ""
        if not candidate:
            continue

        # A company incorporated well after the sponsor bought the business
        # cannot be that business. One year of slack, because a buyout usually
        # incorporates a fresh bidco at completion and the register then carries
        # the trading name — so incorporation *at* entry is normal, not odd.
        born = _incorporated_year(item)
        if entry_year and born and born > entry_year + 1:
            too_young += 1
            continue

        score, kind = _score(conn, name, candidate, item.get("company_status"))
        scored.append({
            "number": item.get("company_number"),
            "name": candidate,
            "status": item.get("company_status"),
            "incorporated": item.get("date_of_creation"),
            "score": round(score, 3),
            "kind": kind,
        })
    # Prefer a name that agrees on identity over one that merely shares letters,
    # so a leading-token match always outranks a higher-scoring fuzzy one.
    scored.sort(key=lambda r: (r["kind"] == "fuzzy", -r["score"]))
    suffix = f" ({too_young} too young)" if too_young else ""
    if not scored or scored[0]["score"] < REVIEW_SCORE:
        best = scored[0] if scored else None
        note = (f"best {best['name']!r} at {best['score']}" if best
                else f"no usable results{suffix}")
        return Match(note=note + (suffix if best else ""))

    best = scored[0]

    # Shared letters, but the names disagree on identity: either a different
    # leading word, or a claimed name longer than the candidate's. Record it for
    # review; never hand downstream a number no name evidence supports.
    if best["kind"] == "fuzzy":
        return Match(score=best["score"], kind="fuzzy", alternatives=scored[:3],
                     note=f"weak — {best['name']} at {best['score']}, names disagree{suffix}")

    # Ambiguity is only meaningful between candidates of the same *kind*. An
    # exact name match is not made doubtful by a longer name that merely starts
    # the same way: "Card Factory" is Card Factory Limited, not Card Factory
    # Group plc. Two exacts, or two leads, are genuinely a coin toss.
    same_kind = [r for r in scored if r["kind"] == best["kind"]]
    close = [r for r in same_kind[1:] if r["score"] >= best["score"] - AMBIGUOUS_MARGIN]
    if close:
        return Match(score=best["score"], kind=best["kind"], alternatives=[best] + close[:3],
                     note=f"{len(close) + 1} candidates within {AMBIGUOUS_MARGIN}{suffix}")

    return Match(best["number"], best["name"], best["score"],
                 best["status"], best["incorporated"], kind=best["kind"])


def unmatched_companies(conn, limit: int) -> list[dict]:
    """Companies with no Companies House number yet.

    Sponsors are skipped — we care about portfolio companies — as are companies
    already carrying an identifier from a previous run.
    """
    return db.all_rows(
        conn,
        """
        select c.id, c.legal_name, c.country_code,
               (select min(extract(year from i.entry_date))::int
                  from public.investments i
                 where i.portfolio_company_id = c.id
                   and i.entry_date is not null) as entry_year
        from public.companies c
        where c.merged_into_id is null
          and not ('sponsor' = any(c.company_types))
          and not exists (select 1 from public.company_identifiers ci
                          where ci.company_id = c.id and ci.scheme = 'companies_house')
          and exists (select 1 from public.investments i
                      where i.portfolio_company_id = c.id)
        order by c.legal_name
        limit %s
        """,
        (limit,),
    )


def search_and_record(conn, *, limit: int, dry_run: bool, verbose: bool = False) -> dict:
    """Search the register and store each result as a candidate claim."""
    rows = unmatched_companies(conn, limit)
    stats = {"considered": len(rows), "matched": 0, "ambiguous": 0, "weak": 0, "none": 0}
    if not rows:
        print("nothing to match — every portfolio company already has a number")
        return stats

    ch = CompaniesHouse(verbose=verbose)
    source = db.source_id(conn, "companies_house")
    try:
        for row in rows:
            match = find(conn, ch, row["legal_name"], entry_year=row.get("entry_year"))

            if match.number:
                stats["matched"] += 1
                label = f"{match.name} ({match.number}) {match.score} [{match.kind}]"
            elif match.kind == "fuzzy":
                stats["weak"] += 1
                label = match.note or "weak"
            elif match.alternatives:
                stats["ambiguous"] += 1
                label = match.note or "ambiguous"
            else:
                stats["none"] += 1
                label = match.note or "no match"
            print(f"  {row['legal_name'][:34]:34s} {label}")

            if dry_run:
                continue

            # The API response is the evidence, so it is stored as a document
            # and the match recorded as a claim against it — the same shape as
            # anything the crawler produces.
            payload = {"query": row["legal_name"],
                       "match": {k: v for k, v in match.__dict__.items()}}
            document_id = db.scalar(
                conn,
                """
                insert into public.documents
                    (source_id, url, canonical_url, title, retrieved_at, http_status,
                     content_type, content_hash, extracted_text, licence_class)
                values (%s, %s, %s, %s, now(), 200, 'application/json',
                        md5(%s), %s, 'public_domain')
                returning id
                """,
                (source,
                 f"https://api.company-information.service.gov.uk/search/companies"
                 f"?q={row['legal_name']}",
                 None, f"CH search: {row['legal_name']}",
                 json.dumps(payload), json.dumps(payload)),
            )

            db.insert_claim(
                conn,
                subject_table="companies", subject_id=row["id"], subject_key=None,
                attribute="companies_house_number" if match.number else "companies_house_no_match",
                value_text=match.number or (match.note or "no match"),
                value_json=payload["match"],
                confidence=match.score or 0.100,
                extracted_by="companies_house", extraction_version=VERSION,
                document_id=document_id, quote=match.name,
            )
            conn.commit()
    finally:
        ch.close()

    print(f"\n  {ch.calls} API calls")
    return stats


def accept(conn, *, min_score: float, dry_run: bool) -> dict:
    """Turn confident match claims into identifiers, sectors and country."""
    rows = db.all_rows(
        conn,
        """
        select c.id as claim_id, c.subject_id as company_id, c.value_text as number,
               c.value_json as detail, c.confidence, co.legal_name
        from public.claims c
        join public.companies co on co.id = c.subject_id
        where c.attribute = 'companies_house_number'
          and c.status = 'candidate'
          and c.confidence >= %s
        order by co.legal_name
        """,
        (min_score,),
    )
    stats = {"eligible": len(rows), "identified": 0, "sectors": 0, "profiles": 0}
    if dry_run or not rows:
        for row in rows[:40]:
            print(f"  {row['legal_name'][:34]:34s} -> {row['number']}  {row['confidence']}")
        if dry_run:
            print(f"\n  dry run — {len(rows)} would be accepted at >= {min_score}")
        return stats

    ch = CompaniesHouse()
    try:
        for row in rows:
            db.execute(
                conn,
                """
                insert into public.company_identifiers (company_id, scheme, value, is_primary)
                values (%s, 'companies_house', %s, true)
                on conflict (scheme, value) do nothing
                """,
                (row["company_id"], row["number"]),
            )
            stats["identified"] += 1

            profile = ch.profile(row["number"])
            if not profile:
                conn.commit()
                continue
            stats["profiles"] += 1

            db.execute(
                conn,
                """
                update public.companies
                   set country_code = coalesce(country_code, 'GB'),
                       founded_year = coalesce(founded_year, %s),
                       is_dissolved = %s,
                       updated_at = now()
                 where id = %s
                """,
                (int(profile["date_of_creation"][:4])
                 if profile.get("date_of_creation") else None,
                 (profile.get("company_status") or "").lower() == "dissolved",
                 row["company_id"]),
            )

            for code in profile.get("sic_codes") or []:
                sector_id = db.scalar(
                    conn,
                    """
                    insert into public.sectors (taxonomy, code, name, depth)
                    values ('sic', %s, %s, 1)
                    on conflict (taxonomy, code) do update set code = excluded.code
                    returning id
                    """,
                    (code, f"SIC {code}"),
                )
                db.execute(
                    conn,
                    """
                    insert into public.company_sectors (company_id, sector_id, weight)
                    values (%s, %s, 1.000)
                    on conflict (company_id, sector_id) do nothing
                    """,
                    (row["company_id"], sector_id),
                )
                stats["sectors"] += 1

            db.execute(conn, "update public.claims set status = 'accepted' where id = %s",
                       (row["claim_id"],))
            conn.commit()
    finally:
        ch.close()
    return stats
