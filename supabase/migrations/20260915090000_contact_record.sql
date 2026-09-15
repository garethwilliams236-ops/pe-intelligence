-- =====================================================================
-- pe-intelligence :: 0028 the contact record, matching the IB CRM
-- =====================================================================
-- A fund contact here and a contact in the CRM are the same person doing the
-- same job, and they should carry the same fields — otherwise moving someone
-- from one system to the other loses half of what is known about them.
--
-- The CRM keeps contacts + contact_history; this schema already has people +
-- person_roles, which is the same split under different names. So this adds the
-- fields that were missing rather than introducing a parallel table.
--
-- Three deliberate differences:
--
--   seniority stays person_seniority, not the CRM's contact_seniority. Ours has
--   managing_partner, partner, principal, venture_partner — the vocabulary of a
--   fund, not of a corporate. c_suite / evp / svp describes the wrong industry.
--
--   Addresses and phones hang off the ROLE, not the person, as they already do
--   here: an address is a person at a firm, and when they move, the old one
--   stops working. The CRM puts them on the contact and syncs the current
--   employer with a trigger — same intent, different end of the join.
--
--   coverage_banker is free text, not a foreign key. The CRM points at its own
--   user table, which does not exist in this database; a name we can read beats
--   an id that resolves to nothing.
--
-- CONFIDENTIAL, as 0020 was: emails[] and phones[] hold named individuals' work
-- details from Ardent's master list. Never returned by a list endpoint, never
-- exported in bulk. The view below exposes has_email / has_phone, not values.

do $$ begin
  create type public.contact_function as enum
    ('ceo', 'cfo', 'coo', 'corp_dev', 'gc', 'ir', 'board', 'other');
exception when duplicate_object then null;
end $$;

alter table public.people
  add column if not exists middle_name         text,
  add column if not exists preferred_name      text,
  add column if not exists bio                 text,
  add column if not exists location_city       text,
  add column if not exists location_country    char(2),
  add column if not exists do_not_contact      boolean not null default false,
  add column if not exists last_interaction_at timestamptz,
  add column if not exists custom_fields       jsonb not null default '{}'::jsonb,
  add column if not exists assistant_person_id uuid references public.people(id)
                                               on delete set null;

comment on column public.people.do_not_contact is
  'Set by an analyst. Nothing in this system should surface an address for '
  'somebody flagged here, whatever else the record says.';

alter table public.person_roles
  add column if not exists function        public.contact_function,
  add column if not exists emails          text[] not null default '{}',
  add column if not exists phones          text[] not null default '{}',
  add column if not exists coverage_banker text,
  add column if not exists start_note      text;

comment on column public.person_roles.emails is
  'Secondary work addresses. email stays the primary. Confidential: Ardent '
  'master list, non-redistributable. Never in a list response or bulk export.';

-- Whatever 0020 already recovered is the primary address; make it the first
-- entry of the array too, so a contact page can read one column.
update public.person_roles
   set emails = array[email]
 where email is not null and cardinality(emails) = 0;

update public.person_roles
   set phones = array[phone]
 where phone is not null and cardinality(phones) = 0;

-- ---------------------------------------------------------------------
-- The team view gains what a contact page needs without a second read.
--
-- The new columns are APPENDED, not slotted in beside their relatives.
-- CREATE OR REPLACE VIEW can only add columns at the end, and two views —
-- v_investor_universe and v_refresh_queue — select from this one, so dropping
-- it to get a tidier column order would take them with it.
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
  end as rank,
  r.id            as role_id,
  p.first_name,
  p.last_name,
  p.preferred_name,
  r.function::text as function,
  (r.phone is not null or cardinality(r.phones) > 0) as has_phone,
  p.do_not_contact,
  p.location_city,
  p.last_interaction_at
from public.person_roles r
join public.people p on p.id = r.person_id
where p.merged_into_id is null;

comment on view public.v_investor_team is
  'One row per person at a fund, key contact first then by seniority. Exposes '
  'has_email and has_phone rather than the values, so a roster can show who is '
  'reachable without distributing anyone''s details.';
