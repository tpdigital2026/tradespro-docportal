# Database and Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The multi-tenant Postgres schema on the hosted Supabase project, with row level security that provably isolates one business from another, encrypted bank details, login protection, step-up checks, an append-only audit log, the 30-day customer purge, and FJC seeded as the first tenant.

**Architecture:** SQL migrations in `supabase/migrations/` applied by a small runner over `pg` (the `DATABASE_URL` in `.env.local`). The signed-in app role (`authenticated`) gets only the privileges its policies need; everything sensitive is server-only via the service role. TypeScript modules under `src/db/` and `src/security/` hold the pure logic (encryption, lockout decisions, step-up, audit redaction) with unit tests, and database tests run inside transactions that are always rolled back.

**Tech Stack:** PostgreSQL 17 (Supabase), pg, zod, @supabase/supabase-js (invite script only), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-docportal-design.md` (read the Schema, Auth and Decisions update sections).

## Global Constraints

- The database is the shared hosted Supabase dev project. Never commit `.env*`, keys, passwords or any client personal data. Never print or log `DATABASE_URL`, passwords, keys or bank details.
- Tests must leave the database unchanged: every DB test runs in a transaction that is rolled back. The only committed writes are the migrations and the one-off FJC seed (Task 6).
- Every table in `public` has row level security enabled and forced. The `anon` role has no privileges on anything. The `authenticated` role has only the grants named in this plan.
- Tenant integrity: child rows reference parents with composite foreign keys `(id, tenant_id)` so a row can never point at another tenant's parent.
- Bank sort codes and account numbers are encrypted in the application (AES-256-GCM) before they reach the database. The `authenticated` role cannot read or write the encrypted columns.
- Sensitive writes (bank accounts, customer deletion, invites, audit entries) are server-only using the service role, after a step-up check.
- The audit log never stores names, emails, phones, addresses, sort codes or account numbers.
- Money is integer pence only (`bigint`), never floats.
- Use relative imports (no path aliases). UK English. No em dashes in code comments or copy.
- Commit locally only; Alfie pushes with GitHub Desktop.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/env.ts` | Find `DATABASE_URL` (env var or `.env.local`) |
| `src/db/connect.ts` | `connect()` a `pg` client with SSL |
| `src/db/migrate.ts` | `applyMigrations(client, dir)` runner |
| `scripts/migrate.ts` | CLI: apply all pending migrations |
| `supabase/migrations/001_schema.sql` | Enums, tables, composite foreign keys, indexes |
| `supabase/migrations/002_security.sql` | Private helper functions, grants, RLS policies, triggers |
| `supabase/migrations/003_purge.sql` | Purge and erase functions (service role only) |
| `src/security/bank-crypto.ts` | AES-256-GCM for bank details |
| `src/security/login-guard.ts` | Email hashing, lockout and code-request decisions, attempt storage |
| `src/security/step-up.ts` | Fresh email-code check on JWT claims |
| `src/security/audit.ts` | Audit writer with personal-data refusal |
| `src/db/wording.ts` | zod schema for tenant wording (`tenant_defaults.terms`) |
| `src/db/seed-fjc.ts`, `scripts/seed-fjc.ts` | Seed FJC tenant, defaults, job types, brand kit |
| `src/db/invite.ts`, `scripts/invite-user.ts` | Invite a person to a tenant |
| `tests/db/helpers.ts` | Rolled-back transactions, acting as a user |
| `tests/db/*.test.ts`, `tests/unit/*.test.ts` | Tests |
| `vitest.db.config.mts` | Config for DB tests |

---

### Task 1: Connection, migration runner and the schema

**Files:**
- Create: `src/db/env.ts`, `src/db/connect.ts`, `src/db/migrate.ts`, `scripts/migrate.ts`, `supabase/migrations/001_schema.sql`, `vitest.db.config.mts`, `tests/db/helpers.ts`
- Modify: `package.json` (scripts)
- Test: `tests/db/schema.test.ts`, `tests/unit/migrate.test.ts`

**Interfaces:**
- Produces:
  - `databaseUrl(): string | null`
  - `connect(): Promise<Client>` (pg `Client`, connected, SSL with `rejectUnauthorized:false`)
  - `applyMigrations(client: Client, dir: string): Promise<string[]>` (names applied this run, in order; idempotent; each file in its own transaction; tracked in `public._migrations`)
  - Test helpers `dbAvailable`, `withRollback(fn)`, `actAs(client, userId)`, `actAsServer(client)`, `createTenantWithUser(client, name)` returning `{ tenantId, userId }`.

- [ ] **Step 1: Write the config, helpers and failing tests**

`vitest.db.config.mts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
```

`package.json` scripts to add (run `npm pkg set`):
```bash
npm pkg set scripts.test:db="vitest run -c vitest.db.config.mts" scripts.db:migrate="tsx scripts/migrate.ts" scripts.db:seed="tsx scripts/seed-fjc.ts"
```

`tests/db/helpers.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { connect } from '../../src/db/connect';
import { databaseUrl } from '../../src/db/env';

export const dbAvailable = databaseUrl() !== null;

/** Runs fn in a transaction that is always rolled back, so tests leave no trace. */
export async function withRollback<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect();
  try {
    await c.query('begin');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
}

/** Act as a signed-in user for the rest of the transaction; row level security applies. */
export async function actAs(c: Client, userId: string): Promise<void> {
  await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
}

/** Back to the connection's own role (bypasses row level security, like the server). */
export async function actAsServer(c: Client): Promise<void> {
  await c.query('reset role');
}

export async function createTenantWithUser(c: Client, name: string): Promise<{ tenantId: string; userId: string }> {
  const t = await c.query(
    `insert into public.tenants (name, trade_type, owner_name, owner_title) values ($1, 'roofing', 'Test Owner', 'Director') returning id`,
    [name],
  );
  const tenantId = t.rows[0].id as string;
  const userId = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`,
    [userId, `${userId}@example.test`],
  );
  await c.query(
    `insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Test Owner', $3)`,
    [userId, tenantId, `${userId}@example.test`],
  );
  return { tenantId, userId };
}
```

`tests/unit/migrate.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';

// A minimal in-memory stand-in for a pg client, enough to check ordering, idempotency and rollback.
function fakeClient(failOn?: string) {
  const applied = new Set<string>();
  const log: string[] = [];
  return {
    log,
    applied,
    async query(sql: string, params?: unknown[]) {
      log.push(sql.trim().split('\n')[0]);
      if (sql.includes('select name from public._migrations')) return { rows: [...applied].map((name) => ({ name })) };
      if (sql.startsWith('insert into public._migrations')) applied.add(String(params?.[0]));
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    },
  };
}

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'mig-'));
  for (const [n, s] of Object.entries(files)) writeFileSync(path.join(d, n), s);
  return d;
}

describe('applyMigrations', () => {
  it('applies .sql files in name order and records them', async () => {
    const c = fakeClient();
    const dir = dirWith({ '002_b.sql': 'select 2;', '001_a.sql': 'select 1;', 'notes.txt': 'ignore' });
    expect(await applyMigrations(c as never, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect([...c.applied]).toEqual(['001_a.sql', '002_b.sql']);
  });
  it('skips migrations already applied', async () => {
    const c = fakeClient();
    c.applied.add('001_a.sql');
    const dir = dirWith({ '001_a.sql': 'select 1;', '002_b.sql': 'select 2;' });
    expect(await applyMigrations(c as never, dir)).toEqual(['002_b.sql']);
  });
  it('rolls back and rethrows when a migration fails, without recording it', async () => {
    const c = fakeClient('select bad;');
    const dir = dirWith({ '001_a.sql': 'select bad;' });
    await expect(applyMigrations(c as never, dir)).rejects.toThrow('boom');
    expect(c.applied.size).toBe(0);
    expect(c.log).toContain('rollback');
  });
});
```

`tests/db/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

const EXPECTED = [
  'tenants', 'profiles', 'brand_kits', 'brand_assets', 'job_types', 'bank_accounts', 'tenant_defaults',
  'customers', 'jobs', 'used_numbers', 'documents', 'document_versions', 'job_photos', 'share_links',
  'document_emails', 'ai_runs', 'audit_log', 'login_attempts', 'purge_log',
];

describe.skipIf(!dbAvailable)('schema', () => {
  it('has every table from the spec', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select tablename from pg_tables where schemaname = 'public'`);
      const have = r.rows.map((x) => x.tablename);
      for (const t of EXPECTED) expect(have).toContain(t);
    });
  });

  it('stores money as bigint pence', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select column_name, data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'documents' and column_name in ('total_pence', 'balance_pence')`,
      );
      expect(r.rows).toHaveLength(2);
      r.rows.forEach((x) => expect(x.data_type).toBe('bigint'));
    });
  });

  it('rejects a job that points at another tenant\'s customer (composite foreign key)', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Tenant A');
      const b = await createTenantWithUser(c, 'Tenant B');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'B Customer') returning id`, [b.tenantId]);
      await expect(
        c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-X-001')`, [a.tenantId, cust.rows[0].id]),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  it('allows only one default bank account per tenant', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Tenant A');
      const ins = `insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4, is_default)
                   values ($1, 'x', 'y', 'enc', 'enc', '0000', true)`;
      await c.query(ins, [a.tenantId]);
      await expect(c.query(ins, [a.tenantId])).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it('keeps quote references unique per tenant', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Tenant A');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [a.tenantId]);
      const ins = `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-JS-001')`;
      await c.query(ins, [a.tenantId, cust.rows[0].id]);
      await expect(c.query(ins, [a.tenantId, cust.rows[0].id])).rejects.toThrow(/duplicate key|unique/i);
    });
  });
});
```
(The last test also passes on the unique index alone; the used-number trigger arrives in Task 2.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/migrate.test.ts` then `npm run test:db`
Expected: the unit test FAILs (cannot resolve `src/db/migrate`); DB tests fail (cannot resolve helpers' imports).

- [ ] **Step 3: Implement the connection and runner**

`src/db/env.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** DATABASE_URL from the environment, else from .env.local. Returns null if unset or still a template. */
export function databaseUrl(): string | null {
  const fromEnv = process.env.DATABASE_URL;
  const value = fromEnv ?? readLocal();
  if (!value || value.includes('YOUR-PASSWORD')) return null;
  return value;
}

function readLocal(): string | undefined {
  const file = path.join(process.cwd(), '.env.local');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
  return line?.slice('DATABASE_URL='.length).trim();
}
```

`src/db/connect.ts`:
```ts
import { Client } from 'pg';
import { databaseUrl } from './env';

export async function connect(): Promise<Client> {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}
```

`src/db/migrate.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';

type Queryable = Pick<Client, 'query'>;

/** Applies pending .sql files in name order, each in its own transaction. Returns the names applied. */
export async function applyMigrations(client: Queryable, dir: string): Promise<string[]> {
  await client.query(`create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())`);
  await client.query(`alter table public._migrations enable row level security`);
  await client.query(`revoke all on public._migrations from anon, authenticated`);
  const done = new Set((await client.query('select name from public._migrations')).rows.map((r: { name: string }) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    await client.query('begin');
    try {
      await client.query(readFileSync(path.join(dir, file), 'utf8'));
      await client.query('insert into public._migrations (name) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
  }
  return applied;
}
```

