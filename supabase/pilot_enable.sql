-- =====================================================================
-- WP3 pilot — enable 20 UK mid-market buyout houses for crawling
--
-- Not a migration: this is an operational script, safe to run repeatedly.
-- Every other target stays disabled. Run `crawler.run probe` first; only
-- enable more once the extractor has been seen to work on these.
-- =====================================================================

update public.crawl_targets t
   set is_enabled = true,
       next_run_at = now(),
       frequency_hours = 720          -- monthly; sponsor portfolios move slowly
  from public.companies c
 where c.id = t.company_id
   and t.target_kind = 'sponsor_root'
   and c.website_domain in (
     'inflexion.com',
     'livingbridge.com',
     'ldc.co.uk',
     'ecipartners.com',
     'bowmark.com',
     'dunedin.com',
     'phoenix-equity.com',
     'montagu.com',
     'palamon.com',
     'sovereigncapital.co.uk',
     'rutlandpartners.com',
     'dukestreet.com',
     'exponentpe.com',
     'equistonepe.com',
     'charterhouse.co.uk',
     'vitruvianpartners.com',
     'synova-capital.com',
     'fpecapital.com',
     'horizonpe.co.uk',
     'beechtreepe.com'
   );

-- What is now live
select c.legal_name, t.start_url, t.frequency_hours, t.next_run_at::date
from public.crawl_targets t
join public.companies c on c.id = t.company_id
where t.is_enabled
order by c.legal_name;

select count(*) filter (where is_enabled) as enabled,
       count(*)                          as total
from public.crawl_targets;
