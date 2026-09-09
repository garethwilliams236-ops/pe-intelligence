-- =====================================================================
-- pe-intelligence :: 0015 client documents as a source of mandate briefs
-- =====================================================================
-- A mandate's brief — sector, size, stage, what was being sold or raised —
-- can arrive three ways: an analyst types it, it is extracted from the
-- client's own Executive Summary or teaser, or it is inferred from the
-- register and the web. All three write claims against the mandate and the
-- highest-confidence claim per attribute wins on promotion, so a hand-entered
-- EBITDA beats an extracted one and an extracted one beats an inferred one.
--
-- `manual` (0.800) and `client_supplied` (0.900) already exist. This adds the
-- document-extraction source, confidential because Executive Summaries are the
-- client's own material.

insert into public.sources
  (code, name, source_kind, licence_class, is_redistributable,
   requires_attribution, default_confidence, notes)
values
  ('ardent_client_docs', 'Ardent client documents (Exec Summary, teaser, IM)',
   'client_supplied', 'confidential', false, false, 0.850,
   'Mandate briefs extracted from documents in Clients - Documents/<client>/. '
   'Lower confidence than analyst entry because extraction can misread a '
   'figure; higher than inference because the document is the client''s own.'),
  ('inferred', 'Inferred from register and public web', 'manual',
   'public_attributable', true, true, 0.600,
   'Last resort for a mandate attribute with no better source. Size inferred '
   'today is not size at the time of the mandate, which is the dimension '
   'matching most depends on — treat with suspicion.')
on conflict (code) do nothing;
