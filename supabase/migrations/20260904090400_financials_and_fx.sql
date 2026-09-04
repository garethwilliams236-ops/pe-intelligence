-- =====================================================================
-- pe-intelligence :: 0005 FX normalisation and company financials
-- =====================================================================

-- Every cross-border comparison in this product is a GBP comparison, so
-- FX is first-class rather than a client-side afterthought.
create table public.fx_rates (
  id            uuid primary key default gen_random_uuid(),
  base_currency char(3) not null check (char_length(base_currency) = 3),
  quote_currency char(3) not null default 'GBP' check (char_length(quote_currency) = 3),
  rate_date     date not null,
  rate          numeric(18,8) not null check (rate > 0),
  source        text not null default 'ecb',
  created_at    timestamptz not null default now(),
  unique (base_currency, quote_currency, rate_date)
);

create index on public.fx_rates (base_currency, rate_date desc);

-- Nearest-on-or-before lookup. Deal dates rarely land on a business day.
create or replace function public.fx_to_gbp(p_currency char(3), p_date date)
returns numeric
language sql
stable
parallel safe
as $$
  select case
    when p_currency is null or upper(p_currency) = 'GBP' then 1::numeric
    else (
      select r.rate
      from public.fx_rates r
      where r.base_currency = upper(p_currency)
        and r.quote_currency = 'GBP'
        and r.rate_date <= coalesce(p_date, current_date)
      order by r.rate_date desc
      limit 1
    )
  end
$$;

-- ---------------------------------------------------------------------
-- Financial history. Two years minimum is the working rule; the crawler
-- fills this from Companies House and its European equivalents.
-- ---------------------------------------------------------------------
create table public.company_financials (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  period_end          date not null,
  period_months       int not null default 12 check (period_months between 1 and 24),
  currency            char(3) not null default 'GBP' check (char_length(currency) = 3),
  basis               public.filing_basis not null default 'statutory',
  revenue             numeric(20,2),
  gross_profit        numeric(20,2),
  ebitda              numeric(20,2),
  ebitda_adjusted     numeric(20,2),
  ebit                numeric(20,2),
  profit_before_tax   numeric(20,2),
  net_income          numeric(20,2),
  total_assets        numeric(20,2),
  net_assets          numeric(20,2),
  cash                numeric(20,2),
  gross_debt          numeric(20,2),
  net_debt            numeric(20,2),
  employees           int,
  -- normalised
  fx_rate_to_gbp      numeric(18,8),
  revenue_gbp         numeric(20,2),
  ebitda_gbp          numeric(20,2),
  is_estimate         boolean not null default false,
  source_id           uuid,   -- FK added in 0006
  licence_class       public.licence_class not null default 'public_domain',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, period_end, basis)
);

create index on public.company_financials (company_id, period_end desc);
create index on public.company_financials (ebitda_gbp) where ebitda_gbp is not null;

create trigger company_financials_set_updated_at
  before update on public.company_financials
  for each row execute function public.set_updated_at();

-- Convenience: the latest statutory year per company, used by size-fit
-- scoring and by the client intake screen.
create or replace view public.v_company_latest_financials as
select distinct on (f.company_id)
  f.company_id,
  f.period_end,
  f.currency,
  f.basis,
  f.revenue,
  f.ebitda,
  f.revenue_gbp,
  f.ebitda_gbp,
  f.employees,
  f.net_debt
from public.company_financials f
order by f.company_id, f.period_end desc, f.basis;
