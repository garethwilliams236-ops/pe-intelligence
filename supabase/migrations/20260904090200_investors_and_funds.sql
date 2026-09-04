-- =====================================================================
-- pe-intelligence :: 0003 sponsors, their mandate box, and their funds
-- =====================================================================

-- One row per company that behaves as an investor. Extension table so a
-- sponsor is still a single company for identity-resolution purposes.
create table public.investors (
  company_id            uuid primary key references public.companies(id) on delete cascade,
  aum_gbp               numeric(20,2),
  aum_as_at             date,
  team_size             int,
  hq_country_code       char(2) references public.countries(code),
  founded_year          int,
  -- The mandate box. NULL = unknown, and unknown must never score as a miss.
  min_ev_gbp            numeric(20,2),
  max_ev_gbp            numeric(20,2),
  min_ebitda_gbp        numeric(20,2),
  max_ebitda_gbp        numeric(20,2),
  min_equity_cheque_gbp numeric(20,2),
  max_equity_cheque_gbp numeric(20,2),
  takes_minority        boolean,
  takes_majority        boolean,
  does_buy_and_build    boolean,
  does_carve_outs       boolean,
  will_back_management  boolean,
  stated_thesis         text,
  thesis_embedding      extensions.vector(1536),
  is_active             boolean not null default true,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (max_ev_gbp is null or min_ev_gbp is null or max_ev_gbp >= min_ev_gbp),
  check (max_ebitda_gbp is null or min_ebitda_gbp is null or max_ebitda_gbp >= min_ebitda_gbp)
);

create index on public.investors (hq_country_code) where is_active;
create index on public.investors using hnsw (thesis_embedding extensions.vector_cosine_ops);

create trigger investors_set_updated_at
  before update on public.investors
  for each row execute function public.set_updated_at();

create table public.investor_strategies (
  company_id  uuid not null references public.investors(company_id) on delete cascade,
  strategy    public.investor_strategy not null,
  is_primary  boolean not null default false,
  primary key (company_id, strategy)
);

-- Stated sector focus. Distinct from revealed focus, which is derived
-- from the deal history in 0009 — the engine should weigh both.
create table public.investor_sector_focus (
  company_id  uuid not null references public.investors(company_id) on delete cascade,
  sector_id   uuid not null references public.sectors(id) on delete cascade,
  is_stated   boolean not null default true,
  weight      numeric(4,3) not null default 1.000 check (weight between 0 and 1),
  primary key (company_id, sector_id)
);

create index on public.investor_sector_focus (sector_id);

create table public.investor_geography_focus (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.investors(company_id) on delete cascade,
  country_code  char(2) references public.countries(code),
  region        text,
  is_stated     boolean not null default true,
  check (country_code is not null or region is not null)
);

-- Either axis may be null, so uniqueness needs a coalesced expression index.
create unique index investor_geography_focus_uniq
  on public.investor_geography_focus (company_id, coalesce(country_code, '--'), coalesce(region, '--'));
create index on public.investor_geography_focus (company_id);

-- ---------------------------------------------------------------------
-- Funds. Vintage + investment period is what tells you whether a house
-- can actually transact today — the single most under-used signal.
-- ---------------------------------------------------------------------
create table public.funds (
  id                      uuid primary key default gen_random_uuid(),
  investor_company_id     uuid not null references public.investors(company_id) on delete cascade,
  name                    text not null,
  name_key                text generated always as (public.normalise_name(name)) stored,
  fund_number             int,
  vintage_year            int check (vintage_year between 1900 and 2100),
  target_size             numeric(20,2),
  final_close_size        numeric(20,2),
  currency                char(3) not null default 'GBP',
  size_gbp                numeric(20,2),
  first_close_date        date,
  final_close_date        date,
  investment_period_ends  date,
  fund_life_ends          date,
  strategy                public.investor_strategy,
  is_investing            boolean,
  dry_powder_gbp          numeric(20,2),
  dry_powder_as_at        date,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index on public.funds (investor_company_id);
create index on public.funds (vintage_year);
create index on public.funds (investment_period_ends) where is_investing;
create unique index funds_uniq on public.funds (investor_company_id, name_key, coalesce(vintage_year, 0));

create trigger funds_set_updated_at
  before update on public.funds
  for each row execute function public.set_updated_at();
