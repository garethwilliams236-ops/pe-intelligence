-- =====================================================================
-- pe-intelligence :: 0026 a fund can be more than one thing
-- =====================================================================
-- A single fund_type was wrong about the market. Plenty of houses run both an
-- LBO and a growth strategy; a multi-strategy manager is several of these at
-- once by definition; and an LP that also writes direct cheques is two. Forcing
-- one label meant the analyst had to decide which truth to discard, and the
-- ranking then filtered on the half that was thrown away.
--
-- fund_type becomes fund_types, an array. The filter semantics are OVERLAP: a
-- fund matches if ANY of its types is one you asked for. That is the question
-- being asked — "show me the LBO houses" should return a house that does LBO
-- and growth, not exclude it for being two things.
--
-- The scalar column is backfilled and then dropped. Keeping both would be two
-- sources of truth for the field the ranking leans on hardest, and they would
-- drift within a week.

alter table public.investors
  add column if not exists fund_types public.fund_type[] not null default '{}';

update public.investors
   set fund_types = array[fund_type]
 where fund_type is not null
   and cardinality(fund_types) = 0;

-- Anything referencing the scalar must go before the column can.
drop view if exists public.v_refresh_queue;
drop view if exists public.v_investor_universe;

alter table public.investors drop column if exists fund_type;

comment on column public.investors.fund_types is
  'Ardent''s classification, one or more of the nine categories. Authoritative: '
  'overrides anything derived from strategy tags or Crunchbase categories, and '
  'is editable by an analyst — every change lands in investor_field_history. '
  'Filters match on overlap, not equality.';

create index if not exists investors_fund_types_idx
  on public.investors using gin (fund_types);

create view public.v_refresh_queue as
select
  i.company_id,
  c.legal_name,
  c.website,
  c.address_line,
  c.postcode,
  c.city,
  c.phone,
  c.description,
  i.fund_types,
  i.last_scraped_at,
  i.scrape_error,
  (i.status <> 'active' or c.merged_into_id is not null) as hidden
from public.investors i
join public.companies c on c.id = i.company_id;

comment on view public.v_refresh_queue is
  'What the nightly refresh needs and nothing else. Order by last_scraped_at '
  'nulls first, then legal_name, to get the next batch.';

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
  c.city,
  c.website,
  c.address_line,
  c.postcode,
  c.phone,
  i.status::text                                 as status,
  i.status_note,
  c.merged_into_id,
  (select cc.legal_name from public.companies cc where cc.id = c.merged_into_id)
                                                 as merged_into_name,
  (i.status <> 'active' or c.merged_into_id is not null) as hidden,
  i.fund_types,
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
  'One row per investor with everything the Bible, the fund page and the '
  'ranking need, hidden ones included. fund_types is a set — filters match on '
  'overlap. Read server-side only: confidential master-list data.';

update public.investor_update_proposals
   set field = 'fund_types'
 where field = 'fund_type' and status = 'pending';
