-- =====================================================================
-- pe-intelligence :: 0016 absolute filters, and analyst grading
-- =====================================================================
-- Two things the ranking cannot express as weights.
--
-- 1. Some criteria are ABSOLUTE. A fund outside the mandate's geography is
--    not a 40%-good answer, it is not an answer — and a strong sector score
--    should never drag it back in. Which criteria are absolute varies per
--    mandate, so the mandate declares them.
--
-- 2. Analyst judgement. Ardent knows things about these houses that no
--    crawler will ever find: who is actually raising, who is impossible to
--    deal with, who always takes the call. That belongs in the system, kept
--    beside the computed score rather than blended into it, so it stays
--    visible, attributable and reversible.

alter table public.mandates
  add column if not exists hard_filters text[] not null default '{geography}',
  add column if not exists required_country_codes char(2)[];

comment on column public.mandates.hard_filters is
  'Signals treated as absolute for this mandate rather than weighted: any of '
  'geography, sector, size, deal_type. An investor failing one is excluded '
  'from the ranking entirely and counted in the run''s exclusion report.';

comment on column public.mandates.required_country_codes is
  'Countries an investor must be in to qualify when geography is a hard '
  'filter. Null falls back to the mandate''s own country_code.';

-- ---------------------------------------------------------------------
-- Analyst grading. One current grade per investor, with history kept:
-- an upgrade is a new row, and the previous one is closed rather than
-- overwritten, so "why is this house rated A" always has an answer.
-- ---------------------------------------------------------------------
create table if not exists public.investor_grades (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.investors(company_id) on delete cascade,
  grade           text not null check (grade in ('a', 'b', 'c', 'd')),
  never_approach  boolean not null default false,
  rationale       text,
  graded_by       uuid references public.profiles(id) on delete set null,
  graded_at       timestamptz not null default now(),
  superseded_at   timestamptz,
  superseded_by   uuid references public.investor_grades(id) on delete set null
);

create index if not exists investor_grades_company_idx
  on public.investor_grades (company_id, graded_at desc);

-- Only one live grade per investor.
create unique index if not exists investor_grades_one_current
  on public.investor_grades (company_id) where superseded_at is null;

comment on table public.investor_grades is
  'Analyst assessment of an investor, persisting across mandates. Shown '
  'alongside the computed score, never folded into it — a human upgrade that '
  'silently moved a number would make it impossible to tell later what the '
  'evidence said and what somebody decided.';

comment on column public.investor_grades.never_approach is
  'A hard exclusion from human knowledge: the house is unusable for reasons '
  'no crawler will find. Applied like a mandate hard filter.';

create or replace view public.v_investor_current_grade as
select g.company_id, g.grade, g.never_approach, g.rationale, g.graded_at
from public.investor_grades g
where g.superseded_at is null;

alter table public.investor_grades enable row level security;

create policy investor_grades_read on public.investor_grades
  for select to authenticated using (true);

create policy investor_grades_write on public.investor_grades
  for insert to authenticated with check (true);

create policy investor_grades_update on public.investor_grades
  for update to authenticated using (true);
