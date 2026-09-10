-- =====================================================================
-- pe-intelligence :: 0018 the Investor Control Sheet as the master record
-- =====================================================================
-- WP2 loaded four tabs of the master workbook and missed the one that
-- matters. "Investor Control Sheet" carries, per fund, the fields the
-- ranking most needs and which every other source states worse:
--
--   fund type              VC / LBO / MBO / LP / FO / VCT / AM / CSO / HNW
--   investment geography   where they INVEST, not where the office is
--   specialist sector      a clean six-value vocabulary Ardent actually uses
--   cheque band, engagement level, quality, priority, key investments
--
-- Ranking on HQ country excluded Blackstone from a UK mandate despite a
-- £100m–£10bn cheque range, because its office is in New York. Investment
-- geography is the correct field and this is where it lives.
--
-- Fund type is AUTHORITATIVE: it overrides anything derived from Crunchbase
-- categories or strategy tags. It is a human judgement about what kind of
-- money a fund is, which is exactly what decides relevance.

create type public.fund_type as enum (
  'vc', 'vct', 'mbo', 'lbo', 'lp', 'family_office', 'hnw',
  'multi_strategy_am', 'corp_strategy_office'
);

alter table public.investors
  add column if not exists fund_type public.fund_type,
  add column if not exists invest_geographies text[] not null default '{}',
  add column if not exists ardent_sector text,
  add column if not exists engagement_level text,
  add column if not exists quality_score int,
  add column if not exists priority text,
  add column if not exists check_band text,
  add column if not exists key_investments text,
  add column if not exists last_audited date;

comment on column public.investors.fund_type is
  'Authoritative classification from the Investor Control Sheet. Overrides '
  'anything derived from strategy tags or Crunchbase categories, and is '
  'editable by an analyst — every change is recorded in investor_field_history.';

comment on column public.investors.invest_geographies is
  'Where the fund INVESTS, expanded from the sheet''s compound codes: NA-UK '
  'becomes {NA,UK}, EU-UK becomes {EU,UK}. Not the same as the HQ country on '
  'companies.country_code, and it is this field a geography filter must use.';

-- ---------------------------------------------------------------------
-- Audit trail. Any analyst edit to an investor record writes a row here
-- before the change lands, so every field can answer "what did this say
-- before, who changed it, and when".
-- ---------------------------------------------------------------------
create table if not exists public.investor_field_history (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.investors(company_id) on delete cascade,
  field         text not null,
  old_value     text,
  new_value     text,
  source        text not null default 'analyst',   -- analyst | ics_import | crawl
  rationale     text,
  changed_by    uuid references public.profiles(id) on delete set null,
  changed_at    timestamptz not null default now()
);

create index if not exists investor_field_history_company_idx
  on public.investor_field_history (company_id, changed_at desc);

comment on table public.investor_field_history is
  'Every change to an investor record, including the import that set it. An '
  'override without a trail is indistinguishable from a data error later.';

alter table public.investor_field_history enable row level security;

create policy investor_field_history_read on public.investor_field_history
  for select to authenticated using (true);
create policy investor_field_history_write on public.investor_field_history
  for insert to authenticated with check (true);

insert into public.sources
  (code, name, source_kind, licence_class, is_redistributable,
   requires_attribution, default_confidence, notes)
values
  ('ardent_ics_master', 'Ardent Investor Control Sheet (master workbook)',
   'client_supplied', 'confidential', false, false, 0.960,
   'The "Investor Control Sheet" tab of the master investor workbook. Ardent''s '
   'own maintained classification of each fund — type, investment geography, '
   'sector and cheque band. Highest confidence of any investor attribute source.')
on conflict (code) do nothing;
