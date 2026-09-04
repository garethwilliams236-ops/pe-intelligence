-- =====================================================================
-- pe-intelligence :: 0004 deals, participants, valuations, positions
-- =====================================================================

-- ---------------------------------------------------------------------
-- Deals. One row per transaction event. An entry, an add-on and an exit
-- are three deals; `investments` in this file stitches them into the
-- entry -> add-ons -> exit narrative.
-- ---------------------------------------------------------------------
create table public.deals (
  id                  uuid primary key default gen_random_uuid(),
  target_company_id   uuid references public.companies(id) on delete set null,
  deal_type           public.deal_type not null default 'other',
  status              public.deal_status not null default 'announced',
  announced_date      date,
  completed_date      date,
  effective_date      date generated always as (coalesce(completed_date, announced_date)) stored,
  country_code        char(2) references public.countries(code),
  headline            text,
  summary             text,
  is_add_on           boolean not null default false,
  parent_investment_id uuid,   -- FK added below, once investments exists
  is_competitive_process boolean,
  process_type        text,    -- 'auction' | 'bilateral' | 'dual_track' | 'accelerated'
  external_ref        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (completed_date is null or announced_date is null or completed_date >= announced_date)
);

create index on public.deals (target_company_id);
create index on public.deals (effective_date desc);
create index on public.deals (deal_type, status);
create index on public.deals (country_code);

create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

-- Who was on which side. Junction rather than buyer_id/seller_id columns,
-- because club deals and multi-vendor exits are the norm here.
create table public.deal_participants (
  id                uuid primary key default gen_random_uuid(),
  deal_id           uuid not null references public.deals(id) on delete cascade,
  company_id        uuid not null references public.companies(id) on delete cascade,
  fund_id           uuid references public.funds(id) on delete set null,
  role              public.participant_role not null,
  is_lead           boolean not null default false,
  stake_pct         numeric(6,3) check (stake_pct between 0 and 100),
  equity_gbp        numeric(20,2),
  created_at        timestamptz not null default now(),
  unique (deal_id, company_id, role)
);

create index on public.deal_participants (company_id, role);
create index on public.deal_participants (fund_id);
create index on public.deal_participants (deal_id);

create table public.deal_advisers (
  id                  uuid primary key default gen_random_uuid(),
  deal_id             uuid not null references public.deals(id) on delete cascade,
  adviser_company_id  uuid not null references public.companies(id) on delete cascade,
  side                public.adviser_side not null default 'unknown',
  mandate             public.adviser_mandate not null default 'other',
  created_at          timestamptz not null default now(),
  unique (deal_id, adviser_company_id, side, mandate)
);

create index on public.deal_advisers (adviser_company_id);
create index on public.deal_advisers (deal_id);

-- Individuals on the deal. This is what makes partner-level track record
-- and people-overlap scoring possible.
create table public.deal_people (
  id                  uuid primary key default gen_random_uuid(),
  deal_id             uuid not null references public.deals(id) on delete cascade,
  person_id           uuid not null references public.people(id) on delete cascade,
  acting_for_company_id uuid references public.companies(id) on delete set null,
  role                public.deal_person_role not null,
  is_lead             boolean not null default false,
  source_id           uuid,   -- FK added in 0006
  created_at          timestamptz not null default now(),
  unique (deal_id, person_id, role)
);

create index on public.deal_people (person_id);
create index on public.deal_people (acting_for_company_id);
create index on public.deal_people (deal_id);

