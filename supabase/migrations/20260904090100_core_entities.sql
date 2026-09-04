-- =====================================================================
-- pe-intelligence :: 0002 users, geography, sectors, companies, people
-- =====================================================================

-- ---------------------------------------------------------------------
-- App users
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  full_name     text,
  role          public.app_role not null default 'viewer',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on public.profiles (role) where is_active;

create or replace function public.current_role_is(p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active and role = any(p_roles)
  )
$$;

-- ---------------------------------------------------------------------
-- Geography. Region is what the matching engine actually scores on.
-- ---------------------------------------------------------------------
create table public.countries (
  code        char(2) primary key,           -- ISO 3166-1 alpha-2
  name        text not null,
  region      text not null,                 -- 'UK & Ireland', 'DACH', 'Nordics', ...
  currency    char(3),
  in_scope    boolean not null default false -- crawler coverage flag
);

insert into public.countries (code, name, region, currency, in_scope) values
  ('GB','United Kingdom','UK & Ireland','GBP',true),
  ('IE','Ireland','UK & Ireland','EUR',true),
  ('DE','Germany','DACH','EUR',true),
  ('AT','Austria','DACH','EUR',true),
  ('CH','Switzerland','DACH','CHF',true),
  ('FR','France','France','EUR',true),
  ('NL','Netherlands','Benelux','EUR',true),
  ('BE','Belgium','Benelux','EUR',true),
  ('LU','Luxembourg','Benelux','EUR',true),
  ('SE','Sweden','Nordics','SEK',true),
  ('NO','Norway','Nordics','NOK',true),
  ('DK','Denmark','Nordics','DKK',true),
  ('FI','Finland','Nordics','EUR',true),
  ('IS','Iceland','Nordics','ISK',false),
  ('ES','Spain','Iberia','EUR',true),
  ('PT','Portugal','Iberia','EUR',true),
  ('IT','Italy','Southern Europe','EUR',true),
  ('US','United States','North America','USD',false),
  ('CA','Canada','North America','CAD',false);

-- ---------------------------------------------------------------------
-- Sector taxonomy. Self-referencing so you can score at any depth.
-- ---------------------------------------------------------------------
create table public.sectors (
  id          uuid primary key default gen_random_uuid(),
  taxonomy    text not null default 'ardent',   -- 'ardent' | 'sic' | 'nace' | 'gics'
  code        text not null,
  name        text not null,
  parent_id   uuid references public.sectors(id) on delete set null,
  depth       int not null default 1,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (taxonomy, code)
);

create index on public.sectors (parent_id);

-- ---------------------------------------------------------------------
-- Companies. One row per legal/commercial entity, whatever its role.
-- ---------------------------------------------------------------------
create table public.companies (
  id                uuid primary key default gen_random_uuid(),
  legal_name        text not null,
  display_name      text,
  name_key          text generated always as (public.normalise_name(legal_name)) stored,
  company_types     public.company_type[] not null default '{other}',
  country_code      char(2) references public.countries(code),
  city              text,
  website           text,
  website_domain    text,
  description       text,
  description_embedding extensions.vector(1536),          -- thesis / activity similarity
  founded_year      int check (founded_year between 1600 and 2100),
  is_dissolved      boolean not null default false,
  dissolved_on      date,
  -- entity resolution
  merged_into_id    uuid references public.companies(id) on delete set null,
  confidence        numeric(4,3) not null default 1.000 check (confidence between 0 and 1),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.companies using gin (name_key extensions.gin_trgm_ops);
create index on public.companies using gin (company_types);
create index on public.companies (country_code);
create index on public.companies (website_domain);
create index on public.companies (merged_into_id) where merged_into_id is not null;
create index on public.companies using hnsw (description_embedding extensions.vector_cosine_ops);

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

-- Registry / external identifiers. The spine of entity resolution.
create table public.company_identifiers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  scheme        text not null,   -- 'companies_house','lei','vat','siren','kvk',
                                 -- 'handelsregister','orgnr','cvr','pitchbook_id', ...
  value         text not null,
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (scheme, value)
);

create index on public.company_identifiers (company_id);

create table public.company_aliases (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  alias         text not null,
  alias_key     text generated always as (public.normalise_name(alias)) stored,
  alias_type    text not null default 'trading',  -- trading | former | brand | abbreviation
  created_at    timestamptz not null default now()
);

create index on public.company_aliases (company_id);
create index on public.company_aliases using gin (alias_key extensions.gin_trgm_ops);

create table public.company_sectors (
  company_id    uuid not null references public.companies(id) on delete cascade,
  sector_id     uuid not null references public.sectors(id) on delete cascade,
  is_primary    boolean not null default false,
  weight        numeric(4,3) not null default 1.000 check (weight between 0 and 1),
  primary key (company_id, sector_id)
);

create index on public.company_sectors (sector_id);
create unique index company_sectors_one_primary
  on public.company_sectors (company_id) where is_primary;

-- ---------------------------------------------------------------------
-- People. Partner mobility is the point: a track record follows the
-- individual, not just the firm.
-- ---------------------------------------------------------------------
create table public.people (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null,
  name_key          text generated always as (public.normalise_name(full_name)) stored,
  first_name        text,
  last_name         text,
  linkedin_url      text,
  country_code      char(2) references public.countries(code),
  merged_into_id    uuid references public.people(id) on delete set null,
  confidence        numeric(4,3) not null default 1.000 check (confidence between 0 and 1),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.people using gin (name_key extensions.gin_trgm_ops);
create index on public.people (linkedin_url);

create trigger people_set_updated_at
  before update on public.people
  for each row execute function public.set_updated_at();

create table public.person_aliases (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people(id) on delete cascade,
  alias       text not null,
  alias_key   text generated always as (public.normalise_name(alias)) stored
);

create index on public.person_aliases (person_id);
create index on public.person_aliases using gin (alias_key extensions.gin_trgm_ops);

-- Employment history: who was where, when, at what level.
create table public.person_roles (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references public.people(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  title         text,
  seniority     public.person_seniority not null default 'other',
  start_date    date,
  end_date      date,
  is_current    boolean generated always as (end_date is null) stored,
  source_id     uuid,   -- FK added in 0006 once sources exists
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create index on public.person_roles (person_id);
create index on public.person_roles (company_id);
create index on public.person_roles (company_id, seniority) where end_date is null;

create trigger person_roles_set_updated_at
  before update on public.person_roles
  for each row execute function public.set_updated_at();