`scripts/migrate.ts`:
```ts
import path from 'node:path';
import { connect } from '../src/db/connect';
import { applyMigrations } from '../src/db/migrate';

async function main() {
  const client = await connect();
  try {
    const applied = await applyMigrations(client, path.join(process.cwd(), 'supabase', 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
```

- [ ] **Step 4: Write the schema migration**

`supabase/migrations/001_schema.sql`:
```sql
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
```

- [ ] **Step 5: Apply and verify**

Run: `npm run db:migrate`
Expected: `Applied: 001_schema.sql`. Run it again: `Nothing to apply.`
Then: `npx vitest run tests/unit/migrate.test.ts && npm run test:db && npx tsc --noEmit`
Expected: all PASS. If inserting into `auth.users` is refused for the connecting role in the helper, report the exact error and the role privileges (do not weaken tests): the helper may need extra columns or the fixture may need to run as a different role.

- [ ] **Step 6: Commit**

```bash
git add src/db scripts/migrate.ts supabase tests/db tests/unit/migrate.test.ts vitest.db.config.mts package.json
git commit -m "feat: database schema, migration runner and DB test helpers"
```

---

### Task 2: Row level security, grants and integrity triggers

**Files:**
- Create: `supabase/migrations/002_security.sql`
- Test: `tests/db/isolation.test.ts`, `tests/db/integrity.test.ts`

**Interfaces:**
- Consumes: the schema and the DB test helpers.
- Produces: functions `private.current_tenant_id()` and `private.is_owner()` (callable by `authenticated` and `service_role`), RLS on every public table, and the triggers described below.

- [ ] **Step 1: Write the failing tests**

`tests/db/isolation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { actAs, actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function seedTenant(c: import('pg').Client, name: string) {
  const t = await createTenantWithUser(c, name);
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, $2) returning id`, [t.tenantId, `${name} Customer`]);
  const job = await c.query(
    `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`,
    [t.tenantId, cust.rows[0].id, `QT-${name.replace(/\W/g, '')}-001`],
  );
  const doc = await c.query(
    `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', $3) returning id`,
    [t.tenantId, job.rows[0].id, `QT-${name.replace(/\W/g, '')}-001`],
  );
  await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1)`, [t.tenantId, doc.rows[0].id]);
  await c.query(
    `insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4) values ($1, 'Acc', 'Bank', 'enc', 'enc', '1234')`,
    [t.tenantId],
  );
  const kit = await c.query(`insert into public.brand_kits (tenant_id) values ($1) returning id`, [t.tenantId]);
  await c.query(`insert into public.job_types (tenant_id, key, label) values ($1, 'flat_roof', 'Flat roof')`, [t.tenantId]);
  await c.query(`insert into public.tenant_defaults (tenant_id) values ($1)`, [t.tenantId]);
  await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'test')`, [t.tenantId]);
  return { ...t, customerId: cust.rows[0].id as string, jobId: job.rows[0].id as string, docId: doc.rows[0].id as string, kitId: kit.rows[0].id as string };
}

const TENANT_TABLES = [
  'customers', 'jobs', 'documents', 'document_versions', 'brand_kits', 'job_types', 'tenant_defaults', 'used_numbers',
];

describe.skipIf(!dbAvailable)('tenant isolation', () => {
  it('user A sees only tenant A rows in every tenant table', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      for (const t of TENANT_TABLES) {
        const own = await c.query(`select count(*)::int n from public.${t} where tenant_id = $1`, [a.tenantId]);
        const other = await c.query(`select count(*)::int n from public.${t} where tenant_id = $1`, [b.tenantId]);
        expect(own.rows[0].n, `${t} own`).toBeGreaterThan(0);
        expect(other.rows[0].n, `${t} other`).toBe(0);
      }
      const profiles = await c.query(`select tenant_id from public.profiles`);
      expect(profiles.rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);
      const tenants = await c.query(`select id from public.tenants`);
      expect(tenants.rows.map((r) => r.id)).toEqual([a.tenantId]);
    });
  });

  it('user A cannot insert into or update tenant B', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      await c.query('savepoint s1');
      await expect(c.query(`insert into public.customers (tenant_id, name) values ($1, 'Intruder')`, [b.tenantId])).rejects.toThrow(/row-level security/i);
      await c.query('rollback to savepoint s1');
      const upd = await c.query(`update public.customers set name = 'Hacked' where id = $1`, [b.customerId]);
      expect(upd.rowCount).toBe(0);
      await actAsServer(c);
      const still = await c.query(`select name from public.customers where id = $1`, [b.customerId]);
      expect(still.rows[0].name).toBe('Bravo Customer');
    });
  });

  it('user A cannot move their own row into tenant B', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      await c.query('savepoint s1');
      await expect(c.query(`update public.customers set tenant_id = $1 where id = $2`, [b.tenantId, a.customerId])).rejects.toThrow(/row-level security|violates/i);
    });
  });

  it('a disabled user sees nothing', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`update public.profiles set disabled_at = now() where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      for (const t of ['customers', 'jobs', 'documents', 'tenants', 'profiles']) {
        const r = await c.query(`select count(*)::int n from public.${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
    });
  });

  it('a signed-out visitor (anon) has no access to any table', async () => {
    await withRollback(async (c) => {
      await seedTenant(c, 'Alpha');
      await c.query('set local role anon');
      for (const t of ['tenants', 'customers', 'bank_accounts', 'audit_log', 'profiles']) {
        await c.query('savepoint s');
        await expect(c.query(`select * from public.${t}`)).rejects.toThrow(/permission denied/i);
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('the encrypted bank columns are not readable or writable by the app role', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const safe = await c.query(`select id, account_name, bank_name, last4, is_default from public.bank_accounts`);
      expect(safe.rowCount).toBe(1);
      await c.query('savepoint s');
      await expect(c.query(`select sort_code_enc from public.bank_accounts`)).rejects.toThrow(/permission denied/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`select * from public.bank_accounts`)).rejects.toThrow(/permission denied/i);
      await c.query('rollback to savepoint s').catch(() => undefined);
    });
  });

  it('staff cannot change brand or defaults, owners can', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`update public.profiles set role = 'staff' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const staff = await c.query(`update public.tenant_defaults set vat_rate_bp = 0 where tenant_id = $1`, [a.tenantId]);
      expect(staff.rowCount).toBe(0);
      await actAsServer(c);
      await c.query(`update public.profiles set role = 'owner' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const owner = await c.query(`update public.tenant_defaults set vat_rate_bp = 500 where tenant_id = $1`, [a.tenantId]);
      expect(owner.rowCount).toBe(1);
    });
  });

  it('only owners can read the audit log, and nobody can write it from the app', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const r = await c.query(`select count(*)::int n from public.audit_log`);
      expect(r.rows[0].n).toBe(1);
      await c.query('savepoint s');
      await expect(c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'forged')`, [a.tenantId])).rejects.toThrow(/permission denied/i);
    });
  });

  it('the app role cannot touch login attempts or purge logs, and cannot delete customers', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      for (const sql of [`select * from public.login_attempts`, `select * from public.purge_log`, `delete from public.customers`]) {
        await c.query('savepoint s');
        await expect(c.query(sql)).rejects.toThrow(/permission denied/i);
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('every public table has row level security enabled and forced', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      );
      expect(r.rowCount).toBeGreaterThan(15);
      for (const row of r.rows) {
        expect(row.relrowsecurity, `${row.relname} rls`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} forced`).toBe(true);
      }
    });
  });

  it('anon has no table privileges at all', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'`,
      );
      expect(r.rows).toEqual([]);
    });
  });
});
```

`tests/db/integrity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { actAs, createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function jobFor(c: import('pg').Client, tenantId: string, ref: string) {
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [tenantId]);
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id, customer_id`, [tenantId, cust.rows[0].id, ref]);
  return { jobId: job.rows[0].id as string, customerId: cust.rows[0].id as string };
}

describe.skipIf(!dbAvailable)('integrity triggers', () => {
  it('a finalised document version cannot be updated or deleted', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId } = await jobFor(c, t.tenantId, 'QT-A-001');
      const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-A-001') returning id`, [t.tenantId, jobId]);
      const v = await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1) returning id`, [t.tenantId, doc.rows[0].id]);
      await c.query(`update public.document_versions set input = '{"a":1}' where id = $1`, [v.rows[0].id]);
      await c.query(`update public.document_versions set finalised_at = now() where id = $1`, [v.rows[0].id]);
      await c.query('savepoint s');
      await expect(c.query(`update public.document_versions set input = '{"a":2}' where id = $1`, [v.rows[0].id])).rejects.toThrow(/finalised/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`delete from public.document_versions where id = $1`, [v.rows[0].id])).rejects.toThrow(/finalised/i);
    });
  });

  it('the audit log is append only', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const row = await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'x') returning id`, [t.tenantId]);
      await c.query('savepoint s');
      await expect(c.query(`update public.audit_log set action = 'y' where id = $1`, [row.rows[0].id])).rejects.toThrow(/append/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`delete from public.audit_log where id = $1`, [row.rows[0].id])).rejects.toThrow(/append/i);
    });
  });

  it('a quote number cannot be reused, even after the job is deleted', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId, customerId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await c.query(`delete from public.jobs where id = $1`, [jobId]);
      await c.query('savepoint s');
      await expect(
        c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-A-001')`, [t.tenantId, customerId]),
      ).rejects.toThrow(/already been used|duplicate/i);
    });
  });

  it('a quote number cannot be changed', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await expect(c.query(`update public.jobs set reference = 'QT-A-002' where id = $1`, [jobId])).rejects.toThrow(/cannot be changed/i);
    });
  });

  it('the same quote number is fine in two different businesses', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Alpha');
      const b = await createTenantWithUser(c, 'Bravo');
      await jobFor(c, a.tenantId, 'QT-001');
      await jobFor(c, b.tenantId, 'QT-001');
    });
  });

  it('creating documents pushes the customer purge date out by 30 days', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId, customerId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await c.query(`update public.customers set purge_at = now() + interval '1 day', last_activity_at = now() - interval '29 days' where id = $1`, [customerId]);
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-A-001')`, [t.tenantId, jobId]);
      const r = await c.query(`select purge_at > now() + interval '29 days' as extended from public.customers where id = $1`, [customerId]);
      expect(r.rows[0].extended).toBe(true);
    });
  });

  it('the app role can create a job and the number is claimed', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [t.tenantId]);
      await actAs(c, t.userId);
      await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-APP-001')`, [t.tenantId, cust.rows[0].id]);
      const used = await c.query(`select count(*)::int n from public.used_numbers where number = 'QT-APP-001'`);
      expect(used.rows[0].n).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:db`
Expected: FAIL (no RLS yet; the anon and column-privilege tests fail, isolation tests fail).

- [ ] **Step 3: Write the security migration**

`supabase/migrations/002_security.sql`:
```sql
-- 002_security: private helpers, grants, row level security, integrity triggers.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- Who is the signed-in user? Disabled or unknown users get null, which matches no rows.
create function private.current_tenant_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.tenant_id from public.profiles p where p.id = auth.uid() and p.disabled_at is null
$$;