-- ---------------------------------------------------------------------
-- Valuations. Deliberately many-per-deal: PitchBook, the press and the
-- filed accounts will disagree, and we keep all of them with provenance
-- rather than silently picking one.
-- ---------------------------------------------------------------------
create table public.deal_valuations (
  id                    uuid primary key default gen_random_uuid(),
  deal_id               uuid not null references public.deals(id) on delete cascade,
  currency              char(3) not null default 'GBP' check (char_length(currency) = 3),
  enterprise_value      numeric(20,2),
  equity_value          numeric(20,2),
  net_debt              numeric(20,2),
  equity_invested       numeric(20,2),
  debt_quantum          numeric(20,2),
  revenue_ltm           numeric(20,2),
  ebitda_ltm            numeric(20,2),
  ebitda_adjusted       numeric(20,2),
  ev_revenue_multiple   numeric(10,3),
  ev_ebitda_multiple    numeric(10,3),
  -- normalised for cross-country comparison
  fx_rate_to_gbp        numeric(18,8),
  enterprise_value_gbp  numeric(20,2),
  ebitda_ltm_gbp        numeric(20,2),
  as_at_date            date,
  basis                 public.filing_basis not null default 'estimated',
  is_disclosed          boolean not null default false,   -- false = estimated/rumoured
  is_preferred          boolean not null default false,   -- the row the UI shows
  source_id             uuid,                              -- FK added in 0006
  licence_class         public.licence_class not null default 'public_attributable',
  confidence            numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index on public.deal_valuations (deal_id);
create unique index deal_valuations_one_preferred
  on public.deal_valuations (deal_id) where is_preferred;
create index on public.deal_valuations (licence_class);

create trigger deal_valuations_set_updated_at
  before update on public.deal_valuations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Investments: the holding period. This is the table the whole product
-- hangs off — investor + fund + portfolio company, entry through exit.
-- ---------------------------------------------------------------------
create table public.investments (
  id                    uuid primary key default gen_random_uuid(),
  investor_company_id   uuid not null references public.investors(company_id) on delete cascade,
  fund_id               uuid references public.funds(id) on delete set null,
  portfolio_company_id  uuid not null references public.companies(id) on delete cascade,
  entry_deal_id         uuid references public.deals(id) on delete set null,
  exit_deal_id          uuid references public.deals(id) on delete set null,
  entry_date            date,
  exit_date             date,
  status                public.investment_status not null default 'unknown',
  is_lead               boolean not null default false,
  entry_stake_pct       numeric(6,3) check (entry_stake_pct between 0 and 100),
  exit_stake_pct        numeric(6,3) check (exit_stake_pct between 0 and 100),
  -- returns, where they can be evidenced at all
  equity_invested_gbp   numeric(20,2),
  realised_proceeds_gbp numeric(20,2),
  moic                  numeric(10,3),
  gross_irr_pct         numeric(8,3),
  -- Realised hold only. Current (unrealised) hold is computed in the
  -- v_investments view in 0009, because current_date is not immutable
  -- and so cannot appear in a stored generated column.
  hold_period_months    int generated always as (
                          case
                            when entry_date is null or exit_date is null then null
                            -- explicit ::timestamp so the IMMUTABLE overload of
                            -- age() is chosen; the timestamptz one is only STABLE
                            else (extract(year  from age(exit_date::timestamp, entry_date::timestamp)) * 12
                               +  extract(month from age(exit_date::timestamp, entry_date::timestamp)))::int
                          end
                        ) stored,
  source_id             uuid,   -- FK added in 0006
  licence_class         public.licence_class not null default 'public_attributable',
  confidence            numeric(4,3) not null default 0.700 check (confidence between 0 and 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (exit_date is null or entry_date is null or exit_date >= entry_date)
);

create unique index investments_uniq
  on public.investments (investor_company_id, portfolio_company_id, coalesce(entry_date, '1900-01-01'::date));
create index on public.investments (portfolio_company_id);
create index on public.investments (investor_company_id, status);
create index on public.investments (fund_id);
create index on public.investments (entry_date desc);
create index on public.investments (exit_date desc) where exit_date is not null;

create trigger investments_set_updated_at
  before update on public.investments
  for each row execute function public.set_updated_at();

-- Add-ons hang off the position that made them.
alter table public.deals
  add constraint deals_parent_investment_fk
  foreign key (parent_investment_id) references public.investments(id) on delete set null;

create index on public.deals (parent_investment_id) where parent_investment_id is not null;
