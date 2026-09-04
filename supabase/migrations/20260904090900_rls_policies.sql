-- =====================================================================
-- pe-intelligence :: 0010 row level security
--
-- Two tiers:
--   knowledge base  — every active user may read; analysts/admins write
--   engagement data — visible only to the mandate team, plus admins
--
-- The crawler and the matching engine run as service_role, which bypasses
-- RLS entirely. Nothing here should be relied on to gate them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active and p.role = 'admin'
  )
$$;

create or replace function public.can_write_reference()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active and p.role in ('admin','analyst')
  )
$$;

create or replace function public.is_mandate_member(p_mandate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
     or exists (
       select 1 from public.mandate_team mt
       where mt.mandate_id = p_mandate_id and mt.user_id = auth.uid()
     )
$$;

-- New auth users get a viewer profile automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','countries','sectors','companies','company_identifiers','company_aliases',
    'company_sectors','people','person_aliases','person_roles','investors',
    'investor_strategies','investor_sector_focus','investor_geography_focus','funds',
    'deals','deal_participants','deal_advisers','deal_people','deal_valuations','investments',
    'fx_rates','company_financials','sources','documents','claims','claim_evidence',
    'crawl_domains','crawl_targets','crawl_runs','crawl_items','extraction_runs','feed_imports',
    'clients','mandates','mandate_team','match_runs','match_run_weights','investor_matches',
    'investor_match_reasons','investor_match_contacts','mandate_investor_outcomes','reports'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Knowledge base: read for every active user, write for analyst/admin
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'countries','sectors','companies','company_identifiers','company_aliases',
    'company_sectors','people','person_aliases','person_roles','investors',
    'investor_strategies','investor_sector_focus','investor_geography_focus','funds',
    'deals','deal_participants','deal_advisers','deal_people','deal_valuations','investments',
    'fx_rates','company_financials','sources',
    'crawl_domains','crawl_targets','crawl_runs','crawl_items','extraction_runs','feed_imports'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_active_user())',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.can_write_reference())',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.can_write_reference()) with check (public.can_write_reference())',
      t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_admin())',
      t || '_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Evidence. Client-supplied material is engagement data, not knowledge
-- base, so confidential rows stay with analysts and admins.
-- ---------------------------------------------------------------------
create policy documents_select on public.documents
  for select to authenticated
  using (
    public.is_active_user()
    and (licence_class <> 'confidential' or public.can_write_reference())
  );

create policy documents_write on public.documents
  for all to authenticated
  using (public.can_write_reference())
  with check (public.can_write_reference());

create policy claims_select on public.claims
  for select to authenticated
  using (
    public.is_active_user()
    and (licence_class <> 'confidential' or public.can_write_reference())
  );

create policy claims_write on public.claims
  for all to authenticated
  using (public.can_write_reference())
  with check (public.can_write_reference());

create policy claim_evidence_select on public.claim_evidence
  for select to authenticated
  using (
    exists (select 1 from public.claims c where c.id = claim_id)
  );

create policy claim_evidence_write on public.claim_evidence
  for all to authenticated
  using (public.can_write_reference())
  with check (public.can_write_reference());

-- ---------------------------------------------------------------------
-- Engagement data: mandate team membership is the gate
-- ---------------------------------------------------------------------
create policy clients_select on public.clients
  for select to authenticated
  using (
    public.is_admin()
    or relationship_owner = auth.uid()
    or exists (
      select 1 from public.mandates m
      join public.mandate_team mt on mt.mandate_id = m.id
      where m.client_id = clients.id and mt.user_id = auth.uid()
    )
  );

create policy clients_write on public.clients
  for all to authenticated
  using (public.can_write_reference())
  with check (public.can_write_reference());

create policy mandates_select on public.mandates
  for select to authenticated
  using (public.is_mandate_member(id));

create policy mandates_insert on public.mandates
  for insert to authenticated
  with check (public.can_write_reference());

create policy mandates_update on public.mandates
  for update to authenticated
  using (public.is_mandate_member(id))
  with check (public.is_mandate_member(id));

create policy mandates_delete on public.mandates
  for delete to authenticated
  using (public.is_admin());

create policy mandate_team_select on public.mandate_team
  for select to authenticated
  using (user_id = auth.uid() or public.is_mandate_member(mandate_id));

create policy mandate_team_write on public.mandate_team
  for all to authenticated
  using (public.is_admin() or exists (
    select 1 from public.mandate_team mt
    where mt.mandate_id = mandate_team.mandate_id
      and mt.user_id = auth.uid()
      and mt.team_role = 'lead'
  ))
  with check (public.is_admin() or exists (
    select 1 from public.mandate_team mt
    where mt.mandate_id = mandate_team.mandate_id
      and mt.user_id = auth.uid()
      and mt.team_role = 'lead'
  ));

-- Tables that reach a mandate directly
do $$
declare t text;
begin
  foreach t in array array['match_runs','mandate_investor_outcomes','reports']
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_mandate_member(mandate_id)) with check (public.is_mandate_member(mandate_id))',
      t || '_team', t);
  end loop;
end $$;

-- Tables that reach a mandate via match_runs
create policy match_run_weights_team on public.match_run_weights
  for all to authenticated
  using (exists (
    select 1 from public.match_runs r
    where r.id = match_run_weights.run_id and public.is_mandate_member(r.mandate_id)))
  with check (exists (
    select 1 from public.match_runs r
    where r.id = match_run_weights.run_id and public.is_mandate_member(r.mandate_id)));

create policy investor_matches_team on public.investor_matches
  for all to authenticated
  using (exists (
    select 1 from public.match_runs r
    where r.id = investor_matches.run_id and public.is_mandate_member(r.mandate_id)))
  with check (exists (
    select 1 from public.match_runs r
    where r.id = investor_matches.run_id and public.is_mandate_member(r.mandate_id)));

-- Tables that reach a mandate via investor_matches
do $$
declare t text;
begin
  foreach t in array array['investor_match_reasons','investor_match_contacts']
  loop
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (exists (
          select 1 from public.investor_matches im
          join public.match_runs r on r.id = im.run_id
          where im.id = %I.match_id and public.is_mandate_member(r.mandate_id)))
        with check (exists (
          select 1 from public.investor_matches im
          join public.match_runs r on r.id = im.run_id
          where im.id = %I.match_id and public.is_mandate_member(r.mandate_id)))
    $f$, t || '_team', t, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Views run with the invoker's permissions so the policies above apply.
-- ---------------------------------------------------------------------
alter view public.v_investments                 set (security_invoker = true);
alter view public.v_deal_headline               set (security_invoker = true);
alter view public.v_redistributable_deal_facts  set (security_invoker = true);
alter view public.v_investor_revealed_sectors   set (security_invoker = true);
alter view public.v_investor_revealed_size      set (security_invoker = true);
alter view public.v_investor_track_record       set (security_invoker = true);
alter view public.v_company_latest_financials   set (security_invoker = true);

-- ---------------------------------------------------------------------
-- Grants. RLS decides the rows; these decide the surface.
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;
