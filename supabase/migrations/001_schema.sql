-- 001_schema: enums, tables, composite foreign keys, indexes. Security is in 002.

create type public.user_role as enum ('owner', 'staff', 'tradespro_admin');
create type public.doc_type as enum ('quotation', 'deposit_invoice', 'balance_invoice', 'receipt', 'guarantee', 'survey_report');
create type public.doc_status as enum ('draft', 'final', 'sent', 'void');
create type public.job_status as enum ('open', 'quoted', 'accepted', 'in_progress', 'complete', 'paid');
create type public.asset_kind as enum ('logo_colour', 'logo_white', 'signature', 'cover_photo', 'diagram', 'badge');
create type public.email_status as enum ('draft', 'sent', 'failed');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trade_type text not null,
  company_number text,
  vat_registered boolean not null default false,
  vat_number text,
  address_lines text[] not null default '{}',
  postcode text,
  phone text,
  email text,
  website text,
  tagline text,
  owner_name text not null,
  owner_title text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role public.user_role not null default 'staff',
  full_name text not null,
  email text not null unique check (email = lower(email)),
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);
create index profiles_tenant_idx on public.profiles (tenant_id);

create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  theme_key text not null default 'fjc',
  colours jsonb not null default '{}',
  fonts jsonb not null default '{}',
  css_overrides text,
  created_at timestamptz not null default now(),
  unique (tenant_id),
  unique (id, tenant_id)
);

create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  brand_kit_id uuid not null,
  kind public.asset_kind not null,
  storage_path text not null,
  width int,
  height int,
  alt text not null default '',
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (brand_kit_id, tenant_id) references public.brand_kits (id, tenant_id) on delete cascade
);

create table public.job_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null,
  guarantee_years int check (guarantee_years is null or guarantee_years between 1 and 50),
  cover_asset_id uuid,
  diagram_asset_id uuid,
  spec_blurb text,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (id, tenant_id),
  foreign key (cover_asset_id, tenant_id) references public.brand_assets (id, tenant_id) on delete set null (cover_asset_id),
  foreign key (diagram_asset_id, tenant_id) references public.brand_assets (id, tenant_id) on delete set null (diagram_asset_id)
);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  account_name text not null,
  bank_name text not null,
  sort_code_enc text not null,
  account_number_enc text not null,
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index bank_accounts_one_default on public.bank_accounts (tenant_id) where is_default and archived_at is null;

create table public.tenant_defaults (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  deposit_pct_bp int not null default 3000 check (deposit_pct_bp between 0 and 10000),
  quote_validity_days int not null default 30 check (quote_validity_days > 0),
  vat_default boolean not null default true,
  vat_rate_bp int not null default 2000 check (vat_rate_bp between 0 and 10000),
  terms jsonb not null default '{}',
  disclaimer_text text not null default '',
  number_formats jsonb not null default '{}'
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  address_lines text[] not null default '{}',
  postcode text,
  email text,
  phone text,
  last_activity_at timestamptz not null default now(),
  purge_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create index customers_tenant_name_idx on public.customers (tenant_id, name);
create index customers_purge_idx on public.customers (purge_at);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  reference text not null check (reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$'),
  property_address text,
  job_type_id uuid,
  status public.job_status not null default 'open',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, reference),
  unique (id, tenant_id),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade,
  foreign key (job_type_id, tenant_id) references public.job_types (id, tenant_id) on delete set null (job_type_id)
);
create index jobs_customer_idx on public.jobs (customer_id);

create table public.used_numbers (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  number text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, number)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  type public.doc_type not null,
  number text not null,
  doc_date date not null default current_date,
  status public.doc_status not null default 'draft',
  current_version_id uuid,
  total_pence bigint check (total_pence is null or total_pence >= 0),
  balance_pence bigint check (balance_pence is null or balance_pence >= 0),
  pdf_path text,
  finalised_at timestamptz,
  sent_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, number),
  unique (id, tenant_id),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (job_id, tenant_id) references public.jobs (id, tenant_id) on delete cascade
);
create index documents_job_idx on public.documents (job_id);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  version int not null check (version >= 1),
  input jsonb not null default '{}',
  ai_output jsonb,
  final_content jsonb,
  money jsonb,
  bank_account_id uuid,
  pdf_path text,
  finalised_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (document_id, version),
  unique (id, tenant_id),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (document_id, tenant_id) references public.documents (id, tenant_id) on delete cascade,
  foreign key (bank_account_id, tenant_id) references public.bank_accounts (id, tenant_id) on delete set null (bank_account_id)
);

alter table public.documents
  add foreign key (current_version_id, tenant_id) references public.document_versions (id, tenant_id)
  on delete set null (current_version_id) deferrable initially deferred;

create table public.job_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  finding_ref text,
  storage_path text not null,
  width int,
  height int,
  created_at timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (job_id, tenant_id) references public.jobs (id, tenant_id) on delete cascade
);

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (document_id, tenant_id) references public.documents (id, tenant_id) on delete cascade
);

create table public.document_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  to_email text,
  subject text not null default '',
  body text not null default '',
  status public.email_status not null default 'draft',
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (document_id, tenant_id) references public.documents (id, tenant_id) on delete cascade
);

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid,
  model text not null,
  input_tokens int,
  output_tokens int,
  valid boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (document_id, tenant_id) references public.documents (id, tenant_id) on delete set null (document_id)
);

-- No foreign keys: the audit trail must survive deletions. It never holds personal data.
create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  user_id uuid,
  impersonator_id uuid,
  action text not null,
  entity text,
  entity_id text,
  ip inet,
  user_agent text,
  meta jsonb not null default '{}',
  at timestamptz not null default now()
);
create index audit_log_tenant_at_idx on public.audit_log (tenant_id, at desc);

create table public.login_attempts (
  id bigint generated always as identity primary key,
  email_hash text not null,
  ip inet,
  kind text not null check (kind in ('request', 'verify')),
  success boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_email_at_idx on public.login_attempts (email_hash, at desc);
create index login_attempts_ip_at_idx on public.login_attempts (ip, at desc);

create table public.purge_log (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  customers_purged int not null
);
