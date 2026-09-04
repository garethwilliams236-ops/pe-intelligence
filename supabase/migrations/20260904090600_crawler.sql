-- =====================================================================
-- pe-intelligence :: 0007 crawler control plane
-- =====================================================================

-- Politeness is per-domain, not per-target: several seeds may share a host.
create table public.crawl_domains (
  domain            text primary key,
  is_allowed        boolean not null default true,
  robots_checked_at timestamptz,
  robots_txt        text,
  crawl_delay_ms    int not null default 2000 check (crawl_delay_ms >= 0),
  max_rps           numeric(6,3) not null default 0.5,
  last_fetch_at     timestamptz,
  consecutive_failures int not null default 0,
  backoff_until     timestamptz,
  notes             text
);

-- A seed: what we crawl and how often.
create table public.crawl_targets (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references public.sources(id) on delete cascade,
  company_id        uuid references public.companies(id) on delete cascade,
  label             text not null,
  start_url         text not null,
  domain            text references public.crawl_domains(domain) on delete set null,
  target_kind       text not null,   -- 'portfolio_index' | 'team_page' | 'news_index'
                                     -- | 'filing_index' | 'deal_page' | 'sitemap'
  url_include_regex text,
  url_exclude_regex text,
  max_depth         int not null default 2 check (max_depth between 0 and 6),
  frequency_hours   int not null default 168,
  is_enabled        boolean not null default true,
  last_run_at       timestamptz,
  next_run_at       timestamptz default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.crawl_targets (next_run_at) where is_enabled;
create index on public.crawl_targets (company_id);
create index on public.crawl_targets (source_id);

create trigger crawl_targets_set_updated_at
  before update on public.crawl_targets
  for each row execute function public.set_updated_at();

create table public.crawl_runs (
  id                uuid primary key default gen_random_uuid(),
  target_id         uuid references public.crawl_targets(id) on delete set null,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            public.crawl_status not null default 'queued',
  urls_seen         int not null default 0,
  urls_fetched      int not null default 0,
  urls_unchanged    int not null default 0,
  documents_created int not null default 0,
  claims_created    int not null default 0,
  error_message     text,
  triggered_by      text not null default 'schedule'   -- schedule | manual | backfill
);

create index on public.crawl_runs (target_id, started_at desc);
create index on public.crawl_runs (status) where finished_at is null;

create table public.crawl_items (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references public.crawl_runs(id) on delete cascade,
  url               text not null,
  normalised_url    text not null,
  depth             int not null default 0,
  status            public.crawl_status not null default 'queued',
  http_status       int,
  content_hash      text,
  document_id       uuid references public.documents(id) on delete set null,
  fetched_at        timestamptz,
  error_message     text,
  created_at        timestamptz not null default now()
);

create index on public.crawl_items (run_id, status);
create unique index crawl_items_run_url_uniq on public.crawl_items (run_id, normalised_url);
create index on public.crawl_items (normalised_url);

-- ---------------------------------------------------------------------
-- Extraction runs: what turned a document into claims, at what cost.
-- Keeping model + prompt version here is what lets you re-extract only
-- the documents processed by a version you have since improved.
-- ---------------------------------------------------------------------
create table public.extraction_runs (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.documents(id) on delete cascade,
  extractor          text not null,          -- 'llm' | 'ch_ixbrl' | 'regex_v1'
  model              text,
  prompt_version     text,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  claims_created     int not null default 0,
  input_tokens       int,
  output_tokens      int,
  cost_usd           numeric(12,6),
  status             text not null default 'running',   -- running | ok | failed
  error_message      text
);

create index on public.extraction_runs (document_id);
create index on public.extraction_runs (extractor, prompt_version);

-- ---------------------------------------------------------------------
-- Licensed feed imports, kept apart from the crawl so provenance and
-- contractual scope are never blurred.
-- ---------------------------------------------------------------------
create table public.feed_imports (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references public.sources(id) on delete restrict,
  file_name         text,
  storage_path      text,
  period_covered    daterange,
  rows_received     int not null default 0,
  rows_loaded       int not null default 0,
  rows_rejected     int not null default 0,
  imported_by       uuid references public.profiles(id) on delete set null,
  imported_at       timestamptz not null default now(),
  notes             text
);

create index on public.feed_imports (source_id, imported_at desc);
