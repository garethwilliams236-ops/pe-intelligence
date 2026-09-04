-- =====================================================================
-- pe-intelligence :: 0001 extensions, shared enums, shared helpers
-- =====================================================================

create schema if not exists extensions;

create extension if not exists pgcrypto  with schema extensions;
create extension if not exists pg_trgm   with schema extensions;
create extension if not exists unaccent  with schema extensions;
create extension if not exists btree_gin with schema extensions;
create extension if not exists vector    with schema extensions;

-- ---------------------------------------------------------------------
-- Immutable unaccent wrapper. extensions.unaccent() is STABLE, not
-- IMMUTABLE, so it cannot be used in generated columns or indexes.
-- ---------------------------------------------------------------------
create or replace function public.immutable_unaccent(text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, $1)
$$;

-- Canonical form used for all entity-name matching.
create or replace function public.normalise_name(text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          lower(public.immutable_unaccent(coalesce($1, ''))),
          -- strip common legal suffixes across UK + Western Europe
          '\y(limited|ltd|plc|llp|lp|holdings?|group|company|co|incorporated|inc|'
          || 'gmbh|ag|kg|kgaa|se|nv|bv|sa|sas|sarl|srl|spa|ab|as|a\/s|aps|oy|oyj|'
          || 'sl|sau|cvba|scrl|ug|ohg|gbr|eurl|snc)\y\.?',
          ' ', 'g'
        ),
        '[^a-z0-9]+', ' ', 'g'
      )
    ),
    ''
  )
$$;

-- ---------------------------------------------------------------------
-- Shared updated_at trigger
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

-- What a company is to us. A company can be several at once, so this is
-- carried as an array on companies.company_types.
create type public.company_type as enum (
  'sponsor',            -- PE / VC / growth house
  'portfolio_company',
  'strategic',          -- corporate / trade acquirer
  'target',
  'adviser',            -- corp fin, legal, accountancy, DD
  'lender',
  'lp',                 -- limited partner / fund investor
  'other'
);

create type public.investor_strategy as enum (
  'buyout',
  'growth',
  'venture',
  'minority',
  'credit',
  'mezzanine',
  'infrastructure',
  'real_estate',
  'secondaries',
  'fund_of_funds',
  'family_office',
  'sovereign_wealth',
  'pension',
  'vct',
  'eis',
  'search_fund',
  'special_situations',
  'other'
);

create type public.deal_type as enum (
  'buyout',
  'secondary_buyout',
  'growth_investment',
  'minority_stake',
  'take_private',
  'carve_out',
  'add_on',
  'merger',
  'trade_sale',
  'ipo',
  'refinancing',
  'recapitalisation',
  'restructuring',
  'partial_exit',
  'full_exit',
  'asset_purchase',
  'other'
);

create type public.deal_status as enum (
  'rumoured',
  'in_market',
  'announced',
  'completed',
  'lapsed',
  'terminated',
  'withdrawn',
  'unknown'
);

create type public.participant_role as enum (
  'target',
  'buyer',
  'seller',
  'lead_investor',
  'co_investor',
  'existing_investor',
  'management_team',
  'vendor_shareholder',
  'lender',
  'merger_party'
);

create type public.adviser_side as enum (
  'buy_side',
  'sell_side',
  'company',
  'lender',
  'management',
  'unknown'
);

create type public.adviser_mandate as enum (
  'm_and_a',
  'debt_advisory',
  'legal',
  'financial_dd',
  'commercial_dd',
  'tax',
  'technology_dd',
  'esg_dd',
  'insurance',
  'other'
);

create type public.investment_status as enum (
  'current',
  'realised',
  'partially_realised',
  'written_off',
  'unknown'
);

create type public.person_seniority as enum (
  'managing_partner',
  'partner',
  'principal',
  'director',
  'investment_manager',
  'associate',
  'analyst',
  'operating_partner',
  'venture_partner',
  'chair',
  'non_executive_director',
  'ceo',
  'cfo',
  'other_executive',
  'other'
);

create type public.deal_person_role as enum (
  'deal_partner',
  'deal_team',
  'originator',
  'board_director',
  'board_observer',
  'chair',
  'operating_partner',
  'adviser_lead',
  'adviser_team',
  'management'
);

-- ---------------------------------------------------------------------
-- Provenance / licensing. This is the gate that decides whether a fact
-- may appear in a client-facing marketing report.
-- ---------------------------------------------------------------------
create type public.licence_class as enum (
  'public_domain',          -- registry filings, statute, company's own site
  'public_attributable',    -- press, requires citation, generally quotable
  'licensed_internal_only', -- PitchBook / Capital IQ / Mergr / Preqin feeds
  'confidential'            -- client-supplied, never leaves the engagement
);

create type public.claim_status as enum (
  'candidate',
  'accepted',
  'rejected',
  'superseded',
  'conflicted'
);

create type public.filing_basis as enum (
  'statutory',
  'consolidated',
  'management',
  'estimated',
  'pro_forma',
  'analyst_estimate'
);

create type public.crawl_status as enum (
  'queued',
  'fetching',
  'fetched',
  'parsed',
  'failed',
  'skipped',
  'blocked',
  'unchanged'
);

create type public.match_signal as enum (
  'sector_fit',
  'size_fit',
  'geography_fit',
  'deal_type_fit',
  'recent_activity',
  'fund_capacity',
  'buy_and_build_appetite',
  'thesis_similarity',
  'people_overlap',
  'adviser_overlap',
  'competitor_owned',
  'prior_approach',
  'hold_period_due',
  'negative_signal'
);

create type public.report_status as enum (
  'draft',
  'generating',
  'ready',
  'failed',
  'archived'
);

create type public.app_role as enum (
  'admin',
  'analyst',
  'viewer'
);
