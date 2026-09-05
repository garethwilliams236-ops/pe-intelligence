"""Crawler CLI.

    python -m crawler.run probe --url https://www.inflexion.com
    python -m crawler.run probe --limit 5
    python -m crawler.run crawl --limit 20
    python -m crawler.run extract --llm --limit 50
    python -m crawler.run status

`probe` writes nothing. Run it first on a new site: it prints exactly what the
discoverer and extractor found, which is the only honest way to know whether
the heuristics work on a given sponsor's site.
"""

from __future__ import annotations

import argparse
import sys
import traceback

from . import db, extract
from .discover import index_pages
from .fetch import Fetcher, domain_of, normalise_url

KIND_TO_ATTRIBUTE = {
    "portfolio_index": "portfolio_company",
    "team_index": "team_member",
    "news_index": "news_item",
}


# ---------------------------------------------------------------------------
# probe — no database writes
# ---------------------------------------------------------------------------
def cmd_probe(args) -> int:
    urls: list[tuple[str, str | None]] = []
    if args.url:
        urls.append((normalise_url(args.url), None))
    else:
        with db.connect() as conn:
            if args.domain:
                target = db.target_by_domain(conn, args.domain)
                if not target:
                    print(f"no crawl_target for domain {args.domain}")
                    return 1
                urls.append((target["start_url"], target["legal_name"]))
            else:
                for target in db.due_targets(conn, args.limit, only_enabled=not args.any):
                    urls.append((target["start_url"], target["legal_name"]))

    if not urls:
        print("nothing to probe — no enabled targets are due. Try --any or --url.")
        return 1

    fetcher = Fetcher(verbose=True)
    try:
        for start_url, name in urls:
            print("=" * 74)
            print(f"{name or ''}  {start_url}")
            root = fetcher.get(start_url)
            if root is None:
                print("  root page unavailable")
                continue
            print(f"  root ok  title={root.title!r}")

            candidates = index_pages(root.html, root.canonical_url)
            if not candidates:
                print("  no index pages discovered")
                continue
            for candidate in sorted(candidates, key=lambda c: -c.score):
                print(f"  [{candidate.score:2d}] {candidate.kind:16s} {candidate.url}")
                if candidate.kind not in KIND_TO_ATTRIBUTE:
                    continue
                page = fetcher.get(candidate.url)
                if page is None:
                    print("        (unavailable)")
                    continue
                found = extract.run_heuristic(candidate.kind, page.html, page.canonical_url)
                print(f"        heuristic found {len(found.items)}")
                for item in found.items[:8]:
                    if found.kind == "portfolio_company":
                        bits = [item["name"]]
                        if item.get("entry_year"):
                            bits.append(str(item["entry_year"]))
                        if item.get("status"):
                            bits.append(item["status"])
                        print("          - " + "  ".join(bits))
                    else:
                        print(f"          - {item['name']}"
                              f"{' — ' + item['title'] if item.get('title') else ''}")
                if len(found.items) > 8:
                    print(f"          ... and {len(found.items) - 8} more")
    finally:
        fetcher.close()
    return 0


# ---------------------------------------------------------------------------
# crawl — fetch, store, extract heuristically
# ---------------------------------------------------------------------------
def _store_and_extract(conn, fetcher, run_id, source, target, page, kind, depth, stats):
    """Store the page and extract from it. Returns (document_id, Extracted|None)."""
    existing = db.find_document(conn, page.canonical_url, page.content_hash)
    if existing:
        stats["unchanged"] += 1
        db.record_item(conn, run_id, page.url, page.canonical_url, depth,
                       "unchanged", page.status, page.content_hash, existing)
        # Still extract, even though the page has not changed. Claims are
        # deduped on insert, and a later pass (detail pages, a better
        # extractor) must be able to work from pages already stored.
        if kind in KIND_TO_ATTRIBUTE and target.get("company_id"):
            return existing, extract.run_heuristic(kind, page.html, page.canonical_url)
        return existing, None

    document_id = db.insert_document(
        conn, source_id=source, url=page.url, canonical_url=page.canonical_url,
        title=page.title, http_status=page.status, content_type=page.content_type,
        content_hash=page.content_hash, text=page.text, byte_size=page.byte_size)
    stats["documents"] += 1
    db.record_item(conn, run_id, page.url, page.canonical_url, depth,
                   "parsed", page.status, page.content_hash, document_id)

    if kind not in KIND_TO_ATTRIBUTE or not target.get("company_id"):
        return document_id, None

    found = extract.run_heuristic(kind, page.html, page.canonical_url)
    if not found.items:
        return document_id, found
    extraction_id = db.start_extraction(conn, document_id, "heuristic", None, extract.VERSION)
    written = 0
    for item in found.items:
        if db.insert_claim(
            conn,
            subject_table="investors",
            subject_id=target["company_id"],
            subject_key=None,
            attribute=found.kind,
            value_text=item["name"],
            value_json=item,
            confidence=0.550,
            extracted_by="heuristic",
            extraction_version=extract.VERSION,
            document_id=document_id,
            quote=item.get("context") or item.get("title"),
        ):
            written += 1
    db.finish_extraction(conn, extraction_id, "ok", written)
    stats["claims"] += written
    return document_id, found


