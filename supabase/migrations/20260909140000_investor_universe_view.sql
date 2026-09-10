-- =====================================================================
-- pe-intelligence :: 0017 one row per investor for the ranking app
-- =====================================================================
-- The app scores 1,285 investors on every request. Assembling the strategy
-- tags, sector focus, current grade and portfolio evidence client-side would
-- mean five round trips and a join in JavaScript; this is one select.
--
-- `portfolio_text` comes from the claims rather than the promoted companies,
-- because promotion writes only a name — the descriptions the crawler captured
-- stay on the claim, and they are what makes a thesis match explainable rather
-- than a bare name collision.

create or replace view public.v_investor_universe as
with strat as (
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
)
select
  i.company_id,
  c.legal_name,
  c.country_code,
  i.min_cheque_raw,
  i.max_cheque_raw,
  i.cheque_currency,
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
left join strat on strat.company_id = i.company_id
left join focus on focus.company_id = i.company_id
left join portfolio on portfolio.company_id = i.company_id
left join activity on activity.company_id = i.company_id
left join public.v_investor_current_grade g on g.company_id = i.company_id
where c.merged_into_id is null;

comment on view public.v_investor_universe is
  'One row per investor with everything the ranking needs. Read server-side '
  'only: it carries master-list attributes loaded as confidential.';