create function private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'owner' from public.profiles p where p.id = auth.uid() and p.disabled_at is null), false)
$$;

revoke all on function private.current_tenant_id() from public, anon;
revoke all on function private.is_owner() from public, anon;
grant execute on function private.current_tenant_id() to authenticated, service_role;
grant execute on function private.is_owner() to authenticated, service_role;

-- Start from nothing: no table privileges for anon or the signed-in role, now or for new tables.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Row level security on every table, forced.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Tenant read/write tables (no delete from the app).
do $$
declare t text;
begin
  foreach t in array array['customers','jobs','documents','document_versions','job_photos','document_emails','share_links'] loop
    execute format('create policy tenant_select on public.%I for select to authenticated using (tenant_id = (select private.current_tenant_id()))', t);
    execute format('create policy tenant_insert on public.%I for insert to authenticated with check (tenant_id = (select private.current_tenant_id()))', t);
    execute format('create policy tenant_update on public.%I for update to authenticated using (tenant_id = (select private.current_tenant_id())) with check (tenant_id = (select private.current_tenant_id()))', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

-- Brand and defaults: everyone in the business reads, owners write.
do $$
declare t text;
begin
  foreach t in array array['brand_kits','brand_assets','job_types','tenant_defaults'] loop
    execute format('create policy tenant_select on public.%I for select to authenticated using (tenant_id = (select private.current_tenant_id()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (tenant_id = (select private.current_tenant_id()) and (select private.is_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using (tenant_id = (select private.current_tenant_id()) and (select private.is_owner())) with check (tenant_id = (select private.current_tenant_id()) and (select private.is_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (tenant_id = (select private.current_tenant_id()) and (select private.is_owner()))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Quote numbers: read and claim.
create policy tenant_select on public.used_numbers for select to authenticated using (tenant_id = (select private.current_tenant_id()));
grant select on public.used_numbers to authenticated;

-- The business itself: read own, owners edit the business details (never id or created_at).
create policy tenant_select on public.tenants for select to authenticated using (id = (select private.current_tenant_id()));
create policy owner_update on public.tenants for update to authenticated
  using (id = (select private.current_tenant_id()) and (select private.is_owner()))
  with check (id = (select private.current_tenant_id()) and (select private.is_owner()));
grant select on public.tenants to authenticated;
grant update (name, trade_type, company_number, vat_registered, vat_number, address_lines, postcode, phone, email, website, tagline, owner_name, owner_title)
  on public.tenants to authenticated;

-- People in the same business.
create policy tenant_select on public.profiles for select to authenticated using (tenant_id = (select private.current_tenant_id()));
grant select (id, tenant_id, role, full_name, email, created_at) on public.profiles to authenticated;

-- Bank accounts: the app role can see only the safe columns, and cannot write at all (server only, after a step-up check).
create policy tenant_select on public.bank_accounts for select to authenticated using (tenant_id = (select private.current_tenant_id()));
grant select (id, tenant_id, account_name, bank_name, last4, is_default, archived_at, created_at) on public.bank_accounts to authenticated;

-- AI usage and audit trail: read-only for the business (audit: owners only). Written by the server.
create policy tenant_select on public.ai_runs for select to authenticated using (tenant_id = (select private.current_tenant_id()));
grant select on public.ai_runs to authenticated;
create policy owner_select on public.audit_log for select to authenticated
  using (tenant_id = (select private.current_tenant_id()) and (select private.is_owner()));
grant select on public.audit_log to authenticated;

-- login_attempts, purge_log and _migrations: row level security on, no policies, no grants. Service role only.

-- A restrictive guard on top of every policy: disabled or unknown users get nothing.
do $$
declare t text;
begin
  foreach t in array array['tenants','profiles','brand_kits','brand_assets','job_types','bank_accounts','tenant_defaults','customers','jobs','used_numbers','documents','document_versions','job_photos','share_links','document_emails','ai_runs','audit_log'] loop
    execute format('create policy active_profile_only on public.%I as restrictive for all to authenticated using ((select private.current_tenant_id()) is not null)', t);
  end loop;
end $$;

-- Finalised versions never change and are only deleted by the purge (which sets app.allow_final_delete).
create function private.block_final_version_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.finalised_at is not null then
    raise exception 'A finalised document version cannot be changed' using errcode = '23000';
  end if;
  if tg_op = 'DELETE' then
    if old.finalised_at is not null and coalesce(current_setting('app.allow_final_delete', true), '') <> 'on' then
      raise exception 'A finalised document version cannot be deleted' using errcode = '23000';
    end if;
    return old;
  end if;
  return new;
end $$;
create trigger document_versions_immutable before update or delete on public.document_versions
  for each row execute function private.block_final_version_change();

-- The audit trail is append only, for everyone.
create function private.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'The audit log is append only' using errcode = '23000';
end $$;
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function private.audit_append_only();

-- A quote number is claimed once, forever, and never changes.
create function private.claim_job_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.reference is distinct from old.reference then
      raise exception 'A quote number cannot be changed' using errcode = '23000';
    end if;
    return new;
  end if;
  insert into public.used_numbers (tenant_id, number) values (new.tenant_id, new.reference);
  return new;
exception when unique_violation then
  raise exception 'Quote number % has already been used', new.reference using errcode = '23505';
end $$;
create trigger jobs_claim_number before insert or update of reference on public.jobs
  for each row execute function private.claim_job_number();

-- Any activity on a customer pushes their 30-day purge date out.
create function private.touch_customer_from_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers set last_activity_at = now(), purge_at = now() + interval '30 days'
  where id = new.customer_id and tenant_id = new.tenant_id;
  return new;
end $$;
create trigger jobs_touch_customer after insert on public.jobs
  for each row execute function private.touch_customer_from_job();

create function private.touch_customer_from_document() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(), purge_at = now() + interval '30 days'
  from public.jobs j
  where j.id = new.job_id and j.tenant_id = new.tenant_id and c.id = j.customer_id and c.tenant_id = j.tenant_id;
  return new;
end $$;
create trigger documents_touch_customer after insert or update on public.documents
  for each row execute function private.touch_customer_from_document();
```

- [ ] **Step 4: Apply and run**

Run: `npm run db:migrate && npm run test:db && npx tsc --noEmit`
Expected: `Applied: 002_security.sql`; all DB tests PASS. Note on forced row level security: the trigger functions marked `security definer` write to `used_numbers` and `customers` as their owner. That works only if the owner role bypasses row level security (the Supabase `postgres` role does). Check with `select rolbypassrls from pg_roles where rolname = current_user`; if it is false, add narrowly scoped policies for the function owner in a new migration rather than weakening FORCE. If a test fails because of Supabase-specific behaviour (for example `auth.uid()` reading a different setting), diagnose from the error, fix the migration or helper, and report what you learned. Do NOT weaken an isolation assertion. If a migration was applied but is wrong, add a new migration file (never edit an applied one).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/002_security.sql tests/db
git commit -m "feat: row level security, grants and integrity triggers with isolation tests"
```

---

### Task 3: Bank detail encryption

**Files:**
- Create: `src/security/bank-crypto.ts`
- Test: `tests/unit/bank-crypto.test.ts`

**Interfaces:**
- Produces:
  - `parseKey(b64: string): Buffer` (throws unless 32 bytes)
  - `encryptSecret(plain: string, key: Buffer, aad: string): string` returning `v1:<iv>:<tag>:<ciphertext>` (base64 parts)
  - `decryptSecret(blob: string, key: Buffer, aad: string): string` (throws on tamper, wrong key or wrong aad)
  - `normaliseSortCode(raw: string): string` (`'23-05-80'`, throws unless 6 digits)
  - `normaliseAccountNumber(raw: string): string` (8 digits, throws otherwise)
  - `last4(accountNumber: string): string`
  - `maskAccountNumber(last4: string): string` (`'••••1234'`)
  - `encryptBankDetails(d: { sortCode: string; accountNumber: string }, key: Buffer, tenantId: string): { sort_code_enc: string; account_number_enc: string; last4: string }`
  - `decryptBankDetails(row: { sort_code_enc: string; account_number_enc: string }, key: Buffer, tenantId: string): { sortCode: string; accountNumber: string }`

- [ ] **Step 1: Write the failing tests**

`tests/unit/bank-crypto.test.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptBankDetails,
  decryptSecret,
  encryptBankDetails,
  encryptSecret,
  last4,
  maskAccountNumber,
  normaliseAccountNumber,
  normaliseSortCode,
  parseKey,
} from '../../src/security/bank-crypto';

const key = randomBytes(32);
const tenant = '11111111-1111-1111-1111-111111111111';

describe('parseKey', () => {
  it('accepts a 32 byte base64 key', () => {
    expect(parseKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });
  it('rejects the wrong length', () => {
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseKey('')).toThrow(/32 bytes/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('00-00-00', key, 'ctx'), key, 'ctx')).toBe('00-00-00');
  });
  it('produces different ciphertext each time and a versioned format', () => {
    const a = encryptSecret('12345678', key, 'ctx');
    const b = encryptSecret('12345678', key, 'ctx');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a.split(':')).toHaveLength(4);
  });
  it('never contains the plaintext', () => {
    expect(encryptSecret('12345678', key, 'ctx')).not.toContain('12345678');
  });
  it('detects tampering', () => {
    const [v, iv, tag, ct] = encryptSecret('12345678', key, 'ctx').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), key, 'ctx')).toThrow();
  });
  it('fails with the wrong key', () => {
    expect(() => decryptSecret(encryptSecret('x', key, 'ctx'), randomBytes(32), 'ctx')).toThrow();
  });
  it('fails with the wrong context, so ciphertext cannot be moved between fields or tenants', () => {
    expect(() => decryptSecret(encryptSecret('x', key, 'ctx-a'), key, 'ctx-b')).toThrow();
  });
  it('rejects malformed or unknown-version blobs', () => {
    expect(() => decryptSecret('garbage', key, 'ctx')).toThrow();
    expect(() => decryptSecret('v9:a:b:c', key, 'ctx')).toThrow(/version/i);
  });
});

describe('normalising', () => {
  it('formats sort codes', () => {
    expect(normaliseSortCode('230580')).toBe('23-05-80');
    expect(normaliseSortCode('23 05 80')).toBe('23-05-80');
    expect(normaliseSortCode('23-05-80')).toBe('23-05-80');
  });
  it('rejects bad sort codes', () => {
    expect(() => normaliseSortCode('2305')).toThrow();
    expect(() => normaliseSortCode('ab-cd-ef')).toThrow();
  });
  it('accepts 8 digit account numbers and rejects others', () => {
    expect(normaliseAccountNumber('0000 0000')).toBe('00000000');
    expect(() => normaliseAccountNumber('1234567')).toThrow();
    expect(() => normaliseAccountNumber('1234567a')).toThrow();
  });
  it('last4 and masking', () => {
    expect(last4('44211750')).toBe('1750');
    expect(maskAccountNumber('1750')).toBe('••••1750');
  });
});

describe('encryptBankDetails / decryptBankDetails', () => {
  it('round-trips and exposes only last4 in clear', () => {
    const enc = encryptBankDetails({ sortCode: '000000', accountNumber: '00000000' }, key, tenant);
    expect(enc.last4).toBe('0000');
    expect(enc.sort_code_enc).not.toContain('00-00-00');
    expect(decryptBankDetails(enc, key, tenant)).toEqual({ sortCode: '00-00-00', accountNumber: '00000000' });
  });
  it('cannot be decrypted for a different tenant', () => {
    const enc = encryptBankDetails({ sortCode: '000000', accountNumber: '00000000' }, key, tenant);
    expect(() => decryptBankDetails(enc, key, '22222222-2222-2222-2222-222222222222')).toThrow();
  });
  it('cannot swap the two encrypted fields', () => {
    const enc = encryptBankDetails({ sortCode: '000000', accountNumber: '00000000' }, key, tenant);
    expect(() => decryptBankDetails({ sort_code_enc: enc.account_number_enc, account_number_enc: enc.sort_code_enc }, key, tenant)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/bank-crypto.test.ts`
Expected: FAIL, cannot resolve `bank-crypto`.

- [ ] **Step 3: Implement**

`src/security/bank-crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('BANK_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

/** `aad` binds the ciphertext to its context (tenant and field), so it cannot be moved elsewhere. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4) throw new Error('Malformed encrypted value');
  const [version, iv, tag, ct] = parts;
  if (version !== VERSION) throw new Error(`Unsupported encryption version: ${version}`);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function normaliseSortCode(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(digits)) throw new Error('A sort code must be 6 digits');
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

export function normaliseAccountNumber(raw: string): string {
  const digits = raw.replace(/\s/g, '');
  if (!/^\d{8}$/.test(digits)) throw new Error('An account number must be 8 digits');
  return digits;
}

export const last4 = (accountNumber: string): string => accountNumber.slice(-4);
export const maskAccountNumber = (l4: string): string => `••••${l4}`;

const fieldContext = (tenantId: string, field: string): string => `bank:${tenantId}:${field}`;

export function encryptBankDetails(d: { sortCode: string; accountNumber: string }, key: Buffer, tenantId: string) {
  const sortCode = normaliseSortCode(d.sortCode);
  const accountNumber = normaliseAccountNumber(d.accountNumber);
  return {
    sort_code_enc: encryptSecret(sortCode, key, fieldContext(tenantId, 'sort_code')),
    account_number_enc: encryptSecret(accountNumber, key, fieldContext(tenantId, 'account_number')),
    last4: last4(accountNumber),
  };
}

export function decryptBankDetails(row: { sort_code_enc: string; account_number_enc: string }, key: Buffer, tenantId: string) {
  return {
    sortCode: decryptSecret(row.sort_code_enc, key, fieldContext(tenantId, 'sort_code')),
    accountNumber: decryptSecret(row.account_number_enc, key, fieldContext(tenantId, 'account_number')),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/bank-crypto.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/bank-crypto.ts tests/unit/bank-crypto.test.ts
git commit -m "feat: AES-256-GCM encryption for bank details bound to tenant and field"
```

---

### Task 4: Login protection

**Files:**
- Create: `src/security/login-guard.ts`
- Test: `tests/unit/login-guard.test.ts`, `tests/db/login-guard.test.ts`

**Interfaces:**
- Produces:
  - Constants `WINDOW_MS = 900000`, `MAX_FAILURES = 5`, `MAX_CODE_REQUESTS = 5`, `IP_MAX_FAILURES = 20`
  - `interface Attempt { kind: 'request' | 'verify'; success: boolean; at: Date }`
  - `interface Decision { allowed: boolean; reason: 'ok' | 'locked' | 'too_many_codes' | 'ip_blocked'; retryAt: Date | null }`
  - `hashEmail(email: string, pepper: string): string` (HMAC-SHA256 hex of the trimmed, lowercased email)
  - `decideVerify(attempts: Attempt[], now: Date): Decision`
  - `decideRequest(attempts: Attempt[], now: Date): Decision`
  - `decideIp(ipFailuresInWindow: number): Decision`
  - `type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }`
  - `recordAttempt(db: Db, a: { emailHash: string; ip: string | null; kind: 'request' | 'verify'; success: boolean }): Promise<void>`
  - `recentAttempts(db: Db, emailHash: string, now: Date): Promise<Attempt[]>`
  - `recentIpFailures(db: Db, ip: string | null, now: Date): Promise<number>`

- [ ] **Step 1: Write the failing tests**

`tests/unit/login-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  type Attempt,
  MAX_CODE_REQUESTS,
  MAX_FAILURES,
  WINDOW_MS,
  decideIp,
  decideRequest,
  decideVerify,
  hashEmail,
} from '../../src/security/login-guard';

const now = new Date('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const fail = (ms: number): Attempt => ({ kind: 'verify', success: false, at: ago(ms) });
const ok = (ms: number): Attempt => ({ kind: 'verify', success: true, at: ago(ms) });
const req = (ms: number): Attempt => ({ kind: 'request', success: true, at: ago(ms) });

describe('hashEmail', () => {
  it('is stable, case and whitespace insensitive, and peppered', () => {
    expect(hashEmail(' Ben@Example.com ', 'p')).toBe(hashEmail('ben@example.com', 'p'));
    expect(hashEmail('ben@example.com', 'p')).not.toBe(hashEmail('ben@example.com', 'q'));
    expect(hashEmail('ben@example.com', 'p')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('never contains the email', () => {
    expect(hashEmail('ben@example.com', 'p')).not.toContain('ben');
  });
});

describe('decideVerify', () => {
  it('allows with no failures', () => {
    expect(decideVerify([], now)).toEqual({ allowed: true, reason: 'ok', retryAt: null });
  });
  it('allows four failures', () => {
    expect(decideVerify([1, 2, 3, 4].map((m) => fail(m * 1000)), now).allowed).toBe(true);
  });
  it('locks after five failures for 15 minutes from the latest failure', () => {
    const attempts = [1, 2, 3, 4, 5].map((m) => fail(m * 60_000));
    const d = decideVerify(attempts, now);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('locked');
    expect(d.retryAt).toEqual(new Date(now.getTime() - 60_000 + WINDOW_MS));
  });
  it('unlocks once the window has passed', () => {
    const attempts = Array.from({ length: MAX_FAILURES }, (_, i) => fail(WINDOW_MS + 1000 + i));
    expect(decideVerify(attempts, now).allowed).toBe(true);
  });
  it('a successful verify clears earlier failures', () => {
    const attempts = [fail(5 * 60_000), fail(4 * 60_000), fail(3 * 60_000), ok(2 * 60_000), fail(60_000), fail(30_000)];
    expect(decideVerify(attempts, now).allowed).toBe(true);
  });
  it('more failures while locked extend the lock', () => {
    const attempts = [fail(600_000), fail(500_000), fail(400_000), fail(300_000), fail(200_000), fail(10_000)];
    const d = decideVerify(attempts, now);
    expect(d.retryAt).toEqual(new Date(now.getTime() - 10_000 + WINDOW_MS));
  });
});

describe('decideRequest', () => {
  it('allows a few code requests', () => {
    expect(decideRequest([req(1000), req(2000)], now).allowed).toBe(true);
  });
  it('blocks after five requests in the window until the oldest ages out', () => {
    const attempts = Array.from({ length: MAX_CODE_REQUESTS }, (_, i) => req((i + 1) * 60_000));
    const d = decideRequest(attempts, now);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('too_many_codes');
    expect(d.retryAt).toEqual(new Date(now.getTime() - 5 * 60_000 + WINDOW_MS));
  });
  it('ignores verify attempts and old requests', () => {
    const attempts = [fail(1000), ...Array.from({ length: 10 }, (_, i) => req(WINDOW_MS + 1000 + i))];
    expect(decideRequest(attempts, now).allowed).toBe(true);
  });
});

describe('decideIp', () => {
  it('blocks an address with too many failures across emails', () => {
    expect(decideIp(19).allowed).toBe(true);
    const d = decideIp(20);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('ip_blocked');
  });
});
```

`tests/db/login-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hashEmail, recentAttempts, recentIpFailures, recordAttempt } from '../../src/security/login-guard';
import { dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('login attempt storage', () => {
  it('records attempts and reads back only recent ones for that email', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('ben@example.com', 'pepper');
      const other = hashEmail('someone@example.com', 'pepper');
      await recordAttempt(c, { emailHash: h, ip: '203.0.113.5', kind: 'verify', success: false });
      await recordAttempt(c, { emailHash: h, ip: '203.0.113.5', kind: 'request', success: true });
      await recordAttempt(c, { emailHash: other, ip: '203.0.113.9', kind: 'verify', success: false });
      await c.query(`insert into public.login_attempts (email_hash, ip, kind, success, at) values ($1, '203.0.113.5', 'verify', false, now() - interval '2 hours')`, [h]);
      const rows = await recentAttempts(c, h, new Date());
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.at instanceof Date)).toBe(true);
    });
  });

  it('counts failures per IP across emails', async () => {
    await withRollback(async (c) => {
      for (let i = 0; i < 3; i++) {
        await recordAttempt(c, { emailHash: hashEmail(`u${i}@example.com`, 'p'), ip: '198.51.100.7', kind: 'verify', success: false });
      }
      await recordAttempt(c, { emailHash: hashEmail('ok@example.com', 'p'), ip: '198.51.100.7', kind: 'verify', success: true });
      expect(await recentIpFailures(c, '198.51.100.7', new Date())).toBe(3);
      expect(await recentIpFailures(c, null, new Date())).toBe(0);
    });
  });

  it('stores only a hash, never the email', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('ben@example.com', 'pepper');
      await recordAttempt(c, { emailHash: h, ip: null, kind: 'request', success: true });
      const r = await c.query(`select email_hash from public.login_attempts where email_hash = $1`, [h]);
      expect(r.rows[0].email_hash).not.toContain('ben');
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/login-guard.test.ts && npm run test:db -- tests/db/login-guard.test.ts`
Expected: FAIL, cannot resolve `login-guard`.

- [ ] **Step 3: Implement**

`src/security/login-guard.ts`:
```ts
import { createHmac } from 'node:crypto';

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 5;
export const MAX_CODE_REQUESTS = 5;
export const IP_MAX_FAILURES = 20;

export interface Attempt {
  kind: 'request' | 'verify';
  success: boolean;
  at: Date;
}

export interface Decision {
  allowed: boolean;
  reason: 'ok' | 'locked' | 'too_many_codes' | 'ip_blocked';
  retryAt: Date | null;
}

const OK: Decision = { allowed: true, reason: 'ok', retryAt: null };

export function hashEmail(email: string, pepper: string): string {
  return createHmac('sha256', pepper).update(email.trim().toLowerCase()).digest('hex');
}

/** Five wrong codes in 15 minutes locks the account until 15 minutes after the latest wrong code. */
export function decideVerify(attempts: Attempt[], now: Date): Decision {
  const since = now.getTime() - WINDOW_MS;
  const verifies = attempts.filter((a) => a.kind === 'verify').sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastSuccess = [...verifies].reverse().find((a) => a.success)?.at.getTime() ?? -Infinity;
  const failures = verifies.filter((a) => !a.success && a.at.getTime() > since && a.at.getTime() > lastSuccess);
  if (failures.length < MAX_FAILURES) return OK;
  const retryAt = new Date(failures[failures.length - 1].at.getTime() + WINDOW_MS);
  return retryAt.getTime() > now.getTime() ? { allowed: false, reason: 'locked', retryAt } : OK;
}

/** At most five code emails per address per 15 minutes. */
export function decideRequest(attempts: Attempt[], now: Date): Decision {
  const since = now.getTime() - WINDOW_MS;
  const requests = attempts
    .filter((a) => a.kind === 'request' && a.at.getTime() > since)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (requests.length < MAX_CODE_REQUESTS) return OK;
  return { allowed: false, reason: 'too_many_codes', retryAt: new Date(requests[0].at.getTime() + WINDOW_MS) };
}

export function decideIp(ipFailuresInWindow: number): Decision {
  return ipFailuresInWindow >= IP_MAX_FAILURES ? { allowed: false, reason: 'ip_blocked', retryAt: null } : OK;
}

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function recordAttempt(
  db: Db,
  a: { emailHash: string; ip: string | null; kind: 'request' | 'verify'; success: boolean },
): Promise<void> {
  await db.query(`insert into public.login_attempts (email_hash, ip, kind, success) values ($1, $2, $3, $4)`, [
    a.emailHash,
    a.ip,
    a.kind,
    a.success,
  ]);
}

export async function recentAttempts(db: Db, emailHash: string, now: Date): Promise<Attempt[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const r = await db.query(`select kind, success, at from public.login_attempts where email_hash = $1 and at > $2 order by at`, [emailHash, since]);
  return r.rows.map((x) => ({ kind: x.kind, success: x.success, at: new Date(x.at) }));
}

export async function recentIpFailures(db: Db, ip: string | null, now: Date): Promise<number> {
  if (!ip) return 0;
  const since = new Date(now.getTime() - WINDOW_MS);
  const r = await db.query(
    `select count(*)::int as n from public.login_attempts where ip = $1 and kind = 'verify' and success = false and at > $2`,
    [ip, since],
  );
  return r.rows[0].n;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/login-guard.test.ts && npm run test:db -- tests/db/login-guard.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/login-guard.ts tests/unit/login-guard.test.ts tests/db/login-guard.test.ts
git commit -m "feat: login lockout, code-request rate limit and IP block decisions"
```

---

### Task 5: Step-up check, audit writer and the purge

**Files:**
- Create: `src/security/step-up.ts`, `src/security/audit.ts`, `supabase/migrations/003_purge.sql`
- Test: `tests/unit/step-up.test.ts`, `tests/unit/audit.test.ts`, `tests/db/purge.test.ts`

**Interfaces:**
- Produces:
  - `class StepUpRequiredError extends Error`
  - `interface AuthClaims { amr?: { method: string; timestamp: number }[] }`
  - `STEP_UP_MAX_AGE_SECONDS = 600`
  - `assertRecentStepUp(claims: AuthClaims, nowSeconds: number, maxAgeSeconds?: number): void` (passes when an `otp`, `email` or `magiclink` authentication happened within the window; rejects missing, old or future-dated (more than 60 seconds ahead) entries)
  - `interface AuditEntry { tenantId: string | null; userId: string | null; impersonatorId?: string | null; action: string; entity?: string; entityId?: string; ip?: string | null; userAgent?: string | null; meta?: Record<string, unknown> }`
  - `assertNoPersonalData(meta: unknown): void` (throws if any key at any depth looks personal, or any string value looks like an email address)
  - `writeAudit(db: Db, e: AuditEntry): Promise<void>`
  - SQL functions (service role only): `private.expired_customers(p_now timestamptz) returns table(id uuid, tenant_id uuid)`, `private.customer_storage_paths(p_customer_ids uuid[]) returns setof text`, `private.purge_expired_customers(p_now timestamptz default now()) returns integer`, `private.erase_customer(p_tenant uuid, p_customer uuid) returns integer`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/step-up.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { STEP_UP_MAX_AGE_SECONDS, StepUpRequiredError, assertRecentStepUp } from '../../src/security/step-up';

const now = 1_800_000_000;

describe('assertRecentStepUp', () => {
  it('passes with a fresh otp sign-in', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now - 60 }] }, now)).not.toThrow();
  });
  it('passes at the edge of the window', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now - STEP_UP_MAX_AGE_SECONDS }] }, now)).not.toThrow();
  });
  it('rejects an old sign-in', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now - STEP_UP_MAX_AGE_SECONDS - 1 }] }, now)).toThrow(StepUpRequiredError);
  });
  it('rejects missing or empty amr', () => {
    expect(() => assertRecentStepUp({}, now)).toThrow(StepUpRequiredError);
    expect(() => assertRecentStepUp({ amr: [] }, now)).toThrow(StepUpRequiredError);
  });
  it('rejects methods that are not an emailed code', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'password', timestamp: now }] }, now)).toThrow(StepUpRequiredError);
  });
  it('uses the most recent matching entry', () => {
    const amr = [{ method: 'otp', timestamp: now - 100_000 }, { method: 'otp', timestamp: now - 30 }];
    expect(() => assertRecentStepUp({ amr }, now)).not.toThrow();
  });
  it('rejects timestamps in the future beyond clock skew', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now + 3600 }] }, now)).toThrow(StepUpRequiredError);
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now + 30 }] }, now)).not.toThrow();
  });
  it('has a friendly message and name', () => {
    try {
      assertRecentStepUp({}, now);
    } catch (e) {
      expect((e as Error).name).toBe('StepUpRequiredError');
      expect((e as Error).message).toMatch(/fresh email code/i);
    }
  });
});
```

`tests/unit/audit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assertNoPersonalData, writeAudit } from '../../src/security/audit';

