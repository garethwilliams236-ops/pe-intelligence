-- =====================================================================
-- pe-intelligence :: 0006 the evidence engine
--
-- Everything the product asserts to a client must be traceable to a
-- document, and every document carries a licence class that decides
-- whether the fact may be reproduced in a marketing report.
-- =====================================================================

create table public.sources (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,   -- 'companies_house','ft','unquote','pitchbook', ...
  name              text not null,
  source_kind       text not null,          -- registry | press | sponsor_site | filing
                                            -- | licensed_feed | client_supplied | manual
  publisher         text,
  base_url          text,
  licence_class     public.licence_class not null default 'public_attributable',
  is_redistributable boolean not null default false,   -- may quote verbatim to a client
  requires_attribution boolean not null default true,
  default_confidence numeric(4,3) not null default 0.700 check (default_confidence between 0 and 1),
  contract_expires_on date,
  notes             text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.sources (licence_class);

create trigger sources_set_updated_at
  before update on public.sources
  for each row execute function public.set_updated_at();

insert into public.sources (code, name, source_kind, licence_class, is_redistributable, default_confidence) values
  ('companies_house','Companies House','registry','public_domain',true,0.950),
  ('cro_ie','Companies Registration Office (IE)','registry','public_domain',true,0.900),
  ('handelsregister','Handelsregister (DE)','registry','public_domain',true,0.900),
  ('kvk','KVK (NL)','registry','public_domain',true,0.900),
  ('infogreffe','Infogreffe (FR)','registry','public_domain',true,0.900),
  ('sponsor_site','Sponsor website','sponsor_site','public_attributable',true,0.850),
  ('press','Press / trade media','press','public_attributable',true,0.650),
  ('manual','Analyst entry','manual','public_attributable',true,0.800),
  ('client_supplied','Client supplied','client_supplied','confidential',false,0.900);

-- ---------------------------------------------------------------------
-- Documents: the fetched artefact itself, hashed for change detection
-- and parked in Supabase Storage so a claim can always be re-checked.
-- ---------------------------------------------------------------------
create table public.documents (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references public.sources(id) on delete restrict,
  url               text,
  canonical_url     text,
  title             text,
  published_at      timestamptz,
  retrieved_at      timestamptz not null default now(),
  http_status       int,
  content_type      text,
  content_hash      text,                  -- sha256 of normalised body
  storage_bucket    text default 'evidence',
  storage_path      text,
  byte_size         bigint,
  language          char(2),
  extracted_text    text,
  licence_class     public.licence_class not null default 'public_attributable',
  created_at        timestamptz not null default now()
);

create index on public.documents (source_id);
create index on public.documents (content_hash);
create index on public.documents (canonical_url);
create index on public.documents (published_at desc nulls last);
create unique index documents_url_hash_uniq
  on public.documents (coalesce(canonical_url, url), content_hash)
  where url is not null;

-- ---------------------------------------------------------------------
-- Claims: the extraction layer. A claim is an assertion about one
-- attribute of one row, before it is promoted into the typed tables.
-- Conflicting claims coexist; promotion is a deliberate, auditable act.
-- ---------------------------------------------------------------------
create table public.claims (
  id                uuid primary key default gen_random_uuid(),
  subject_table     text not null,        -- 'deals','investments','companies', ...
  subject_id        uuid,                 -- null while the subject is still being created
  subject_key       text,                 -- natural key when subject_id is unknown
  attribute         text not null,        -- 'enterprise_value','exit_date','ebitda', ...
  value_text        text,
  value_numeric     numeric(20,4),
  value_date        date,
  value_json        jsonb,
  unit              text,
  currency          char(3),
  status            public.claim_status not null default 'candidate',
  confidence        numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  licence_class     public.licence_class not null default 'public_attributable',
  extracted_by      text,                 -- model id or parser name
  extraction_version text,
  supersedes_id     uuid references public.claims(id) on delete set null,
  reviewed_by       uuid references public.profiles(id) on delete set null,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.claims (subject_table, subject_id);
create index on public.claims (subject_table, attribute, status);
create index on public.claims (status) where status = 'candidate';
create index on public.claims (subject_key) where subject_key is not null;
create index on public.claims using gin (value_json);

create trigger claims_set_updated_at
  before update on public.claims
  for each row execute function public.set_updated_at();

-- A claim may rest on several documents, and a document supports many
-- claims — hence a junction, with the quoted span kept for citation.
create table public.claim_evidence (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.claims(id) on delete cascade,
  document_id   uuid not null references public.documents(id) on delete cascade,
  quote         text,
  char_start    int,
  char_end      int,
  page_number   int,
  created_at    timestamptz not null default now()
);

create unique index claim_evidence_uniq
  on public.claim_evidence (claim_id, document_id, coalesce(char_start, -1));
create index on public.claim_evidence (document_id);

-- ---------------------------------------------------------------------
-- Back-fill the source_id FKs deferred from earlier migrations.
-- ---------------------------------------------------------------------
alter table public.person_roles
  add constraint person_roles_source_fk
  foreign key (source_id) references public.sources(id) on delete set null;

alter table public.deal_people
  add constraint deal_people_source_fk
  foreign key (source_id) references public.sources(id) on delete set null;

alter table public.deal_valuations
  add constraint deal_valuations_source_fk
  foreign key (source_id) references public.sources(id) on delete set null;

alter table public.investments
  add constraint investments_source_fk
  foreign key (source_id) references public.sources(id) on delete set null;

alter table public.company_financials
  add constraint company_financials_source_fk
  foreign key (source_id) references public.sources(id) on delete set null;

-- ---------------------------------------------------------------------
-- Redistribution gate. If a fact cannot pass this, it cannot appear in
-- a client-facing report — regardless of who generated the report.
-- ---------------------------------------------------------------------
create or replace function public.is_redistributable(p_licence public.licence_class)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_licence in ('public_domain', 'public_attributable')
$$;
