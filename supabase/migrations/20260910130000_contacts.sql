-- =====================================================================
-- pe-intelligence :: 0020 contact details, and a designated key contact
-- =====================================================================
-- WP2 parsed "Contact 1 email" and its siblings out of the master workbook,
-- staged them in a temp table, and then inserted only name and title, because
-- person_roles had nowhere to put an address. Several hundred addresses were
-- read and discarded on every run. This adds the column and the backfill puts
-- them back.
--
-- The address hangs off person_roles rather than people ON PURPOSE. An address
-- is a person AT A FIRM: when a partner moves, the old one stops working and
-- the schema should say so rather than silently keeping a dead address against
-- a name. It is the same reason person_roles exists at all.
--
-- CONFIDENTIAL. These are named individuals' work addresses from Ardent's own
-- master list, loaded under a non-redistributable licence. They must not be
-- returned by any list endpoint or exported in bulk — the UI reveals one
-- address at a time, on request, for a fund the user has opened.

alter table public.person_roles
  add column if not exists email          text,
  add column if not exists phone          text,
  add column if not exists is_key_contact boolean not null default false;

comment on column public.person_roles.email is
  'Work address at THIS firm. Confidential: Ardent master list, '
  'non-redistributable. Never include in a list response or a bulk export.';

comment on column public.person_roles.is_key_contact is
  'The contact named against this fund on the Investor Control Sheet — who '
  'Ardent actually calls, which is not always the most senior name on file.';

-- At most one key contact per firm; a second one is a data error, not a choice.
create unique index if not exists person_roles_one_key_contact
  on public.person_roles (company_id) where is_key_contact;

-- ---------------------------------------------------------------------
-- The team behind a fund, ordered the way a banker would read it: the
-- designated contact first, then by seniority. The enum's own order puts
-- analysts above chairs and chief executives, so seniority is ranked
-- explicitly here rather than sorted on the type.
-- ---------------------------------------------------------------------
create or replace view public.v_investor_team as
select
  r.company_id,
  p.id            as person_id,
  p.full_name,
  r.title,
  r.seniority::text as seniority,
  r.is_key_contact,
  r.email is not null as has_email,
  p.linkedin_url,
  r.start_date,
  r.end_date,
  r.is_current,
  case when r.is_key_contact then 0 else
    case r.seniority
      when 'managing_partner'       then 1
      when 'ceo'                    then 2
      when 'chair'                  then 3
      when 'partner'                then 4
      when 'operating_partner'      then 5
      when 'venture_partner'        then 6
      when 'principal'              then 7
      when 'director'               then 8
      when 'investment_manager'     then 9
      when 'cfo'                    then 10
      when 'other_executive'        then 11
      when 'non_executive_director' then 12
      when 'associate'              then 13
      when 'analyst'                then 14
      else 15
    end
  end as rank
from public.person_roles r
join public.people p on p.id = r.person_id
where p.merged_into_id is null;

comment on view public.v_investor_team is
  'One row per person at a fund, key contact first then by seniority. Exposes '
  'has_email rather than the address itself, so a team list can show who is '
  'reachable without distributing anyone''s address.';