describe('assertNoPersonalData', () => {
  it('allows ids, counts and codes', () => {
    expect(() => assertNoPersonalData({ document_type: 'quotation', total_pence: 900600, customer_id: 'abc', last4: '1234' })).not.toThrow();
  });
  it('rejects personal keys at any depth', () => {
    for (const meta of [
      { name: 'x' }, { customer_name: 'x' }, { email: 'a' }, { phone: '1' }, { address: 'x' }, { postcode: 'x' },
      { sort_code: '1' }, { accountNumber: '1' }, { nested: { deep: [{ email_address: 'x' }] } },
    ]) {
      expect(() => assertNoPersonalData(meta), JSON.stringify(meta)).toThrow(/personal/i);
    }
  });
  it('rejects values that look like email addresses', () => {
    expect(() => assertNoPersonalData({ note: 'sent to ben@example.com' })).toThrow(/personal/i);
  });
});

describe('writeAudit', () => {
  it('inserts a row with the given fields', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const db = { query: async (sql: string, params?: unknown[]) => (calls.push({ sql, params }), { rows: [] }) };
    await writeAudit(db, { tenantId: 't', userId: 'u', action: 'document.finalised', entity: 'document', entityId: 'd1', meta: { type: 'quotation' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/insert into public\.audit_log/);
    expect(calls[0].params).toEqual(['t', 'u', null, 'document.finalised', 'document', 'd1', null, null, JSON.stringify({ type: 'quotation' })]);
  });
  it('refuses to write personal data and writes nothing', async () => {
    const calls: unknown[] = [];
    const db = { query: async () => (calls.push(1), { rows: [] }) };
    await expect(writeAudit(db, { tenantId: 't', userId: 'u', action: 'x', meta: { email: 'a@b.com' } })).rejects.toThrow(/personal/i);
    expect(calls).toHaveLength(0);
  });
});
```

`tests/db/purge.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function customerWithJob(c: import('pg').Client, tenantId: string, ref: string, purgeAtSql: string) {
  const cust = await c.query(`insert into public.customers (tenant_id, name, purge_at) values ($1, 'Cust', ${purgeAtSql}) returning id`, [tenantId]);
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [tenantId, cust.rows[0].id, ref]);
  // jobs trigger pushed purge_at out; set it back for the test
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number, pdf_path) values ($1, $2, 'quotation', $3, $4) returning id`, [tenantId, job.rows[0].id, ref, `${tenantId}/pdfs/${ref}.pdf`]);
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  const v = await c.query(`insert into public.document_versions (tenant_id, document_id, version, pdf_path, finalised_at) values ($1, $2, 1, $3, now()) returning id`, [tenantId, doc.rows[0].id, `${tenantId}/pdfs/${ref}-v1.pdf`]);
  await c.query(`insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $3)`, [tenantId, job.rows[0].id, `${tenantId}/photos/${ref}.jpg`]);
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  return { customerId: cust.rows[0].id as string, jobId: job.rows[0].id as string, versionId: v.rows[0].id as string };
}

describe.skipIf(!dbAvailable)('purge and erase', () => {
  it('lists expired customers and their stored files', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      const expired = await c.query(`select id from private.expired_customers(now())`);
      expect(expired.rows.map((r) => r.id)).toEqual([old.customerId]);
      const paths = await c.query(`select * from private.customer_storage_paths($1::uuid[])`, [[old.customerId]]);
      expect(paths.rows.map((r) => r.customer_storage_paths).sort()).toEqual([`${t.tenantId}/pdfs/QT-OLD-001-v1.pdf`, `${t.tenantId}/pdfs/QT-OLD-001.pdf`, `${t.tenantId}/photos/QT-OLD-001.jpg`]);
    });
  });

  it('purges only expired customers, cascades, logs a count, and keeps used numbers and the audit trail', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      const keep = await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'kept')`, [t.tenantId]);
      const before = await c.query(`select count(*)::int n from public.purge_log`);
      const r = await c.query(`select private.purge_expired_customers(now()) as n`);
      expect(r.rows[0].n).toBe(1);
      const left = await c.query(`select id from public.customers where tenant_id = $1`, [t.tenantId]);
      expect(left.rows.map((x) => x.id)).toEqual([keep.customerId]);
      for (const table of ['jobs', 'documents', 'document_versions', 'job_photos']) {
        const n = await c.query(`select count(*)::int n from public.${table} where tenant_id = $1`, [t.tenantId]);
        expect(n.rows[0].n, table).toBe(1);
      }
      const used = await c.query(`select number from public.used_numbers where tenant_id = $1 order by number`, [t.tenantId]);
      expect(used.rows.map((x) => x.number)).toEqual(['QT-NEW-001', 'QT-OLD-001']);
      const audit = await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1`, [t.tenantId]);
      expect(audit.rows[0].n).toBe(1);
      const log = await c.query(`select customers_purged from public.purge_log order by id desc limit 1`);
      expect(log.rows[0].customers_purged).toBe(1);
      const after = await c.query(`select count(*)::int n from public.purge_log`);
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    });
  });

  it('erase_customer deletes one customer in the named tenant only', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Alpha');
      const b = await createTenantWithUser(c, 'Bravo');
      const ca = await customerWithJob(c, a.tenantId, 'QT-A-001', `now() + interval '10 days'`);
      const cb = await customerWithJob(c, b.tenantId, 'QT-B-001', `now() + interval '10 days'`);
      const wrong = await c.query(`select private.erase_customer($1, $2) as n`, [a.tenantId, cb.customerId]);
      expect(wrong.rows[0].n).toBe(0);
      const ok = await c.query(`select private.erase_customer($1, $2) as n`, [a.tenantId, ca.customerId]);
      expect(ok.rows[0].n).toBe(1);
      const left = await c.query(`select id from public.customers where id = any($1::uuid[])`, [[ca.customerId, cb.customerId]]);
      expect(left.rows.map((x) => x.id)).toEqual([cb.customerId]);
    });
  });

  it('the purge functions are not callable by the app role', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.userId, role: 'authenticated' })]);
      await c.query('savepoint s');
      await expect(c.query(`select private.purge_expired_customers(now())`)).rejects.toThrow(/permission denied/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`select private.erase_customer($1, gen_random_uuid())`, [t.tenantId])).rejects.toThrow(/permission denied/i);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/step-up.test.ts tests/unit/audit.test.ts && npm run test:db -- tests/db/purge.test.ts`
