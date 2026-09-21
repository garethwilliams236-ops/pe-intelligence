-- =====================================================================
-- pe-intelligence :: 0029 the interaction log, matching the IB CRM
-- =====================================================================
-- The CRM's activity feed: meetings, calls, emails, notes. Same three tables,
-- same enums, same trigger behaviour, so a conversation logged in either system
-- carries the same information and the two can be reconciled later.
--
-- The differences are only where this database has no equivalent noun:
--
--   no workspace_id — PE Intelligence is single-tenant. The CRM scopes
--   everything to a workspace; there is nothing here to scope to.
--
--   interaction_links points at COMPANIES only. The CRM links to firm, deal or
--   mandate; deals and mandates are not tables here. The link table is kept
--   rather than collapsing into a column on interactions, because one call can
--   be about two funds and because deals become additive later.
--
--   participants are people or PROFILES, the CRM's users being our profiles.
--
-- The feed is NOT confidential in the way addresses are — a note saying you met
-- someone is not their email address — but it is Ardent's own commercial
-- record. Same gate as everything else: authenticated read, editor write.

-- ---------------------------------------------------------------------
-- Vocabularies, lifted from the CRM unchanged. Same spellings on purpose:
-- a value that has to be translated between systems is a value that will
-- eventually be translated wrongly.
-- ---------------------------------------------------------------------
do $$ begin
  create type public.interaction_type as enum
    ('meeting', 'call', 'email', 'note', 'intro', 'conference', 'dinner', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.interaction_direction as enum
    ('inbound', 'outbound', 'internal', 'not_applicable');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.interaction_source as enum
    ('manual', 'gmail', 'outlook', 'calendar', 'mobile', 'api');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.interaction_sentiment as enum
    ('positive', 'neutral', 'negative', 'unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.interaction_participant_role as enum
    ('organizer', 'attendee', 'cc', 'bcc', 'optional');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- interactions
-- ---------------------------------------------------------------------
create table if not exists public.interactions (
  id                uuid primary key default gen_random_uuid(),
  interaction_type  public.interaction_type not null,
  direction         public.interaction_direction not null default 'not_applicable',
  subject           text,
  ai_summary        text,
  body              text,
  occurred_at       timestamptz not null,
  duration_minutes  integer check (duration_minutes is null or duration_minutes >= 0),
  location          text,
  logged_by         uuid references public.profiles(id) on delete set null,
  source            public.interaction_source not null default 'manual',
  external_id       text,
  sentiment         public.interaction_sentiment not null default 'unknown',
  custom_fields     jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists interactions_occurred_idx
  on public.interactions (occurred_at desc);

create index if not exists interactions_logged_by_idx
  on public.interactions (logged_by, occurred_at desc) where logged_by is not null;

create index if not exists interactions_fts_idx
  on public.interactions using gin (to_tsvector('english',
    coalesce(subject, '') || ' ' || coalesce(ai_summary, '') || ' ' ||
    coalesce(body, '')));

-- An email imported twice is one email. Dedup on the provider's own id, which
-- is the only thing that survives a re-sync intact.
create unique index if not exists interactions_external_id_uniq
  on public.interactions (source, external_id) where external_id is not null;

drop trigger if exists interactions_set_updated_at on public.interactions;
create trigger interactions_set_updated_at
  before update on public.interactions
  for each row execute function public.set_updated_at();

comment on table public.interactions is
  'Activity feed — meetings, calls, emails, notes. Mirrors the IB CRM''s '
  'interactions table, minus workspace scoping. Who and what it was about live '
  'in interaction_participants and interaction_links.';

-- ---------------------------------------------------------------------
-- interaction_participants — exactly one party per row
-- ---------------------------------------------------------------------
create table if not exists public.interaction_participants (
  id              uuid primary key default gen_random_uuid(),
  interaction_id  uuid not null references public.interactions(id) on delete cascade,
  person_id       uuid references public.people(id)   on delete cascade,
  profile_id      uuid references public.profiles(id) on delete cascade,
  role            public.interaction_participant_role not null default 'attendee',
  constraint interaction_participants_one_party
    check (num_nonnulls(person_id, profile_id) = 1)
);

create index if not exists interaction_participants_interaction_idx
  on public.interaction_participants (interaction_id);
create index if not exists interaction_participants_person_idx
  on public.interaction_participants (person_id) where person_id is not null;
create index if not exists interaction_participants_profile_idx
  on public.interaction_participants (profile_id) where profile_id is not null;

create unique index if not exists interaction_participants_uniq_person
  on public.interaction_participants (interaction_id, person_id) where person_id is not null;

-- ---------------------------------------------------------------------
-- interaction_links — what the conversation was about
-- ---------------------------------------------------------------------
create table if not exists public.interaction_links (
  id              uuid primary key default gen_random_uuid(),
  interaction_id  uuid not null references public.interactions(id) on delete cascade,
  company_id      uuid not null references public.companies(id) on delete cascade
);

create index if not exists interaction_links_interaction_idx
  on public.interaction_links (interaction_id);
create index if not exists interaction_links_company_idx
  on public.interaction_links (company_id);
create unique index if not exists interaction_links_uniq_company
  on public.interaction_links (interaction_id, company_id);

-- ---------------------------------------------------------------------
-- last_interaction_at, kept honest
--
-- people.last_interaction_at arrived in 0028; companies needs its own. Both are
-- caches of "max(occurred_at) over everything this party attended", and the CRM
-- learned the hard way that an INSERT-time bump alone is wrong: correct a
-- meeting's date to something EARLIER and a plain GREATEST() never lowers the
-- cached value. So the insert path is cheap and the edit path recomputes.
-- ---------------------------------------------------------------------
alter table public.companies
  add column if not exists last_interaction_at timestamptz;

-- Two recompute helpers, each doing one party. Every trigger below is a thin
-- wrapper around one of them.
--
-- Deliberately NOT one clever function branching on TG_TABLE_NAME: plpgsql
-- resolves NEW.<field> when it reaches the expression, not when the branch is
-- chosen, so `new.company_id` guarded by a table-name test still raises "record
-- new has no field company_id" on the other table. The same trap applies to
-- NEW in an AFTER DELETE trigger, where NEW is not assigned at all.
create or replace function public.recompute_person_last_interaction(target uuid)
returns void language sql as $$
  update public.people p
     set last_interaction_at = (
       select max(i.occurred_at)
         from public.interaction_participants ip
         join public.interactions i on i.id = ip.interaction_id
        where ip.person_id = target)
   where p.id = target;
$$;

create or replace function public.recompute_company_last_interaction(target uuid)
returns void language sql as $$
  update public.companies c
     set last_interaction_at = (
       select max(i.occurred_at)
         from public.interaction_links il
         join public.interactions i on i.id = il.interaction_id
        where il.company_id = target)
   where c.id = target;
$$;

create or replace function public.participant_changed()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_person_last_interaction(old.person_id);
    return old;
  end if;
  perform public.recompute_person_last_interaction(new.person_id);
  return new;
end $$;

create or replace function public.link_changed()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_company_last_interaction(old.company_id);
    return old;
  end if;
  perform public.recompute_company_last_interaction(new.company_id);
  return new;
end $$;

drop trigger if exists interaction_participants_bump_last
  on public.interaction_participants;
create trigger interaction_participants_bump_last
  after insert or delete on public.interaction_participants
  for each row execute function public.participant_changed();

drop trigger if exists interaction_links_bump_last on public.interaction_links;
create trigger interaction_links_bump_last
  after insert or delete on public.interaction_links
  for each row execute function public.link_changed();

-- Editing a date is the case a cheap insert-time GREATEST() cannot handle:
-- correct a meeting to an EARLIER date and the cached value never comes down.
-- So every party attached to that interaction is recomputed from source.
create or replace function public.recompute_last_interaction_for_interaction()
returns trigger language plpgsql as $$
declare
  target uuid;
begin
  for target in
    select ip.person_id from public.interaction_participants ip
     where ip.interaction_id = new.id and ip.person_id is not null
  loop
    perform public.recompute_person_last_interaction(target);
  end loop;

  for target in
    select il.company_id from public.interaction_links il
     where il.interaction_id = new.id
  loop
    perform public.recompute_company_last_interaction(target);
  end loop;
  return new;
end $$;

drop trigger if exists interactions_recompute_last_interaction on public.interactions;
create trigger interactions_recompute_last_interaction
  after update of occurred_at on public.interactions
  for each row execute function public.recompute_last_interaction_for_interaction();

-- ---------------------------------------------------------------------
-- The feed, assembled once so neither screen has to make three reads.
--
-- Participants and firms are aggregated into arrays rather than joined into
-- rows: a dinner with four people is ONE line in a feed, and a join would make
-- it four.
-- ---------------------------------------------------------------------
create or replace view public.v_interactions as
select
  i.id,
  i.interaction_type::text as interaction_type,
  i.direction::text        as direction,
  i.subject,
  i.ai_summary,
  i.body,
  i.occurred_at,
  i.duration_minutes,
  i.location,
  i.source::text           as source,
  i.sentiment::text        as sentiment,
  i.logged_by,
  pr.email                 as logged_by_email,
  i.created_at,
  coalesce((
    select array_agg(p.full_name order by p.full_name)
      from public.interaction_participants ip
      join public.people p on p.id = ip.person_id
     where ip.interaction_id = i.id), '{}') as people,
  coalesce((
    select array_agg(ip.person_id::text)
      from public.interaction_participants ip
     where ip.interaction_id = i.id and ip.person_id is not null), '{}') as person_ids,
  coalesce((
    select array_agg(c.legal_name order by c.legal_name)
      from public.interaction_links il
      join public.companies c on c.id = il.company_id
     where il.interaction_id = i.id), '{}') as firms,
  coalesce((
    select array_agg(il.company_id::text)
      from public.interaction_links il
     where il.interaction_id = i.id), '{}') as company_ids
from public.interactions i
left join public.profiles pr on pr.id = i.logged_by;

comment on view public.v_interactions is
  'One row per interaction with its people and firms rolled into arrays, so a '
  'dinner with four attendees reads as one line rather than four.';

alter table public.interactions enable row level security;
alter table public.interaction_participants enable row level security;
alter table public.interaction_links enable row level security;

drop policy if exists interactions_read on public.interactions;
create policy interactions_read on public.interactions
  for select to authenticated using (true);

drop policy if exists interaction_participants_read on public.interaction_participants;
create policy interaction_participants_read on public.interaction_participants
  for select to authenticated using (true);

drop policy if exists interaction_links_read on public.interaction_links;
create policy interaction_links_read on public.interaction_links
  for select to authenticated using (true);
