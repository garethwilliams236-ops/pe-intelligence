-- =====================================================================
-- pe-intelligence :: 0011 mandate-box provenance
--
-- WP1 stored the investor cheque range in GBP only. Real source data is
-- mixed EUR/USD/GBP and is stated as at a date that matters — a cheque
-- range from a 2018 list is not a current fact. Keep the figure as
-- stated, record its currency and vintage, and let the GBP columns be a
-- derived convenience rather than the record of truth.
-- =====================================================================

alter table public.investors
  add column min_cheque_raw       numeric(20,2),
  add column max_cheque_raw       numeric(20,2),
  add column cheque_currency      char(3) check (cheque_currency is null or char_length(cheque_currency) = 3),
  add column mandate_box_as_at    date,
  add column mandate_box_source_id uuid references public.sources(id) on delete set null,
  add constraint investors_cheque_range_chk
    check (max_cheque_raw is null or min_cheque_raw is null or max_cheque_raw >= min_cheque_raw);

comment on column public.investors.min_cheque_raw is
  'Minimum equity cheque as stated by the source, in cheque_currency. min_equity_cheque_gbp is derived from this.';
comment on column public.investors.mandate_box_as_at is
  'Date the mandate box was stated. Anything older than ~2 years should be treated as a hint, not a fact.';

create index on public.investors (mandate_box_as_at);

-- The firm's own master investor list, registered as a first-class source.
insert into public.sources (code, name, source_kind, publisher, licence_class,
                            is_redistributable, requires_attribution, default_confidence, notes)
values (
  'ardent_master_list',
  'Ardent master investor list',
  'client_supplied',
  'Ardent Advisors',
  'confidential',
  false,
  false,
  0.600,
  'Internally maintained investor universe. Attribute data is largely 2017-2019 vintage: '
  'treat names, websites and aliases as reliable seeds, and cheque sizes, contacts and '
  'sector focus as claims to be re-evidenced by the crawler.'
)
on conflict (code) do nothing;