Expected: FAIL (modules and functions missing).

- [ ] **Step 3: Implement the TypeScript modules**

`src/security/step-up.ts`:
```ts
export const STEP_UP_MAX_AGE_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const CODE_METHODS = new Set(['otp', 'email', 'magiclink']);

export class StepUpRequiredError extends Error {
  constructor() {
    super('Please confirm with a fresh email code to continue');
    this.name = 'StepUpRequiredError';
  }
}

export interface AuthClaims {
  amr?: { method: string; timestamp: number }[];
}

/** Sensitive actions need an emailed code entered in the last 10 minutes. */
export function assertRecentStepUp(claims: AuthClaims, nowSeconds: number, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS): void {
  const recent = (claims.amr ?? []).some(
    (a) =>
      CODE_METHODS.has(a.method) &&
      Number.isFinite(a.timestamp) &&
      a.timestamp <= nowSeconds + CLOCK_SKEW_SECONDS &&
      nowSeconds - a.timestamp <= maxAgeSeconds,
  );
  if (!recent) throw new StepUpRequiredError();
}
```

`src/security/audit.ts`:
```ts
import type { Db } from './login-guard';

const PERSONAL_KEY = /(^|_)(name|email|phone|mobile|address|postcode|sortcode|accountnumber|password|token|secret)($|_)/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export interface AuditEntry {
  tenantId: string | null;
  userId: string | null;
  impersonatorId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

function normaliseKey(key: string): string {
  // camelCase to snake_case, then drop separators inside compound words like sort_code
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/sort_code/g, 'sortcode').replace(/account_number/g, 'accountnumber');
}

/** The audit trail records what happened, never who the customers are. */
export function assertNoPersonalData(meta: unknown): void {
  if (Array.isArray(meta)) return meta.forEach(assertNoPersonalData);
  if (typeof meta === 'string') {
    if (EMAIL_VALUE.test(meta)) throw new Error('Audit data must not contain personal data (email address found)');
    return;
  }
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (PERSONAL_KEY.test(normaliseKey(key))) throw new Error(`Audit data must not contain personal data (key: ${key})`);
      assertNoPersonalData(value);
    }
  }
}

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  const meta = e.meta ?? {};
  assertNoPersonalData(meta);
  await db.query(
    `insert into public.audit_log (tenant_id, user_id, impersonator_id, action, entity, entity_id, ip, user_agent, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.tenantId, e.userId, e.impersonatorId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.ip ?? null, e.userAgent ?? null, JSON.stringify(meta)],
  );
}
```

- [ ] **Step 4: Write the purge migration**

`supabase/migrations/003_purge.sql`:
```sql
-- 003_purge: the 30-day customer purge and owner-requested erasure. Service role only.
-- The scheduled job must: 1) list expired customers, 2) delete their stored files (PDFs, photos),
-- 3) only then call purge_expired_customers. If step 2 fails, do not run step 3.

