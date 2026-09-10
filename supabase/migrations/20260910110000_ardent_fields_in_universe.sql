-- =====================================================================
-- pe-intelligence :: 0019 Ardent's own descriptors reach the ranking
-- =====================================================================
-- The Investor Control Sheet is the curated record: fund type, investment
-- geography, sector and cheque band are maintained by hand for the purpose of
-- deciding who to approach. Until now the ranking used none of it, and instead
-- inferred strategy from Crunchbase categories and geography from HQ country.
--
-- The cheque band OVERRIDES the numeric range, reversing the decision made in
-- scripts/load_control_sheet.py. Apax is banded 200-900m here and carries a
-- scraped range of 1-50m; Advent 200-900m against 1-350m. On an 800m mandate
-- the scraped figure excluded both and the list filled with small funds. Where
-- the two disagree the hand-maintained one is the one Ardent would defend, so
-- `cheque_source` records which was used rather than hiding the substitution.
--
-- Geography likewise: `country_code` is where a fund has its office, which is
-- not the question. `invest_geographies` is where it deploys.

-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW can only
-- append columns to the end of the list, and this puts Ardent's fields where
-- they belong, next to the scraped values they override.
drop view if exists public.v_investor_universe;

create view public.v_investor_universe as
with band as (
  select i.company_id,
         -- Five bands, exactly as the sheet writes them; the '200- 900m' key
         -- carries a stray space and a second currency symbol, so normalise
         -- before matching rather than listing every typographic variant.
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
)
select
  i.company_id,
  c.legal_name,
  c.country_code,
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
left join public.v_investor_current_grade g on g.company_id = i.company_id
where c.merged_into_id is null;

comment on view public.v_investor_universe is
  'One row per investor with everything the ranking and the control-sheet grid '
  'need. Cheque range prefers the hand-maintained Ardent band over the scraped '
  'numeric range; cheque_source says which. Read server-side only: it carries '
  'master-list attributes loaded as confidential.';