def _crawl_details(conn, fetcher, run_id, source, target, items, limit, stats, verbose):
    """Fetch each portfolio company's own page for the dates the index omits.

    The pilot found zero years across 365 index-page claims: sponsors publish the
    investment date on the company page, not the grid. One fetch per company is
    the cost of having dates at all.
    """
    done = 0
    for item in items:
        if done >= limit:
            break
        url = item.get("url")
        if not url:
            continue
        page = fetcher.get(url)
        stats["seen"] += 1
        if page is None:
            continue
        stats["fetched"] += 1
        done += 1

        # An unchanged page still gets extracted: the extractor improves over
        # time and must be able to re-derive claims from pages already stored.
        # Claims dedupe on insert, so repeating this is free.
        existing = db.find_document(conn, page.canonical_url, page.content_hash)
        if existing:
            stats["unchanged"] += 1
            document_id = existing
            db.record_item(conn, run_id, page.url, page.canonical_url, 2,
                           "unchanged", page.status, page.content_hash, existing)
        else:
            document_id = db.insert_document(
                conn, source_id=source, url=page.url, canonical_url=page.canonical_url,
                title=page.title, http_status=page.status, content_type=page.content_type,
                content_hash=page.content_hash, text=page.text, byte_size=page.byte_size)
            stats["documents"] += 1
            db.record_item(conn, run_id, page.url, page.canonical_url, 2,
                           "parsed", page.status, page.content_hash, document_id)

        facts = extract.detail(page.text, page.title)
        if not any([facts["entry_year"], facts["exit_year"], facts["status"], facts["sector"]]):
            continue
        facts["url"] = page.canonical_url
        facts["company"] = item["name"]
        extraction_id = db.start_extraction(conn, document_id, "heuristic_detail",
                                            None, extract.VERSION)
        # Labelled dates are worth more than a bare year found on the page.
        confidence = 0.700 if facts.get("date_confidence") == "labelled" else 0.450
        wrote = db.insert_claim(
            conn, subject_table="investors", subject_id=target["company_id"],
            subject_key=None, attribute="portfolio_company_dates",
            value_text=item["name"], value_json=facts, confidence=confidence,
            extracted_by="heuristic_detail", extraction_version=extract.VERSION,
            document_id=document_id, quote=facts.get("evidence"))
        db.finish_extraction(conn, extraction_id, "ok", 1 if wrote else 0)
        if wrote:
            stats["claims"] += 1
        if verbose:
            print(f"      {item['name'][:34]:34s} "
                  f"{facts['entry_year'] or '----'} -> {facts['exit_year'] or '----'} "
                  f"{facts.get('date_confidence') or ''}")


