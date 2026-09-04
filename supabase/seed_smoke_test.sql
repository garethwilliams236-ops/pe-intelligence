-- =====================================================================
-- pe-intelligence :: smoke test
-- Not a migration. Loads a small worked example (a UK software buyout
-- with an add-on and a secondary exit) and exercises every derived view.
-- Run against a scratch database only.
-- =====================================================================

begin;

insert into public.sectors (id, taxonomy, code, name, depth) values
  ('11111111-0000-0000-0000-000000000001','ardent','TECH','Technology',1),
  ('11111111-0000-0000-0000-000000000002','ardent','TECH.SAAS','B2B SaaS',2);

update public.sectors set parent_id = '11111111-0000-0000-0000-000000000001'
where code = 'TECH.SAAS';

-- sponsor, target, buyer
insert into public.companies (id, legal_name, company_types, country_code, website_domain) values
  ('22222222-0000-0000-0000-000000000001','Inflexion Private Equity Partners LLP','{sponsor}','GB','inflexion.com'),
  ('22222222-0000-0000-0000-000000000002','Northbank Software Group Limited','{portfolio_company,target}','GB','northbank.example'),
  ('22222222-0000-0000-0000-000000000003','Vestra Capital Partners LLP','{sponsor}','GB','vestra.example'),
  ('22222222-0000-0000-0000-000000000004','Kestrel Analytics Ltd','{portfolio_company}','GB','kestrel.example');

insert into public.company_aliases (company_id, alias) values
  ('22222222-0000-0000-0000-000000000001','Inflexion');

insert into public.company_identifiers (company_id, scheme, value, is_primary) values
  ('22222222-0000-0000-0000-000000000002','companies_house','08123456',true);

insert into public.company_sectors (company_id, sector_id, is_primary) values
  ('22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000002',true),
  ('22222222-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000002',true);

insert into public.investors (company_id, hq_country_code, min_ev_gbp, max_ev_gbp, min_ebitda_gbp, max_ebitda_gbp, does_buy_and_build, takes_majority) values
  ('22222222-0000-0000-0000-000000000001','GB',50000000,500000000,5000000,50000000,true,true),
  ('22222222-0000-0000-0000-000000000003','GB',100000000,800000000,10000000,80000000,false,true);

insert into public.investor_strategies (company_id, strategy, is_primary) values
  ('22222222-0000-0000-0000-000000000001','buyout',true),
  ('22222222-0000-0000-0000-000000000003','buyout',true);

insert into public.funds (id, investor_company_id, name, vintage_year, currency, size_gbp, final_close_date, investment_period_ends, is_investing) values
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','Buyout Fund V',2021,'GBP',2500000000,'2021-06-30','2027-06-30',true);

-- FX so a EUR deal normalises
insert into public.fx_rates (base_currency, quote_currency, rate_date, rate) values
  ('EUR','GBP','2018-01-01',0.88000000),
  ('EUR','GBP','2023-01-01',0.86000000);

-- entry, add-on, exit
insert into public.deals (id, target_company_id, deal_type, status, announced_date, completed_date, country_code, headline) values
  ('44444444-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002','buyout','completed','2018-03-01','2018-04-15','GB','Inflexion acquires Northbank Software'),
  ('44444444-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000004','add_on','completed','2020-09-01','2020-10-01','GB','Northbank acquires Kestrel Analytics'),
  ('44444444-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000002','secondary_buyout','completed','2023-05-01','2023-07-01','GB','Vestra acquires Northbank from Inflexion');

update public.deals set is_add_on = true where id = '44444444-0000-0000-0000-000000000002';

insert into public.deal_participants (deal_id, company_id, fund_id, role, is_lead) values
  ('44444444-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002',null,'target',false),
  ('44444444-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','buyer',true),
  ('44444444-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000003',null,'buyer',true),
  ('44444444-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000001',null,'seller',true);

insert into public.deal_valuations (deal_id, currency, enterprise_value, ebitda_ltm, ev_ebitda_multiple, enterprise_value_gbp, ebitda_ltm_gbp, is_disclosed, is_preferred, licence_class) values
  ('44444444-0000-0000-0000-000000000001','GBP',180000000,18000000,10.000,180000000,18000000,true,true,'public_attributable'),
  ('44444444-0000-0000-0000-000000000003','GBP',520000000,37000000,14.054,520000000,37000000,true,true,'licensed_internal_only');

insert into public.investments (id, investor_company_id, fund_id, portfolio_company_id, entry_deal_id, exit_deal_id, entry_date, exit_date, status, is_lead, moic) values
  ('55555555-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000003','2018-04-15','2023-07-01','realised',true,3.100),
  ('55555555-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000003',null,'22222222-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000003',null,'2023-07-01',null,'current',true,null);

update public.deals set parent_investment_id = '55555555-0000-0000-0000-000000000001'
where id = '44444444-0000-0000-0000-000000000002';

-- people: the partner who led it, and who has since moved house
insert into public.people (id, full_name) values
  ('66666666-0000-0000-0000-000000000001','Alexandra Finch');

insert into public.person_roles (person_id, company_id, title, seniority, start_date, end_date) values
  ('66666666-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','Partner','partner','2015-01-01','2024-03-31'),
  ('66666666-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000003','Managing Partner','managing_partner','2024-04-01',null);

insert into public.deal_people (deal_id, person_id, acting_for_company_id, role, is_lead) values
  ('44444444-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','deal_partner',true);

-- financials
insert into public.company_financials (company_id, period_end, currency, basis, revenue, ebitda, revenue_gbp, ebitda_gbp, employees) values
  ('22222222-0000-0000-0000-000000000002','2022-12-31','GBP','statutory',95000000,34000000,95000000,34000000,410),
  ('22222222-0000-0000-0000-000000000002','2021-12-31','GBP','statutory',78000000,27000000,78000000,27000000,350);

commit;

-- =====================================================================
-- Assertions
-- =====================================================================
\echo '--- realised hold period (expect 62 months) ---'
select hold_period_months from public.investments where id = '55555555-0000-0000-0000-000000000001';

\echo '--- track record ---'
select investor_name, total_investments, live_investments, realised_investments,
       add_on_count, avg_realised_hold_months, avg_moic
from public.v_investor_track_record
order by investor_name;

\echo '--- revealed sectors ---'
select investor_company_id, deal_count, most_recent_entry, recency_weighted_score
from public.v_investor_revealed_sectors order by deal_count desc;

\echo '--- revealed size band ---'
select valued_deal_count, ev_median_gbp, entry_multiple_median
from public.v_investor_revealed_size;

\echo '--- licence gate: the secondary EV is licensed, so it must not appear ---'
select deal_id, target_name, enterprise_value_gbp
from public.v_redistributable_deal_facts order by effective_date;

\echo '--- fuzzy search: "inflexion partners" should hit the alias/legal name ---'
select legal_name, matched_on, round(similarity::numeric,3) as sim
from public.search_companies('inflexion partners');

\echo '--- active fund ---'
select public.investor_active_fund('22222222-0000-0000-0000-000000000001');

\echo '--- fx lookup: EUR on a 2019 date should fall back to the 2018 rate ---'
select public.fx_to_gbp('EUR', '2019-06-30') as eur_gbp, public.fx_to_gbp('GBP', '2019-06-30') as gbp_gbp;

\echo '--- latest financials ---'
select period_end, revenue_gbp, ebitda_gbp from public.v_company_latest_financials;
