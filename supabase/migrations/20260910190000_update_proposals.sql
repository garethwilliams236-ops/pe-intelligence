-- =====================================================================
-- pe-intelligence :: 0023 nightly refresh, proposed and never applied
-- =====================================================================
-- The Investor Bible goes stale the day it is curated. This is the loop that
-- keeps it current: twenty funds a night, oldest-checked first, scraped from
-- their own public site and written HERE — never onto the investor record.
--
-- Nothing a robot reads reaches the Bible without Gareth accepting it. That is
-- the whole design constraint and it is why proposals are a separate table
-- rather than a confidence score on the record: an unreviewed scrape sitting in
-- `investors.address_line` is indistinguishable from a curated fact a week
-- later, and the ranking would quietly start leaning on it.
--
-- Three outcomes, all recorded: accepted as proposed, amended to something else,
-- or rejected. A rejection is data — it says this source was wrong about this
-- field, which is how we learn whether the scraper is worth its noise.
--
-- Twenty a night over 1,285 investors is a full pass roughly every nine weeks.

create type public.proposal_status as enum
  ('pending', 'accepted', 'amended', 'rejected');

-- Which twenty are next is derived, not stored. Ordering by last_scraped_at
-- (nulls first, then legal_name) is alphabetical on the first pass, oldest-first
-- after that, and self-healing: a run that dies halfway leaves the unfinished
-- funds still at the front of the queue instead of skipping them until the
-- cursor comes round again.
alter table public.investors
  add column if not exists last_scraped_at timestamptz,
  add column if not exists scrape_error    text;

comment on column public.investors.last_scraped_at is
  'When the refresh last ATTEMPTED this fund — set even when the fetch failed, '
  'so one unreachable site cannot block the queue behind it forever.';

create table if not exists public.investor_update_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  trigger       text not null default 'schedule',   -- schedule | manual
  attempted     int not null default 0,
  fetched       int not null default 0,
  proposed      int not null default 0,
  failed        int not null default 0,
  notes         text
);

create table if not exists public.investor_update_proposals (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid references public.investor_update_runs(id) on delete set null,
  company_id       uuid not null references public.investors(company_id) on delete cascade,
  field            text not null,
  current_value    text,
  proposed_value   text,
  -- What was actually written, which is the proposed value on an accept and
  -- something else entirely on an amend. Kept separately so "the robot said X,
  -- Gareth wrote Y" stays legible after the fact.
  final_value      text,
  confidence       numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  evidence_url     text,
  evidence_snippet text,
  status           public.proposal_status not null default 'pending',
  reviewed_at      timestamptz,
  reviewed_by      uuid references public.profiles(id) on delete set null,
  note             text,
  created_at       timestamptz not null default now()
);

create index if not exists investor_update_proposals_pending_idx
  on public.investor_update_proposals (status, created_at desc);
create index if not exists investor_update_proposals_company_idx
  on public.investor_update_proposals (company_id, status);

-- One pending proposal per field per fund. A second night's run re-proposing
-- the same change would otherwise stack duplicates in the queue for anything
-- Gareth has not got to yet.
create unique index if not exists investor_update_proposals_one_pending
  on public.investor_update_proposals (company_id, field) where status = 'pending';

comment on table public.investor_update_proposals is
  'Scraped changes awaiting review. Nothing here has touched the investor '
  'record; accepting one writes through the normal audited path and stamps '
  'investor_field_history with source ''scrape_accepted''.';

alter table public.investor_update_runs enable row level security;
alter table public.investor_update_proposals enable row level security;

create policy update_runs_read on public.investor_update_runs
  for select to authenticated using (true);
create policy update_proposals_read on public.investor_update_proposals
  for select to authenticated using (true);

-- The review queue, with the fund's name attached so the UI is one read.
create or replace view public.v_pending_proposals as
select p.*, c.legal_name, c.website
from public.investor_update_proposals p
join public.companies c on c.id = p.company_id
where p.status = 'pending';

insert into public.sources
  (code, name, source_kind, licence_class, is_redistributable,
   requires_attribution, default_confidence, notes)
values
  ('sponsor_refresh', 'Nightly sponsor site refresh', 'sponsor_site', 'public_domain', true,
   true, 0.600,
   'Twenty funds a night from their own public websites, robots.txt honoured. '
   'Proposes only — nothing from this source reaches an investor record without '
   'a human accepting it.')
on conflict (code) do nothing;