create function private.expired_customers(p_now timestamptz default now())
returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.tenant_id from public.customers c where c.purge_at < p_now
$$;

create function private.customer_storage_paths(p_customer_ids uuid[])
returns setof text
language sql stable security definer set search_path = '' as $$
  select d.pdf_path from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
    where j.customer_id = any (p_customer_ids) and d.pdf_path is not null
  union
  select v.pdf_path from public.document_versions v
    join public.documents d on d.id = v.document_id and d.tenant_id = v.tenant_id
    join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
    where j.customer_id = any (p_customer_ids) and v.pdf_path is not null
  union
  select p.storage_path from public.job_photos p join public.jobs j on j.id = p.job_id and j.tenant_id = p.tenant_id
    where j.customer_id = any (p_customer_ids)
$$;

create function private.purge_expired_customers(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform set_config('app.allow_final_delete', 'on', true);
  with d as (delete from public.customers where purge_at < p_now returning 1) select count(*) into n from d;
  insert into public.purge_log (customers_purged) values (n);
  return n;
end $$;

create function private.erase_customer(p_tenant uuid, p_customer uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform set_config('app.allow_final_delete', 'on', true);
  with d as (delete from public.customers where id = p_customer and tenant_id = p_tenant returning 1) select count(*) into n from d;
  return n;
end $$;

revoke all on function private.expired_customers(timestamptz) from public, anon, authenticated;
revoke all on function private.customer_storage_paths(uuid[]) from public, anon, authenticated;
revoke all on function private.purge_expired_customers(timestamptz) from public, anon, authenticated;
revoke all on function private.erase_customer(uuid, uuid) from public, anon, authenticated;
grant execute on function private.expired_customers(timestamptz) to service_role;
grant execute on function private.customer_storage_paths(uuid[]) to service_role;
grant execute on function private.purge_expired_customers(timestamptz) to service_role;
grant execute on function private.erase_customer(uuid, uuid) to service_role;
```

- [ ] **Step 5: Apply and run**

Run: `npm run db:migrate && npx vitest run tests/unit/step-up.test.ts tests/unit/audit.test.ts && npm run test:db && npx tsc --noEmit`
Expected: `Applied: 003_purge.sql`; all PASS. If the `customer_storage_paths` column name in the test differs, check the real column name returned and fix the TEST accordingly (the function name is the column for `returns setof text`).

- [ ] **Step 6: Commit**

```bash
git add src/security supabase/migrations/003_purge.sql tests
git commit -m "feat: step-up check, audit writer with PII refusal, and the 30-day purge functions"
```

---

### Task 6: Tenant wording schema, FJC seed and invite script

**Files:**
- Create: `src/db/wording.ts`, `src/db/seed-fjc.ts`, `scripts/seed-fjc.ts`, `src/db/invite.ts`, `scripts/invite-user.ts`
- Modify: `README.md` (Database section), `.env.example`
- Test: `tests/unit/wording.test.ts`, `tests/db/seed.test.ts`, `tests/db/invite.test.ts`

**Interfaces:**
- Produces:
  - `tenantWordingSchema` (zod) and `type TenantWording`: keys `quote.terms`, `deposit_invoice.terms`, `deposit_invoice.dueLabel`, `deposit_invoice.balanceDueLabel`, `balance_invoice.terms`, `balance_invoice.dueNote`, `receipt.balanceDueLabel`, `guarantee.statement`, `guarantee.disclaimerLine` (nullable); every string non-empty
  - `FJC_WORDING: TenantWording` and `seedFjc(db: Db): Promise<{ tenantId: string; created: boolean }>` (idempotent: finds the tenant by name `FJC Roofing Ltd`, else creates tenant, defaults, job types `flat_roof` (20 years), `tiled_roof` (25), `fascia` (none), `other` (none), and a brand kit with the FJC colours; never inserts bank details or users)
  - `parseInviteArgs(argv: string[]): { email: string; tenantName: string; role: 'owner' | 'staff'; fullName: string }` (throws on missing or invalid input)
  - `interface AuthAdmin { createUser(a: { email: string; email_confirm: boolean }): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> }`
  - `inviteUser(deps: { admin: AuthAdmin; db: Db }, args: InviteArgs): Promise<{ userId: string; tenantId: string }>` (looks up the tenant by name, creates the auth user with `email_confirm: true`, inserts the `profiles` row with the lowercased email; throws if the tenant does not exist or the email already has a profile)

- [ ] **Step 1: Write the failing tests**

`tests/unit/wording.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FJC_WORDING, tenantWordingSchema } from '../../src/db/wording';

describe('tenantWordingSchema', () => {
  it('accepts the FJC wording', () => {
    expect(tenantWordingSchema.parse(FJC_WORDING)).toEqual(FJC_WORDING);
  });
  it('rejects a missing key', () => {
    const { quote: _quote, ...rest } = FJC_WORDING;
    expect(() => tenantWordingSchema.parse(rest)).toThrow();
  });
  it('rejects empty strings', () => {
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, quote: { terms: '' } })).toThrow();
  });
  it('allows the guarantee disclaimer line to be null', () => {
    expect(tenantWordingSchema.parse({ ...FJC_WORDING, guarantee: { statement: 'x', disclaimerLine: null } }).guarantee.disclaimerLine).toBeNull();
  });
  it('the FJC wording contains no personal data and no bank details', () => {
    const text = JSON.stringify(FJC_WORDING);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\d{2}-\d{2}-\d{2}/);
  });
});
```

`tests/db/seed.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { seedFjc } from '../../src/db/seed-fjc';
import { tenantWordingSchema } from '../../src/db/wording';
import { dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('seedFjc', () => {
  it('creates the FJC tenant, defaults, job types and brand kit, and is idempotent', async () => {
    await withRollback(async (c) => {
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      const first = await seedFjc(c);
      expect(first.created).toBe(true);
      const second = await seedFjc(c);
      expect(second).toEqual({ tenantId: first.tenantId, created: false });
      const t = await c.query(`select * from public.tenants where id = $1`, [first.tenantId]);
      expect(t.rows[0]).toMatchObject({ name: 'FJC Roofing Ltd', company_number: '13855379', vat_registered: true, owner_name: 'Ben Cunningham', owner_title: 'Director' });
      const d = await c.query(`select * from public.tenant_defaults where tenant_id = $1`, [first.tenantId]);
      expect(d.rows[0]).toMatchObject({ deposit_pct_bp: 3000, quote_validity_days: 30, vat_rate_bp: 2000 });
      expect(() => tenantWordingSchema.parse(d.rows[0].terms)).not.toThrow();
      const jt = await c.query(`select key, guarantee_years from public.job_types where tenant_id = $1 order by key`, [first.tenantId]);
      expect(jt.rows).toEqual([
        { key: 'fascia', guarantee_years: null },
        { key: 'flat_roof', guarantee_years: 20 },
        { key: 'other', guarantee_years: null },
        { key: 'tiled_roof', guarantee_years: 25 },
      ]);
      const kit = await c.query(`select colours from public.brand_kits where tenant_id = $1`, [first.tenantId]);
      expect(kit.rows[0].colours.navy).toBe('#0f2b4a');
      const bank = await c.query(`select count(*)::int n from public.bank_accounts where tenant_id = $1`, [first.tenantId]);
      expect(bank.rows[0].n).toBe(0);
      const users = await c.query(`select count(*)::int n from public.profiles where tenant_id = $1`, [first.tenantId]);
      expect(users.rows[0].n).toBe(0);
    });
  });
});
```
(The `delete` at the start is inside the rolled-back transaction, so a real seeded FJC tenant is untouched.)

`tests/db/invite.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inviteUser, parseInviteArgs } from '../../src/db/invite';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