def cmd_crawl(args) -> int:
    fetcher = Fetcher(verbose=args.verbose)
    processed = 0
    try:
        with db.connect() as conn:
            source = db.source_id(conn, "sponsor_site")
            targets = db.due_targets(conn, args.limit)
            if not targets:
                print("no enabled targets are due")
                return 0
            print(f"{len(targets)} target(s) due")

            for target in targets:
                stats = {"seen": 0, "fetched": 0, "unchanged": 0, "documents": 0, "claims": 0}
                run_id = db.start_run(conn, target["id"], args.triggered_by)
                conn.commit()
                label = target.get("legal_name") or target["label"]
                print(f"\n-- {label}  {target['start_url']}")
                try:
                    domain = target.get("domain") or domain_of(target["start_url"])
                    state = db.domain_state(conn, domain)
                    if state and state.get("is_allowed") is False:
                        db.finish_run(conn, run_id, "blocked", stats, "domain marked disallowed")
                        conn.commit()
                        continue

                    _, delay, robots_body = fetcher.robots_for(target["start_url"])
                    if robots_body is not None:
                        db.save_robots(conn, domain, robots_body,
                                       fetcher.allowed(target["start_url"]), delay)

                    root = fetcher.get(target["start_url"])
                    stats["seen"] += 1
                    if root is None:
                        db.touch_domain(conn, domain, ok=False)
                        db.record_item(conn, run_id, target["start_url"],
                                       normalise_url(target["start_url"]), 0, "failed",
                                       error="root fetch failed or disallowed")
                        db.finish_run(conn, run_id, "failed", stats, "root fetch failed")
                        conn.commit()
                        continue
                    stats["fetched"] += 1
                    db.touch_domain(conn, domain, ok=True)
                    _store_and_extract(conn, fetcher, run_id, source, target, root,
                                       "root", 0, stats)

                    for candidate in index_pages(root.html, root.canonical_url):
                        if candidate.kind not in KIND_TO_ATTRIBUTE:
                            continue
                        stats["seen"] += 1
                        page = fetcher.get(candidate.url)
                        if page is None:
                            db.record_item(conn, run_id, candidate.url,
                                           normalise_url(candidate.url), 1, "failed")
                            continue
                        stats["fetched"] += 1
                        _, found = _store_and_extract(conn, fetcher, run_id, source,
                                                      target, page, candidate.kind, 1, stats)
                        if (args.details and found
                                and found.kind == "portfolio_company" and found.items):
                            _crawl_details(conn, fetcher, run_id, source, target,
                                           found.items, args.details, stats, args.verbose)

                    db.finish_run(conn, run_id, "parsed", stats)
                    db.mark_target_run(conn, target["id"], target["frequency_hours"])
                    conn.commit()
                    print(f"   fetched {stats['fetched']}  new docs {stats['documents']}"
                          f"  unchanged {stats['unchanged']}  claims {stats['claims']}")
                    processed += 1
                except Exception as exc:
                    conn.rollback()
                    db.finish_run(conn, run_id, "failed", stats, f"{type(exc).__name__}: {exc}")
                    conn.commit()
                    print(f"   FAILED {type(exc).__name__}: {exc}")
                    if args.verbose:
                        traceback.print_exc()
    finally:
        fetcher.close()
    print(f"\ndone — {processed} target(s) completed")
    return 0


# ---------------------------------------------------------------------------
# extract — re-run over stored documents
# ---------------------------------------------------------------------------
def cmd_extract(args) -> int:
    if not args.llm:
        print("nothing to do: heuristic extraction already runs during crawl.\n"
              "Pass --llm to re-process stored pages the heuristic could not read.")
        return 0
    with db.connect() as conn:
        documents = db.unextracted_documents(conn, args.limit, "llm")
        print(f"{len(documents)} document(s) without an LLM extraction")
        total = 0
        for document in documents:
            kind = ("portfolio_index" if "portfolio" in (document["canonical_url"] or "")
                    else "team_index")
            extraction_id = db.start_extraction(conn, document["id"], "llm",
                                                extract.LLM_MODEL, extract.VERSION)
            try:
                found = extract.run_llm(kind, document["extracted_text"] or "")
            except Exception as exc:
                db.finish_extraction(conn, extraction_id, "failed", 0, str(exc)[:500])
                conn.commit()
                print(f"  FAILED {document['canonical_url']}: {exc}")
                continue
            if found.method.startswith("llm-unavailable"):
                db.finish_extraction(conn, extraction_id, "failed", 0, "no ANTHROPIC_API_KEY")
                conn.commit()
                print("  ANTHROPIC_API_KEY is not set — stopping.")
                return 1
            subject = db.scalar(
                conn,
                """
                select t.company_id
                from public.crawl_items ci
                join public.crawl_runs r on r.id = ci.run_id
                join public.crawl_targets t on t.id = r.target_id
                where ci.document_id = %s limit 1
                """,
                (document["id"],),
            )
            written = 0
            for item in found.items:
                if db.insert_claim(
                    conn, subject_table="investors", subject_id=subject, subject_key=None,
                    attribute=found.kind, value_text=str(item.get("name")), value_json=item,
                    confidence=0.650, extracted_by="llm",
                    extraction_version=extract.VERSION, document_id=document["id"],
                    quote=None,
                ):
                    written += 1
            db.finish_extraction(conn, extraction_id, "ok", written)
            conn.commit()
            total += written
            print(f"  {written:3d} claims  {document['canonical_url']}")
        print(f"\n{total} new claims")
    return 0



