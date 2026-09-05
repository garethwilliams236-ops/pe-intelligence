"""Database access for the crawler. Thin psycopg wrapper — no ORM."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row


def dsn() -> str:
    url = os.environ.get("SUPABASE_DB_URL")
    if not url:
        raise SystemExit(
            "SUPABASE_DB_URL is not set.\n"
            "Use the session pooler, not the direct host:\n"
            "  postgresql://postgres.<ref>:<password>"
            "@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"
        )
    return url


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    with psycopg.connect(dsn(), row_factory=dict_row, autocommit=False) as conn:
        yield conn


def one(conn: psycopg.Connection, sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def all_rows(conn: psycopg.Connection, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def execute(conn: psycopg.Connection, sql: str, params: tuple = ()) -> None:
    with conn.cursor() as cur:
        cur.execute(sql, params)


def scalar(conn: psycopg.Connection, sql: str, params: tuple = ()) -> Any:
    row = one(conn, sql, params)
    return None if row is None else next(iter(row.values()))


def source_id(conn: psycopg.Connection, code: str) -> str:
    value = scalar(conn, "select id from public.sources where code = %s", (code,))
    if value is None:
        raise SystemExit(f"source '{code}' is missing — has migration 0006 been applied?")
    return value


# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------
def due_targets(conn: psycopg.Connection, limit: int, only_enabled: bool = True) -> list[dict]:
    return all_rows(
        conn,
        f"""
        select t.*, c.legal_name, c.country_code
        from public.crawl_targets t
        left join public.companies c on c.id = t.company_id
        where ({'t.is_enabled' if only_enabled else 'true'})
          and (t.next_run_at is null or t.next_run_at <= now())
        order by t.next_run_at nulls first, t.label
        limit %s
        """,
        (limit,),
    )


def target_by_domain(conn: psycopg.Connection, domain: str) -> dict | None:
    return one(
        conn,
        """
        select t.*, c.legal_name, c.country_code
        from public.crawl_targets t
        left join public.companies c on c.id = t.company_id
        where t.domain = %s and t.target_kind = 'sponsor_root'
        limit 1
        """,
        (domain,),
    )


def mark_target_run(conn: psycopg.Connection, target_id: str, hours: int) -> None:
    execute(
        conn,
        """
        update public.crawl_targets
           set last_run_at = now(),
               next_run_at = now() + make_interval(hours => %s)
         where id = %s
        """,
        (hours, target_id),
    )


# ---------------------------------------------------------------------------
# Runs and items
# ---------------------------------------------------------------------------
def start_run(conn: psycopg.Connection, target_id: str | None, triggered_by: str) -> str:
    return scalar(
        conn,
        """
        insert into public.crawl_runs (target_id, status, triggered_by)
        values (%s, 'fetching', %s)
        returning id
        """,
        (target_id, triggered_by),
    )


def finish_run(conn: psycopg.Connection, run_id: str, status: str, stats: dict,
               error: str | None = None) -> None:
    execute(
        conn,
        """
        update public.crawl_runs
           set finished_at = now(), status = %s,
               urls_seen = %s, urls_fetched = %s, urls_unchanged = %s,
               documents_created = %s, claims_created = %s, error_message = %s
         where id = %s
        """,
        (status, stats.get("seen", 0), stats.get("fetched", 0), stats.get("unchanged", 0),
         stats.get("documents", 0), stats.get("claims", 0), error, run_id),
    )


def record_item(conn: psycopg.Connection, run_id: str, url: str, normalised: str, depth: int,
                status: str, http_status: int | None = None, content_hash: str | None = None,
                document_id: str | None = None, error: str | None = None) -> None:
    execute(
        conn,
        """
        insert into public.crawl_items
            (run_id, url, normalised_url, depth, status, http_status,
             content_hash, document_id, fetched_at, error_message)
        values (%s, %s, %s, %s, %s, %s, %s, %s, now(), %s)
        on conflict (run_id, normalised_url) do nothing
        """,
        (run_id, url, normalised, depth, status, http_status, content_hash, document_id, error),
    )


# ---------------------------------------------------------------------------
# Domains (politeness state lives in the database so runs share it)
# ---------------------------------------------------------------------------
def domain_state(conn: psycopg.Connection, domain: str) -> dict:
    execute(conn, "insert into public.crawl_domains (domain) values (%s) on conflict do nothing",
            (domain,))
    return one(conn, "select * from public.crawl_domains where domain = %s", (domain,))


def save_robots(conn: psycopg.Connection, domain: str, robots_txt: str | None,
                allowed: bool, crawl_delay_ms: int) -> None:
    execute(
        conn,
        """
        update public.crawl_domains
           set robots_txt = %s, robots_checked_at = now(),
               is_allowed = %s, crawl_delay_ms = %s
         where domain = %s
        """,
        (robots_txt, allowed, crawl_delay_ms, domain),
    )


def touch_domain(conn: psycopg.Connection, domain: str, ok: bool) -> None:
    if ok:
        execute(conn,
                "update public.crawl_domains set last_fetch_at = now(),"
                " consecutive_failures = 0, backoff_until = null where domain = %s",
                (domain,))
    else:
        execute(conn,
                "update public.crawl_domains"
                "   set last_fetch_at = now(),"
                "       consecutive_failures = consecutive_failures + 1,"
                "       backoff_until = now() + make_interval("
                "         mins => least(60, power(2, consecutive_failures + 1)::int))"
                " where domain = %s",
                (domain,))


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------
def find_document(conn: psycopg.Connection, url: str, content_hash: str) -> str | None:
    return scalar(
        conn,
        """
        select id from public.documents
        where coalesce(canonical_url, url) = %s and content_hash = %s
        limit 1
        """,
        (url, content_hash),
    )


def insert_document(conn: psycopg.Connection, *, source_id: str, url: str, canonical_url: str,
                    title: str | None, http_status: int, content_type: str | None,
                    content_hash: str, text: str, byte_size: int) -> str:
    return scalar(
        conn,
        """
        insert into public.documents
            (source_id, url, canonical_url, title, retrieved_at, http_status,
             content_type, content_hash, extracted_text, byte_size, licence_class)
        values (%s, %s, %s, %s, now(), %s, %s, %s, %s, %s, 'public_attributable')
        returning id
        """,
        (source_id, url, canonical_url, title, http_status, content_type,
         content_hash, text, byte_size),
    )


def unextracted_documents(conn: psycopg.Connection, limit: int, extractor: str) -> list[dict]:
    return all_rows(
        conn,
        """
        select d.id, d.url, d.canonical_url, d.title, d.extracted_text
        from public.documents d
        join public.crawl_items ci on ci.document_id = d.id
        where not exists (
            select 1 from public.extraction_runs er
            where er.document_id = d.id and er.extractor = %s and er.status = 'ok')
        order by d.retrieved_at desc
        limit %s
        """,
        (extractor, limit),
    )


# ---------------------------------------------------------------------------
# Extraction and claims
# ---------------------------------------------------------------------------
def start_extraction(conn: psycopg.Connection, document_id: str, extractor: str,
                     model: str | None, prompt_version: str) -> str:
    return scalar(
        conn,
        """
        insert into public.extraction_runs
            (document_id, extractor, model, prompt_version, status)
        values (%s, %s, %s, %s, 'running')
        returning id
        """,
        (document_id, extractor, model, prompt_version),
    )


def finish_extraction(conn: psycopg.Connection, run_id: str, status: str, claims: int,
                      error: str | None = None, cost: float | None = None) -> None:
    execute(
        conn,
        """
        update public.extraction_runs
           set finished_at = now(), status = %s, claims_created = %s,
               error_message = %s, cost_usd = %s
         where id = %s
        """,
        (status, claims, error, cost, run_id),
    )


def insert_claim(conn: psycopg.Connection, *, subject_table: str, subject_id: str | None,
                 subject_key: str | None, attribute: str, value_text: str | None,
                 value_json: Any, confidence: float, extracted_by: str,
                 extraction_version: str, document_id: str, quote: str | None) -> bool:
    """Insert a claim plus its evidence link. Returns False if already present."""
    existing = scalar(
        conn,
        """
        select id from public.claims
        where subject_table = %s
          and subject_id is not distinct from %s
          and attribute = %s
          and value_text is not distinct from %s
        limit 1
        """,
        (subject_table, subject_id, attribute, value_text),
    )
    if existing:
        return False

    claim_id = scalar(
        conn,
        """
        insert into public.claims
            (subject_table, subject_id, subject_key, attribute, value_text, value_json,
             status, confidence, licence_class, extracted_by, extraction_version)
        values (%s, %s, %s, %s, %s, %s, 'candidate', %s, 'public_attributable', %s, %s)
        returning id
        """,
        (subject_table, subject_id, subject_key, attribute, value_text,
         psycopg.types.json.Json(value_json) if value_json is not None else None,
         confidence, extracted_by, extraction_version),
    )
    execute(
        conn,
        """
        insert into public.claim_evidence (claim_id, document_id, quote)
        values (%s, %s, %s)
        on conflict do nothing
        """,
        (claim_id, document_id, (quote or "")[:2000] or None),
    )
    return True
