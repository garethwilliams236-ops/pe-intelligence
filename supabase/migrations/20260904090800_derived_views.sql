-- =====================================================================
-- pe-intelligence :: 0009 derived views and lookup functions
--
-- These are the "revealed preference" layer: what a house actually does,
-- as opposed to what its website says it does. The matching engine reads
-- from here.
-- =====================================================================

-- Positions with the current (unrealised) hold period filled in.
create or replace view public.v_investments as
select
  i.*,
  case
    when i.entry_date is null then null
    else (extract(year  from age(coalesce(i.exit_date, current_date), i.entry_date)) * 12
       +  extract(month from age(coalesce(i.exit_date, current_date), i.entry_date)))::int
  end                                            as hold_months_to_date,
  (i.exit_date is null and i.status = 'current') as is_live,
  pc.legal_name                                  as portfolio_company_name,
  pc.country_code                                as portfolio_country_code,
  inv.legal_name                                 as investor_name
from public.investments i
join public.companies pc  on pc.id  = i.portfolio_company_id
join public.companies inv on inv.id = i.investor_company_id;

-- Deal + its preferred valuation, in GBP, in one row.
create or replace view public.v_deal_headline as
select
  d.id                    as deal_id,
  d.deal_type,
  d.status,
  d.effective_date,
  d.country_code,
  d.headline,
  d.target_company_id,
  t.legal_name            as target_name,
  v.enterprise_value_gbp,
  v.ebitda_ltm_gbp,
  v.ev_ebitda_multiple,
  v.ev_revenue_multiple,
  v.is_disclosed,
  v.licence_class,
  public.is_redistributable(v.licence_class) as valuation_is_redistributable
from public.deals d
left join public.companies t on t.id = d.target_company_id
left join public.deal_valuations v on v.deal_id = d.id and v.is_preferred;

-- The client-facing projection. The existence of a deal is generally
-- public even when a licensed feed is the only source of its numbers, so
-- this masks the restricted figures rather than dropping the deal.
create or replace view public.v_redistributable_deal_facts as
select
  h.deal_id,
  h.deal_type,
  h.status,
  h.effective_date,
  h.country_code,
  h.headline,
  h.target_company_id,
  h.target_name,
  case when h.valuation_is_redistributable then h.enterprise_value_gbp end as enterprise_value_gbp,
  case when h.valuation_is_redistributable then h.ebitda_ltm_gbp        end as ebitda_ltm_gbp,
  case when h.valuation_is_redistributable then h.ev_ebitda_multiple    end as ev_ebitda_multiple,
  case when h.valuation_is_redistributable then h.ev_revenue_multiple   end as ev_revenue_multiple,
  h.is_disclosed,
  coalesce(h.valuation_is_redistributable, true) as valuation_is_redistributable,
  (h.enterprise_value_gbp is not null and h.valuation_is_redistributable is false)
                                                 as valuation_withheld_for_licence
from public.v_deal_headline h;

-- ---------------------------------------------------------------------
-- Revealed sector focus: which sectors a house has actually bought into,
-- weighted so that a 2024 deal counts for far more than a 2012 one.
-- ---------------------------------------------------------------------
create or replace view public.v_investor_revealed_sectors as
select
  i.investor_company_id,
  cs.sector_id,
  count(*)                                       as deal_count,
  max(i.entry_date)                              as most_recent_entry,
  sum(
    cs.weight * exp(-0.15 * greatest(
      extract(year from age(current_date, coalesce(i.entry_date, current_date)))::numeric, 0))
  )::numeric(10,4)                               as recency_weighted_score
from public.investments i
join public.company_sectors cs on cs.company_id = i.portfolio_company_id
group by i.investor_company_id, cs.sector_id;

-- ---------------------------------------------------------------------
-- Revealed size band, from disclosed entry valuations only.
-- ---------------------------------------------------------------------
create or replace view public.v_investor_revealed_size as
select
  i.investor_company_id,
  count(v.enterprise_value_gbp)                                                as valued_deal_count,
  percentile_cont(0.25) within group (order by v.enterprise_value_gbp)         as ev_p25_gbp,
  percentile_cont(0.50) within group (order by v.enterprise_value_gbp)         as ev_median_gbp,
  percentile_cont(0.75) within group (order by v.enterprise_value_gbp)         as ev_p75_gbp,
  min(v.enterprise_value_gbp)                                                  as ev_min_gbp,
  max(v.enterprise_value_gbp)                                                  as ev_max_gbp,
  percentile_cont(0.50) within group (order by v.ebitda_ltm_gbp)               as ebitda_median_gbp,
  percentile_cont(0.50) within group (order by v.ev_ebitda_multiple)           as entry_multiple_median
