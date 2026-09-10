-- =====================================================================
-- pe-intelligence :: 0024 the refresh queue, as its own small view
-- =====================================================================
-- v_investor_universe would need restating in full to gain two columns, and it
-- is already 140 lines carrying portfolio text, grades and team rollups that a
-- scraper has no use for. A purpose-built view is cheaper to read and cheaper
-- to run: the nightly job wants a name, a website, the handful of fields it may
-- propose against, and how long ago it last looked.

create or replace view public.v_refresh_queue as
select
  i.company_id,
  c.legal_name,
  c.website,
  c.address_line,
  c.postcode,
  c.city,
  c.phone,
  c.description,
  i.fund_type::text as fund_type,
  i.last_scraped_at,
  i.scrape_error,
  (i.status <> 'active' or c.merged_into_id is not null) as hidden
from public.investors i
join public.companies c on c.id = i.company_id;

comment on view public.v_refresh_queue is
  'What the nightly refresh needs and nothing else. Order by last_scraped_at '
  'nulls first, then legal_name, to get the next batch.';