# ---------------------------------------------------------------------------
# survey — how extractable is each site? writes nothing
# ---------------------------------------------------------------------------
def cmd_survey(args) -> int:
    """Three-way verdict per site, because 'found nothing' has two causes.

    STATIC     the heuristic works here
    JS         the page is an empty shell; the list is rendered client-side and
               no amount of parsing or LLM will find text that is not there
    UNMATCHED  the content IS in the HTML but no section matched — a rule gap,
               and much cheaper to fix than JS rendering
    """
    from .discover import detail_links

    with db.connect() as conn:
        targets = db.due_targets(conn, args.limit, only_enabled=not args.any)
    if not targets:
        print("no targets — try --any")
        return 1

    fetcher = Fetcher()
    counts = {"STATIC": 0, "JS": 0, "UNMATCHED": 0, "UNUSABLE": 0}
    print(f"{'firm':30s} {'text':>7s} {'items':>6s}  verdict")
    try:
        for target in targets:
            name = (target.get("legal_name") or target["label"])[:29]
            try:
                root = fetcher.get(target["start_url"])
                if root is None:
                    print(f"{name:30s} {'-':>7s} {'-':>6s}  UNUSABLE (root unreachable)")
                    counts["UNUSABLE"] += 1
                    continue
                indexes = [c for c in index_pages(root.html, root.canonical_url)
                           if c.kind == "portfolio_index"]
                if not indexes:
                    print(f"{name:30s} {'-':>7s} {'-':>6s}  UNUSABLE (no portfolio page)")
                    counts["UNUSABLE"] += 1
                    continue
                page = fetcher.get(indexes[0].url)
                if page is None:
                    print(f"{name:30s} {'-':>7s} {'-':>6s}  UNUSABLE (portfolio unreachable)")
                    counts["UNUSABLE"] += 1
                    continue
                found = len(detail_links(page.html, page.canonical_url, "portfolio"))
                if found >= 3:
                    verdict = "STATIC"
                elif len(page.text) < 2000:
                    verdict = "JS"
                else:
                    verdict = "UNMATCHED"
                counts[verdict] += 1
                print(f"{name:30s} {len(page.text):7d} {found:6d}  {verdict}")
            except Exception as exc:
                counts["UNUSABLE"] += 1
                print(f"{name:30s} {'-':>7s} {'-':>6s}  UNUSABLE ({type(exc).__name__})")
    finally:
        fetcher.close()
    print("\n" + "   ".join(f"{k.lower()} {v}" for k, v in counts.items()))
    return 0


# ---------------------------------------------------------------------------
def cmd_status(args) -> int:
    with db.connect() as conn:
        for label, sql in [
            ("targets enabled", "select count(*) from public.crawl_targets where is_enabled"),
            ("targets total", "select count(*) from public.crawl_targets"),
            ("runs", "select count(*) from public.crawl_runs"),
            ("documents", "select count(*) from public.documents"),
            ("claims (crawler)",
             "select count(*) from public.claims where extracted_by in ('heuristic','llm')"),
            ("  portfolio_company",
             "select count(*) from public.claims where attribute = 'portfolio_company'"),
            ("  team_member",
             "select count(*) from public.claims where attribute = 'team_member'"),
        ]:
            print(f"{label:22s} {db.scalar(conn, sql)}")
        print("\nlast runs:")
        for row in db.all_rows(conn, """
            select coalesce(c.legal_name, t.label) as name, r.status, r.urls_fetched,
                   r.documents_created, r.claims_created, r.started_at::date as day
            from public.crawl_runs r
            left join public.crawl_targets t on t.id = r.target_id
            left join public.companies c on c.id = t.company_id
            order by r.started_at desc limit 15"""):
            print(f"  {row['day']}  {row['status']:9s} fetched={row['urls_fetched']:3d} "
                  f"docs={row['documents_created']:3d} claims={row['claims_created']:4d}  "
                  f"{row['name']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="crawler", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("probe", help="fetch and print findings, write nothing")
    p.add_argument("--url")
    p.add_argument("--domain")
    p.add_argument("--limit", type=int, default=3)
    p.add_argument("--any", action="store_true", help="include disabled targets")
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("crawl", help="fetch, store and extract")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--triggered-by", default="manual")
    p.add_argument("--details", type=int, default=0,
                   help="fetch up to N portfolio company pages per house for dates")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=cmd_crawl)

    p = sub.add_parser("extract", help="re-extract stored documents")
    p.add_argument("--llm", action="store_true")
    p.add_argument("--limit", type=int, default=25)
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("survey", help="classify sites as STATIC / JS / UNMATCHED")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--any", action="store_true", help="include disabled targets")
    p.set_defaults(func=cmd_survey)

    p = sub.add_parser("status", help="counts and recent runs")
    p.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