from public.investments i
join public.deals dl on dl.id = i.entry_deal_id
join public.deal_valuations v on v.deal_id = dl.id and v.is_preferred
where v.enterprise_value_gbp is not null
group by i.investor_company_id;

-- ---------------------------------------------------------------------
-- Headline track record, one row per house.
-- ---------------------------------------------------------------------
create or replace view public.v_investor_track_record as
with add_ons as (
  select i.investor_company_id, count(*) as add_on_count
  from public.deals d
  join public.investments i on i.id = d.parent_investment_id
  where d.is_add_on
  group by i.investor_company_id
)
select
  inv.company_id                                                as investor_company_id,
  c.legal_name                                                  as investor_name,
  count(i.id)                                                   as total_investments,
  count(i.id) filter (where i.status = 'current')               as live_investments,
  count(i.id) filter (where i.exit_date is not null)            as realised_investments,
  count(i.id) filter (where i.entry_date >= current_date - interval '36 months') as entries_last_36m,
  count(i.id) filter (where i.entry_date >= current_date - interval '12 months') as entries_last_12m,
  coalesce(ao.add_on_count, 0)                                  as add_on_count,
  max(i.entry_date)                                             as last_entry_date,
  max(i.exit_date)                                              as last_exit_date,
  avg(i.hold_period_months) filter (where i.hold_period_months is not null)::numeric(8,2)
                                                                as avg_realised_hold_months,
  avg(i.moic) filter (where i.moic is not null)::numeric(8,3)   as avg_moic,
  count(*) filter (
    where i.status = 'current'
      and i.entry_date <= current_date - interval '48 months')  as live_holds_over_4y
from public.investors inv
join public.companies c on c.id = inv.company_id
left join public.investments i on i.investor_company_id = inv.company_id
left join add_ons ao on ao.investor_company_id = inv.company_id
group by inv.company_id, c.legal_name, ao.add_on_count;

-- ---------------------------------------------------------------------
-- Which fund, if any, is in its investment period right now.
-- ---------------------------------------------------------------------
create or replace function public.investor_active_fund(
  p_investor_company_id uuid,
  p_as_at date default current_date
)
returns uuid
language sql
stable
as $$
  select f.id
  from public.funds f
  where f.investor_company_id = p_investor_company_id
    and (f.investment_period_ends is null or f.investment_period_ends >= p_as_at)
    and (f.final_close_date is null or f.final_close_date <= p_as_at)
  order by f.vintage_year desc nulls last, f.final_close_date desc nulls last
  limit 1
$$;

-- ---------------------------------------------------------------------
-- Fuzzy company lookup for intake and for entity resolution. Searches
-- legal names and aliases together and returns the best match per company.
-- ---------------------------------------------------------------------
create or replace function public.search_companies(
  p_query text,
  p_limit int default 20,
  p_min_similarity real default 0.25
)
returns table (
  company_id   uuid,
  legal_name   text,
  country_code char(2),
  matched_on   text,
  similarity   real
)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select public.normalise_name(p_query) as key),
  hits as (
    select c.id as company_id, c.legal_name, c.country_code,
           'legal_name'::text as matched_on,
           similarity(c.name_key, q.key) as similarity
    from public.companies c, q
    where c.merged_into_id is null and c.name_key % q.key
    union all
    select c.id, c.legal_name, c.country_code,
           'alias'::text,
           similarity(a.alias_key, q.key)
    from public.company_aliases a
    join public.companies c on c.id = a.company_id, q
    where c.merged_into_id is null and a.alias_key % q.key
  ),
  best as (
    select distinct on (h.company_id)
      h.company_id, h.legal_name, h.country_code, h.matched_on, h.similarity
    from hits h
    where h.similarity >= p_min_similarity
    order by h.company_id, h.similarity desc
  )
  select b.company_id, b.legal_name, b.country_code, b.matched_on, b.similarity
  from best b
  order by b.similarity desc, b.legal_name
  limit p_limit
$$;
