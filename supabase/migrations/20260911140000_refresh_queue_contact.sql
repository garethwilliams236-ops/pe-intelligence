-- =====================================================================
-- pe-intelligence :: 0027 the refresh queue learns who we already know
-- =====================================================================
-- Targeted runs need to ask "which funds have no named contact", and the queue
-- view could not answer: it carried what to scrape but nothing about what is
-- already on file. Without this, a contacts run would re-read 20 sites we
-- already have contacts for and propose nothing.

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
  i.fund_types,
  i.last_scraped_at,
  i.scrape_error,
  (select t.full_name from public.v_investor_team t
    where t.company_id = i.company_id and t.is_key_contact limit 1) as key_contact,
  (i.status <> 'active' or c.merged_into_id is not null) as hidden
from public.investors i
join public.companies c on c.id = i.company_id;

comment on view public.v_refresh_queue is
  'What the nightly and targeted refreshes need: where to look, what we hold, '
  'and how long ago we last looked. Order by last_scraped_at nulls first.';
