-- =====================================================================
-- pe-intelligence :: 0022 where a fund actually is, and how to ring it
-- =====================================================================
-- companies has city, country and website. It has never had a street address
-- or a switchboard number, and nothing in any loader supplies one — the master
-- workbook states an office as a city, not an address.
--
-- These columns are therefore EMPTY on arrival, on purpose. They exist so the
-- analyst reviewing a fund has somewhere to put what they know, and so the
-- fund page can show a contact block that is complete rather than one that
-- silently omits the two fields anyone reaches for first. They are edited like
-- every other field, through investor_field_history, so a typed-in address
-- carries the same trail as an imported one.
--
-- The view is RESTATED IN FULL rather than wrapped around the previous version.
-- CREATE OR REPLACE can only append columns, so wrapping is the only way to
-- insert one in the middle — and three wrappers deep, nobody can read what the
-- view actually is. One long definition that can be read top to bottom beats a
-- chain of clever ones. Everything before the company fields is unchanged from
-- 0021, and the status columns are re-declared idempotently so this migration
-- is safe whether or not 0021 has been applied.

do $$ begin
  create type public.investor_status as enum ('active', 'defunct');
exception when duplicate_object then null;
end $$;

alter table public.investors
  add column if not exists status      public.investor_status not null default 'active',
  add column if not exists status_note text;

alter table public.companies
  add column if not exists address_line text,
  add column if not exists postcode     text,
  add column if not exists phone        text;

comment on column public.companies.address_line is
  'Street address. Analyst-entered: no source loads this. Confidential in the '
  'same way the contact emails are — it belongs to Ardent''s own record.';

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
  'One row per investor with everything the book, the fund page and the ranking '
  'need, including hidden ones — `hidden` is true for a defunct fund or a row '
  'merged into another, and each caller decides what to do about it. Cheque '
  'range prefers the hand-maintained Ardent band over the scraped numeric '
  'range; cheque_source says which. Read server-side only: it carries '
  'confidential master-list data including named contacts.';
