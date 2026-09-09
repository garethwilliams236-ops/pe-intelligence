-- =====================================================================
-- pe-intelligence :: 0014 the Investor Control Sheet as a source
-- =====================================================================
-- The ICS names which investors a specific client approached and which of
-- them declined. That makes it the most sensitive material in the system —
-- more so than the master list, which carries contacts but no outcomes.
-- Registered as `confidential` and non-redistributable so `is_redistributable()`
-- keeps it out of anything client-facing.

insert into public.sources
  (code, name, source_kind, licence_class, is_redistributable,
   requires_attribution, default_confidence, notes)
values
  ('ardent_ics', 'Ardent Investor Control Sheets', 'client_supplied',
   'confidential', false, false, 0.950,
   'Per-client control sheets under Clients - Documents/<client>/Distribution. '
   'Records which investors were selected for a mandate and how far each '
   'progressed. High default confidence: this is Ardent''s own record of what '
   'happened, not an inference.')
on conflict (code) do nothing;
