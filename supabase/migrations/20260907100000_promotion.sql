-- =====================================================================
-- pe-intelligence :: 0013 promotion — claims become facts, reversibly
--
-- Promotion is the first step that writes to the typed tables, and the
-- first that makes judgements: is "Sedex" the Sedex already in companies,
-- or a new one? Those judgements will sometimes be wrong, so every row
-- promotion creates records which claim produced it and by what decision,
-- and a whole run can be undone.
-- =====================================================================

create type public.promotion_action as enum (
  'linked',      -- matched an existing company
  'created',     -- no acceptable match, new company row
  'ambiguous',   -- several plausible matches; nothing written, left for review
  'skipped'      -- nothing to promote (no usable name)
);

create table public.promotion_runs (
  id                uuid primary key default gen_random_uuid(),
  algorithm_version text not null,
  parameters        jsonb not null default '{}',
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running',   -- running | ok | failed | undone
  claims_considered int not null default 0,
  linked            int not null default 0,
  created           int not null default 0,
  ambiguous         int not null default 0,
  investments_made  int not null default 0,
  error_message     text,
  run_by            uuid references public.profiles(id) on delete set null
);

create index on public.promotion_runs (started_at desc);

-- One row per decision. This is what makes a run reversible and a wrong
-- link explainable months later.
create table public.promotions (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.promotion_runs(id) on delete cascade,
  claim_id      uuid references public.claims(id) on delete set null,
  action        public.promotion_action not null,
  target_table  text,
  target_id     uuid,
  matched_name  text,
  similarity    numeric(4,3),
  alternatives  jsonb,          -- the runners-up, for ambiguous decisions
  note          text,
  created_at    timestamptz not null default now()
);

create index on public.promotions (run_id, action);
create index on public.promotions (claim_id);
create index on public.promotions (target_table, target_id);

-- ---------------------------------------------------------------------
-- Date precision. A year scraped from a sponsor page is not a date, and
-- storing it as 1 January would quietly claim precision we do not have.
-- ---------------------------------------------------------------------
create type public.date_precision as enum ('day', 'month', 'year');

alter table public.investments
  add column entry_precision public.date_precision,
  add column exit_precision  public.date_precision,
  add column promotion_run_id uuid references public.promotion_runs(id) on delete set null;

comment on column public.investments.entry_precision is
  'How precisely entry_date is known. ''year'' means only the year was published; '
  'the day and month are placeholders and must not be shown to a client as exact.';

create index on public.investments (promotion_run_id);

-- Companies created by promotion rather than observed directly.
alter table public.companies
  add column promotion_run_id uuid references public.promotion_runs(id) on delete set null;

create index on public.companies (promotion_run_id) where promotion_run_id is not null;

-- ---------------------------------------------------------------------
-- Undo. Deletes only what a run created, in dependency order, and leaves
-- rows a later run has since touched alone.
-- ---------------------------------------------------------------------
create or replace function public.undo_promotion_run(p_run_id uuid)
returns table (deleted_table text, deleted_count bigint)
language plpgsql
as $$
declare
  v_investments bigint;
  v_companies   bigint;
begin
  delete from public.investments where promotion_run_id = p_run_id;
  get diagnostics v_investments = row_count;

  -- Only companies this run invented, and only if nothing else now points at
  -- them. A company that has since acquired other investments stays.
  delete from public.companies c
  where c.promotion_run_id = p_run_id
    and not exists (select 1 from public.investments i
                    where i.portfolio_company_id = c.id or i.investor_company_id = c.id)
    and not exists (select 1 from public.deals d where d.target_company_id = c.id);
  get diagnostics v_companies = row_count;

  update public.claims set status = 'candidate'
  where id in (select claim_id from public.promotions where run_id = p_run_id);

  update public.promotion_runs set status = 'undone', finished_at = now()
  where id = p_run_id;

  return query
    select 'investments'::text, v_investments
    union all
    select 'companies'::text, v_companies;
end;
$$;
