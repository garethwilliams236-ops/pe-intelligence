-- =====================================================================
-- pe-intelligence :: 0025 who is allowed in
-- =====================================================================
-- Sign-in on its own is not access control. Supabase will happily create an
-- account for anyone who asks for a magic link, and handle_new_user() gave
-- every one of them an ACTIVE viewer profile — so "add authentication" without
-- this migration would have meant anybody with an email address could read the
-- Investor Bible and pull contact addresses out of it.
--
-- The gate: a new account is active only if its address is at Ardent. Everyone
-- else lands inactive and sees nothing until an admin turns them on. Gareth is
-- seeded as the admin, because a system where the first user has to be
-- activated by an admin who does not exist yet cannot be logged into at all.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_ardent boolean := new.email ilike '%@ardentadvisors.com';
begin
  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    case when new.email ilike 'gwilliams@ardentadvisors.com' then 'admin'
         else 'viewer' end::public.app_role,
    is_ardent
  )
  on conflict (id) do update
    -- An existing profile keeps whatever role and standing an admin gave it;
    -- signing in again must never quietly re-grant or revoke access.
    set email = excluded.email;
  return new;
end;
$$;

comment on function public.handle_new_user is
  'Creates a profile on signup. Active only for @ardentadvisors.com addresses; '
  'anyone else is created inactive and cannot use the application until an '
  'admin activates them.';

-- Who may edit the Bible, as opposed to read it. Viewers can look; changing a
-- fund's record or accepting a scraped proposal is an analyst's job, and the
-- audit trail is worth much less if it cannot say which of those a person was.
create or replace function public.can_edit_investors()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active and p.role in ('admin', 'analyst')
  )
$$;

-- Backfill: any profile already created by the old trigger during local testing
-- that is not an Ardent address loses its standing now rather than later.
update public.profiles
   set is_active = false
 where is_active
   and email not ilike '%@ardentadvisors.com';