describe('parseInviteArgs', () => {
  it('parses a valid invite', () => {
    expect(parseInviteArgs(['Ben@FJC.example', 'FJC Roofing Ltd', 'owner', 'Ben Cunningham'])).toEqual({
      email: 'ben@fjc.example', tenantName: 'FJC Roofing Ltd', role: 'owner', fullName: 'Ben Cunningham',
    });
  });
  it('rejects bad input', () => {
    expect(() => parseInviteArgs([])).toThrow(/usage/i);
    expect(() => parseInviteArgs(['not-an-email', 'T', 'owner', 'N'])).toThrow(/email/i);
    expect(() => parseInviteArgs(['a@b.co', 'T', 'admin', 'N'])).toThrow(/role/i);
  });
});

describe.skipIf(!dbAvailable)('inviteUser', () => {
  it('creates the auth user and a profile in the named tenant', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Invite Test Co');
      const newId = randomUUID();
      const admin = {
        async createUser(a: { email: string; email_confirm: boolean }) {
          expect(a.email_confirm).toBe(true);
          await c.query(`insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`, [newId, a.email]);
          return { data: { user: { id: newId } }, error: null };
        },
      };
      const r = await inviteUser({ admin, db: c }, { email: 'new.person@example.test', tenantName: 'Invite Test Co', role: 'staff', fullName: 'New Person' });
      expect(r).toEqual({ userId: newId, tenantId: t.tenantId });
      const p = await c.query(`select role, email, tenant_id from public.profiles where id = $1`, [newId]);
      expect(p.rows[0]).toEqual({ role: 'staff', email: 'new.person@example.test', tenant_id: t.tenantId });
    });
  });

  it('refuses an unknown tenant without creating a user', async () => {
    await withRollback(async (c) => {
      let called = false;
      const admin = { async createUser() { called = true; return { data: { user: null }, error: null }; } };
      await expect(inviteUser({ admin, db: c }, { email: 'a@b.test', tenantName: 'No Such Co', role: 'staff', fullName: 'X' })).rejects.toThrow(/tenant/i);
      expect(called).toBe(false);
    });
  });

  it('surfaces an auth error', async () => {
    await withRollback(async (c) => {
      await createTenantWithUser(c, 'Invite Test Co');
      const admin = { async createUser() { return { data: { user: null }, error: { message: 'already registered' } }; } };
      await expect(inviteUser({ admin, db: c }, { email: 'a@b.test', tenantName: 'Invite Test Co', role: 'staff', fullName: 'X' })).rejects.toThrow(/already registered/);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/wording.test.ts && npm run test:db -- tests/db/seed.test.ts tests/db/invite.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/db/wording.ts`:
```ts
import { z } from 'zod';

const text = z.string().trim().min(1);

/** Document wording owned by each business (terms, due labels, guarantee wording). Never written by code. */
export const tenantWordingSchema = z.object({
  quote: z.object({ terms: text }),
  deposit_invoice: z.object({ terms: text, dueLabel: text, balanceDueLabel: text }),
  balance_invoice: z.object({ terms: text, dueNote: text }),
  receipt: z.object({ balanceDueLabel: text }),
  guarantee: z.object({ statement: text, disclaimerLine: text.nullable() }),
});

export type TenantWording = z.infer<typeof tenantWordingSchema>;

/** FJC's own wording, taken from its existing documents. */
export const FJC_WORDING: TenantWording = {
  quote: {
    terms:
      'This quotation is valid for 30 days from the date above. All materials supplied and installed as part of this contract remain the property of FJC Roofing Ltd until paid for in full.',
  },
  deposit_invoice: {
    terms: 'The 30% deposit is payable before works start. The remaining balance is due on completion of works.',
    dueLabel: 'Before works start',
    balanceDueLabel: 'Balance due on completion',
  },
  balance_invoice: {
    terms: 'Payment is due upon receipt of this invoice.',
    dueNote: 'Payment is due upon receipt of this invoice',
  },
  receipt: { balanceDueLabel: 'Due on completion of works' },
  guarantee: {
    statement: 'Any defect in installation that occurs within this period will be repaired at no cost to the customer.',
    disclaimerLine: 'We cannot be held responsible for misuse of our products by the customer',
  },
};
```

`src/db/seed-fjc.ts`:
```ts
import type { Db } from '../security/login-guard';
import { FJC_WORDING } from './wording';

const FJC_COLOURS = {
  navy: '#0f2b4a', navy2: '#16395f', navy3: '#1f4a78', blue: '#2f6fbf', sky: '#7fa6dc', ice: '#e9f0f9',
  gold: '#c9a24b', gold2: '#e4cf9a', goldbg: '#faf5e8', ink: '#152235', body: '#3a4657', muted: '#6b7686',
  rule: '#dde3eb', paper: '#f4f6fa',
};

const FJC_DISCLAIMER =
  'This document is generated using third-party software. The platform is not a party to any contract formed between the customer and the trader for the services listed within this document. The platform has not benchmarked, endorsed, or verified the services or prices stated. For information on how personal data is processed, please refer to the relevant Privacy Notice.';

const JOB_TYPES: [string, string, number | null][] = [
  ['flat_roof', 'Flat roof', 20],
  ['tiled_roof', 'Tiled roof', 25],
  ['fascia', 'Fascias and guttering', null],
  ['other', 'Other', null],
];

/** Idempotent. Seeds business facts only: no bank details, no users, no customers. */
export async function seedFjc(db: Db): Promise<{ tenantId: string; created: boolean }> {
  const existing = await db.query(`select id from public.tenants where name = 'FJC Roofing Ltd'`);
  if (existing.rows.length > 0) return { tenantId: existing.rows[0].id, created: false };

  const t = await db.query(
    `insert into public.tenants (name, trade_type, company_number, vat_registered, vat_number, address_lines, phone, email, website, tagline, owner_name, owner_title)
     values ('FJC Roofing Ltd', 'roofing', '13855379', true, 'GB 408094403', $1, '07596115834', 'Ben@fjcroofingltd.com', 'www.fjcroofingltd.co.uk',
             'Covering Your Home, Protecting Your Family', 'Ben Cunningham', 'Director')
     returning id`,
    [['Rochester', 'United Kingdom', 'ME3 9UD']],
  );
  const tenantId = t.rows[0].id as string;
  await db.query(
    `insert into public.tenant_defaults (tenant_id, deposit_pct_bp, quote_validity_days, vat_default, vat_rate_bp, terms, disclaimer_text, number_formats)
     values ($1, 3000, 30, true, 2000, $2, $3, $4)`,
    [tenantId, JSON.stringify(FJC_WORDING), FJC_DISCLAIMER, JSON.stringify({ quote: 'QT-{ref}', deposit_invoice: 'INV-{ref}-D', balance_invoice: 'INV-{ref}-B', receipt_deposit: 'RCP-{ref}-D', receipt_balance: 'RCP-{ref}-B', guarantee: 'GC-{ref}' })],
  );
  for (const [key, label, years] of JOB_TYPES) {
    await db.query(`insert into public.job_types (tenant_id, key, label, guarantee_years) values ($1, $2, $3, $4)`, [tenantId, key, label, years]);
  }
  await db.query(`insert into public.brand_kits (tenant_id, theme_key, colours, fonts) values ($1, 'fjc', $2, $3)`, [
    tenantId,
    JSON.stringify(FJC_COLOURS),
    JSON.stringify({ heading: 'Playfair Display', body: 'Inter', mono: 'JetBrains Mono' }),
  ]);
  return { tenantId, created: true };
}
```

`scripts/seed-fjc.ts`:
```ts
import { connect } from '../src/db/connect';
import { seedFjc } from '../src/db/seed-fjc';

async function main() {
  const client = await connect();
  try {
    await client.query('begin');
    const r = await seedFjc(client);
    await client.query('commit');
    console.log(r.created ? 'Seeded FJC Roofing Ltd.' : 'FJC Roofing Ltd already exists.');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
```

`src/db/invite.ts`:
```ts
import type { Db } from '../security/login-guard';

export interface InviteArgs {
  email: string;
  tenantName: string;
  role: 'owner' | 'staff';
  fullName: string;
}

export interface AuthAdmin {
  createUser(a: { email: string; email_confirm: boolean }): Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>;
}

const USAGE = 'Usage: npm run invite -- <email> "<business name>" <owner|staff> "<full name>"';

export function parseInviteArgs(argv: string[]): InviteArgs {
  if (argv.length !== 4) throw new Error(USAGE);
  const [email, tenantName, role, fullName] = argv;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That does not look like an email address');
  if (role !== 'owner' && role !== 'staff') throw new Error('The role must be owner or staff');
  if (!tenantName.trim() || !fullName.trim()) throw new Error(USAGE);
  return { email: email.trim().toLowerCase(), tenantName: tenantName.trim(), role, fullName: fullName.trim() };
}

/** Registers a person against one business. Without a profile row, an email can never get in. */
export async function inviteUser(deps: { admin: AuthAdmin; db: Db }, a: InviteArgs): Promise<{ userId: string; tenantId: string }> {
  const t = await deps.db.query(`select id from public.tenants where name = $1`, [a.tenantName]);
  if (t.rows.length === 0) throw new Error(`No such tenant: ${a.tenantName}`);
  const created = await deps.admin.createUser({ email: a.email, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? 'The user could not be created');
  const userId = created.data.user.id;
  await deps.db.query(`insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, $3, $4, $5)`, [
    userId,
    t.rows[0].id,
    a.role,
    a.fullName,
    a.email,
  ]);
  return { userId, tenantId: t.rows[0].id };
}
```

`scripts/invite-user.ts`:
```ts
import { createClient } from '@supabase/supabase-js';
import { connect } from '../src/db/connect';
import { inviteUser, parseInviteArgs } from '../src/db/invite';

async function main() {
  const args = parseInviteArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local)');
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = await connect();
  try {
    const r = await inviteUser({ admin: supabase.auth.admin, db }, args);
    console.log(`Invited ${args.email} to ${args.tenantName} as ${args.role} (user ${r.userId}).`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
```
Install the dependency and add the script: `npm i @supabase/supabase-js` and `npm pkg set scripts.invite="tsx --env-file=.env.local scripts/invite-user.ts"`.

README addition (append to `README.md`):
```markdown
## Database

The database is a hosted Supabase project. Put its connection details in `.env.local` (never commit it; see `.env.example`).

- `npm run db:migrate` applies pending SQL in `supabase/migrations/`. Applied migrations are never edited; add a new numbered file.
- `npm run db:seed` seeds the FJC business (facts and wording only, no bank details, no users).
- `npm run test:db` runs the database tests (each in a rolled-back transaction).
- `npm run invite -- <email> "<business name>" <owner|staff> "<full name>"` registers a person against one business. It needs the service key in `.env.local`. People who have not been invited cannot log in.

Security model in one paragraph: every table has row level security (forced); signed-in users only ever see their own business; bank details are encrypted in the app and unreadable to the app role; sensitive writes happen on the server after a fresh email code; the audit log is append only and holds no personal data; customer data is purged 30 days after last activity.
```
`.env.example` additions:
```
DATABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
BANK_ENCRYPTION_KEY=
LOGIN_PEPPER=
ANTHROPIC_API_KEY=
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/wording.test.ts && npm run test:db && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Seed FJC into the dev database (one-off, real write)**

Run: `npm run db:seed`
Expected: `Seeded FJC Roofing Ltd.`; running it again prints `FJC Roofing Ltd already exists.`

- [ ] **Step 6: Commit**

```bash
git add src/db scripts README.md .env.example tests package.json package-lock.json
git commit -m "feat: tenant wording schema, FJC seed and invite script"
```

---

## Out of scope for this plan (later plans)

- Supabase Auth project settings (sign-ups off, email one-time code template) and the login screens: Plan 5, and a few dashboard switches that need Alfie or the service key.
- The two other Supabase keys in `.env.local`, `BANK_ENCRYPTION_KEY` and `LOGIN_PEPPER`: generated and set when the app is switched on.
- Storage buckets and signed URLs, the render adapter for Vercel, the AI scope step, the owner screens, the daily purge schedule.
