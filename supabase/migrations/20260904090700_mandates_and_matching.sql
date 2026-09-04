-- =====================================================================
-- pe-intelligence :: 0008 clients, mandates, the ranking engine, reports
-- =====================================================================

create table public.clients (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.companies(id) on delete set null,
  name              text not null,
  relationship_owner uuid references public.profiles(id) on delete set null,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.clients (company_id);

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Mandates. The criteria columns are the input vector to the ranking
-- engine; they are captured explicitly rather than inferred so that a
-- ranking can be reproduced exactly months later.
-- ---------------------------------------------------------------------
create table public.mandates (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients(id) on delete cascade,
  subject_company_id    uuid references public.companies(id) on delete set null,
  code                  text unique,
  name                  text not null,
  mandate_type          text not null default 'sell_side',   -- sell_side | buy_side
                                                             -- | growth_capital | debt | strategic_review
  status                text not null default 'live',        -- pitch | live | on_hold | closed | aborted
  -- target profile
  sector_id             uuid references public.sectors(id) on delete set null,
  country_code          char(2) references public.countries(code),
  target_regions        text[],
  revenue_gbp           numeric(20,2),
  ebitda_gbp            numeric(20,2),
  expected_ev_gbp       numeric(20,2),
  expected_ev_low_gbp   numeric(20,2),
  expected_ev_high_gbp  numeric(20,2),
  stake_for_sale_pct    numeric(6,3) check (stake_for_sale_pct between 0 and 100),
  preferred_deal_types  public.deal_type[],
  management_rollover   boolean,
  buy_and_build_story   boolean,
  business_description  text,
  description_embedding extensions.vector(1536),
  -- houses the client will not talk to, honoured as a hard filter
  excluded_investor_ids uuid[] not null default '{}',
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index on public.mandates (client_id);
create index on public.mandates (status) where status = 'live';
create index on public.mandates (sector_id);

create trigger mandates_set_updated_at
  before update on public.mandates
  for each row execute function public.set_updated_at();

-- Deal-team membership is the RLS gate for everything client-confidential.
create table public.mandate_team (
  mandate_id  uuid not null references public.mandates(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  team_role   text not null default 'member',   -- lead | member | observer
  added_at    timestamptz not null default now(),
  primary key (mandate_id, user_id)
);

create index on public.mandate_team (user_id);

-- ---------------------------------------------------------------------
-- Ranking runs. Weights are versioned per run so a top-20 that went to
-- a client can be defended and reproduced, even after the model moves.
-- ---------------------------------------------------------------------
create table public.match_runs (
  id                uuid primary key default gen_random_uuid(),
  mandate_id        uuid not null references public.mandates(id) on delete cascade,
  algorithm_version text not null,
  parameters        jsonb not null default '{}',
  candidate_count   int not null default 0,
  returned_count    int not null default 0,
  run_by            uuid references public.profiles(id) on delete set null,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running',   -- running | ok | failed
  error_message     text,
  is_current        boolean not null default false
);

create index on public.match_runs (mandate_id, started_at desc);
create unique index match_runs_one_current
  on public.match_runs (mandate_id) where is_current;

create table public.match_run_weights (
  run_id      uuid not null references public.match_runs(id) on delete cascade,
  signal      public.match_signal not null,
  weight      numeric(6,4) not null,
  primary key (run_id, signal)
);

create table public.investor_matches (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.match_runs(id) on delete cascade,
  investor_company_id uuid not null references public.investors(company_id) on delete cascade,
  fund_id             uuid references public.funds(id) on delete set null,
  rank                int not null,
  total_score         numeric(8,4) not null,
  score_breakdown     jsonb not null default '{}',
  headline_rationale  text,
  is_shortlisted      boolean not null default false,
  analyst_override_rank int,
  analyst_note        text,
  created_at          timestamptz not null default now(),
  unique (run_id, investor_company_id)
);

create index on public.investor_matches (run_id, rank);
create index on public.investor_matches (investor_company_id);

-- The "why". One row per contributing signal, each pointing at the deals
-- and evidence that justify it, so the report cites rather than asserts.
create table public.investor_match_reasons (
  id                  uuid primary key default gen_random_uuid(),
  match_id            uuid not null references public.investor_matches(id) on delete cascade,
  signal              public.match_signal not null,
  raw_score           numeric(8,4) not null,
  weight              numeric(6,4) not null,
  weighted_score      numeric(8,4) generated always as (raw_score * weight) stored,
  narrative           text,
  supporting_deal_ids       uuid[] not null default '{}',
  supporting_investment_ids uuid[] not null default '{}',
  supporting_person_ids     uuid[] not null default '{}',
  supporting_claim_ids      uuid[] not null default '{}',
  min_licence_class   public.licence_class not null default 'public_attributable',
  created_at          timestamptz not null default now(),
  unique (match_id, signal)
);

create index on public.investor_match_reasons (match_id);

-- Named approach point for each shortlisted house.
create table public.investor_match_contacts (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references public.investor_matches(id) on delete cascade,
  person_id     uuid not null references public.people(id) on delete cascade,
  reason        text,          -- 'led comparable deal', 'sector partner', ...
  is_primary    boolean not null default false,
  unique (match_id, person_id)
);

create index on public.investor_match_contacts (person_id);

-- Outcome capture. This is the only way the ranking ever gets better.
create table public.mandate_investor_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  mandate_id          uuid not null references public.mandates(id) on delete cascade,
  investor_company_id uuid not null references public.investors(company_id) on delete cascade,
  stage               text not null,   -- approached | nda | ioi | management_meeting
                                       -- | lp_offer | declined | selected | completed
  outcome_date        date,
  declined_reason     text,
  notes               text,
  recorded_by         uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (mandate_id, investor_company_id, stage)
);

create index on public.mandate_investor_outcomes (mandate_id);
create index on public.mandate_investor_outcomes (investor_company_id, stage);

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
create table public.reports (
  id                uuid primary key default gen_random_uuid(),
  mandate_id        uuid not null references public.mandates(id) on delete cascade,
  run_id            uuid references public.match_runs(id) on delete set null,
  title             text not null,
  version           int not null default 1,
  status            public.report_status not null default 'draft',
  format            text not null default 'pdf',   -- pdf | docx | pptx | html
  storage_bucket    text default 'reports',
  storage_path      text,
  -- a client-facing report may only contain redistributable facts
  allows_licensed_data boolean not null default false,
  generated_by      uuid references public.profiles(id) on delete set null,
  generated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (mandate_id, version, format)
);

create index on public.reports (mandate_id, version desc);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();
