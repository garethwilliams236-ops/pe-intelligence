-- =====================================================================
-- pe-intelligence :: 0021 defunct funds, and duplicates that stay linked
-- =====================================================================
-- Two different reasons a fund should drop out of the book, and they are not
-- the same fact:
--
--   DEFUNCT     the firm existed and no longer invests. Lyceum and Doughty
--               Hanson have been ranking well for weeks — the data about them
--               is accurate, they simply cannot take a call. Recorded on the
--               investor, because it is a fact about the fund.
--
--   DUPLICATE   one firm entered twice. Carlyle is in here three times,
--               Bridgepoint three times including an unrelated Canadian house.
--               Recorded as companies.merged_into_id, which already exists,
--               so the duplicate keeps pointing at the survivor instead of
--               being deleted. A row that merely vanishes takes its portfolio
--               evidence and its ICS outcomes with it.
--
-- Neither is a delete. Both are reversible, both are audited, and the grid can
-- show them again on request.

do $$ begin
  create type public.investor_status as enum ('active', 'defunct');
exception when duplicate_object then null;
end $$;

alter table public.investors
  add column if not exists status      public.investor_status not null default 'active',
  add column if not exists status_note text;

comment on column public.investors.status is
  'Defunct means the firm no longer invests. Excluded from ranking, and from '
  'the book unless explicitly shown. Reversible — never delete a fund.';

-- ---------------------------------------------------------------------
-- The view stops hiding merged rows. It used to end with
-- "where c.merged_into_id is null", which meant a duplicate could be marked
-- but never reviewed, and nothing on any screen could say how many there were.
-- Both flags are now columns and each caller decides: the ranking excludes
-- them and counts the exclusion, the book hides them behind a toggle.
-- ---------------------------------------------------------------------
drop view if exists public.v_investor_universe;

create view public.v_investor_universe as
with band as (
  select i.company_id,
         case regexp_replace(coalesce(i.check_band, ''), '[^0-9\-]', '', 'g')
           when '0-5'    then 0::numeric        when '5-20'   then 5000000::numeric
           when '20-60'  then 20000000::numeric when '60-200' then 60000000::numeric
           when '200-900' then 200000000::numeric
         end as band_min,
         case regexp_replace(coalesce(i.check_band, ''), '[^0-9\-]', '', 'g')
           when '0-5'    then 5000000::numeric   when '5-20'   then 20000000::numeric
           when '20-60'  then 60000000::numeric  when '60-200' then 200000000::numeric
           when '200-900' then 900000000::numeric
         end as band_max
  from public.investors i
),
strat as (
  select company_id, array_agg(distinct strategy::text) as strategies
  from public.investor_strategies group by company_id
),
focus as (
  select f.company_id, array_agg(distinct s.name) as focus
  from public.investor_sector_focus f
  join public.sectors s on s.id = f.sector_id
  group by f.company_id
),
portfolio as (
  select subject_id as company_id,
         string_agg(coalesce(value_text, '') || ' ' ||
                    coalesce(value_json->>'description', ''), ' ') as portfolio_text,
         count(*) as holdings
  from public.claims
  where subject_table = 'investors' and attribute = 'portfolio_company'
  group by subject_id
),
activity as (
  select investor_company_id as company_id,
         max(extract(year from entry_date))::int as latest_year,
         count(*) filter (where entry_date > now() - interval '4 years') as recent_count
  from public.investments where entry_date is not null
  group by investor_company_id
),
team as (
  select company_id,
         count(*)::int as team_size,
         count(*) filter (where has_email)::int as team_with_email,
         max(full_name) filter (where is_key_contact) as key_contact,
         max(title)     filter (where is_key_contact) as key_contact_title,
         bool_or(is_key_contact and has_email)        as key_contact_has_email
  from public.v_investor_team
  group by company_id
)
select
  i.company_id,
  c.legal_name,
  c.country_code,
  i.status::text                                 as status,
  i.status_note,
  c.merged_into_id,
  (select cc.legal_name from public.companies cc where cc.id = c.merged_into_id)
                                                 as merged_into_name,
  (i.status <> 'active' or c.merged_into_id is not null) as hidden,
  i.fund_type::text                              as fund_type,
  coalesce(i.invest_geographies, '{}')           as invest_geographies,
  i.ardent_sector,
  i.check_band,
  i.engagement_level,
  i.quality_score,
  i.priority,
  i.key_investments,
  i.last_audited,
  coalesce(band.band_min, i.min_cheque_raw)      as cheque_min,
  coalesce(band.band_max, i.max_cheque_raw)      as cheque_max,
  case when band.band_min is not null then 'ardent_band'
       when i.min_cheque_raw is not null then 'scraped_range'
       else null end                             as cheque_source,
  i.min_cheque_raw,
  i.max_cheque_raw,
  i.cheque_currency,
  coalesce(team.team_size, 0)                    as team_size,
  coalesce(team.team_with_email, 0)              as team_with_email,
  team.key_contact,
  team.key_contact_title,
  coalesce(team.key_contact_has_email, false)    as key_contact_has_email,
  coalesce(strat.strategies, '{}') as strategies,
  coalesce(focus.focus, '{}') as focus,
  g.grade,
  coalesce(g.never_approach, false) as never_approach,
  coalesce(portfolio.portfolio_text, '') as portfolio_text,
  coalesce(portfolio.holdings, 0)::int as holdings,
  coalesce(activity.recent_count, 0)::int as recent_count,
  activity.latest_year
from public.investors i
join public.companies c on c.id = i.company_id
left join band on band.company_id = i.company_id
left join strat on strat.company_id = i.company_id
left join focus on focus.company_id = i.company_id
left join portfolio on portfolio.company_id = i.company_id
left join activity on activity.company_id = i.company_id
left join team on team.company_id = i.company_id
left join public.v_investor_current_grade g on g.company_id = i.company_id;

comment on view public.v_investor_universe is
  'One row per investor, including hidden ones — `hidden` is true for a defunct '
  'fund or a row merged into another. Callers filter: the ranking excludes them '
  'and counts it, the book hides them behind a toggle. Cheque range prefers the '
  'hand-maintained Ardent band over the scraped numeric range; cheque_source '
  'says which. Read server-side only: it carries confidential master-list data.';
