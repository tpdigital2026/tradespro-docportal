# TradesPro DocPortal

Branded trade paperwork from a short form. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the build plans.

## Scripts

- `npm test` runs fast unit tests.
- `npm run test:render` runs Chromium rendering tests. It needs Chrome and the reference zip extracted to `reference/` (see below).
- `npm run spike` renders the quotation to `out/`.

## Reference material (not committed)

```bash
mkdir -p reference && unzip -q ~/Downloads/DocPortal_Reference.zip -d reference
```

## Database

The database is a hosted Supabase project. Put its connection details in `.env.local` (never commit it; see `.env.example`).

- `npm run db:migrate` applies pending SQL in `supabase/migrations/`. Applied migrations are never edited; add a new numbered file.
- `npm run db:seed` seeds the FJC business (facts and wording only, no bank details, no users, no customers).
- `npm run test:db` runs the database tests (each in a rolled-back transaction, except the few that clean up after themselves).
- `npm run invite -- <email> "<business name>" <owner|staff> "<full name>" [--tenant-id <uuid>]` registers a person against one business. Business names are unique ignoring case; it refuses if more than one business matches, and removes the new login again if the profile cannot be created. It is invite only, there are no passwords, and it needs `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`. It stops with a clear message if either is missing. People who have not been invited cannot log in.

Security model in one paragraph: every table has row level security (enabled and forced); signed-in users only ever see their own business; bank details are encrypted in the app and unreadable to the app role; sensitive writes happen on the server after a fresh email code; the audit log is append only and holds no personal data; customer data is purged 30 days after last activity.

### Tenant wording

Terms, due labels and guarantee wording belong to each business. They live in `tenant_defaults.terms`, validated by `tenantWordingSchema` (`src/db/wording.ts`). Code never writes them. The FJC seed uses only wording already present in FJC's documents. Not seeded yet because there is no confirmed source: `tenant_defaults.disclaimer_text`, `tenant_defaults.number_formats`, bank details, brand assets and logos.

### Supabase Auth settings (dashboard)

- Sign-ups off, so only invited people can get an account.
- Email one-time code: 6 digits, valid for 10 minutes, single use. The short life and single use are what cap guessing, so do not lengthen them.

### Login route requirements

- Call `verifyWithGuard` and `requestCodeWithGuard`, never the pure `decide*` functions directly. Give them a dedicated connection, not a pool: the advisory lock only holds on one connection, and a pooled client silently loses it.
- Read the client IP from the platform-trusted header (the one the host sets and clients cannot forge), never the leftmost `X-Forwarded-For` entry. Log, without leaking, any raw value that normalises to the `0.0.0.0` sentinel.
- Map `LOGIN_GUARD_BUSY` and Postgres error `55P03` (lock timeout) to a "try again" response.
- Return identical responses for unknown emails, locked accounts and wrong codes.
- Lockout is per account and per IP, lasts 15 minutes, and can be triggered by a third party who keeps submitting wrong codes for someone else's email. That is an accepted trade-off.
- Set a role-level `idle_in_transaction_session_timeout` for the connection the route uses.
- `login_attempts` rows and the IP addresses in them are personal data. The privacy notice must say so. They are deleted by `private.purge_old_login_attempts`.

### Server code rules

- Finalise must `select ... for update` the document row before checking its status and writing the version.
- Every save that inserts a document version must also `select ... for update` the document row first, and the server retries once on deadlock (40P01). Without that, two saves of the same draft (a double submit) can deadlock against the draft check, which reads the document row with `for share`.
- Finalising and sending run on a service connection with no app JWT. Never run them through a `SECURITY DEFINER` function that carries a user JWT: the draft lock will refuse it, by design.
- Server code that acts as a user on a pooled connection must reset `request.jwt.claims` afterwards, or the next borrower inherits that identity.
- Archive bank accounts, never delete them, once a finalised version references them.
- `css_overrides` is untrusted input and the renderer must sanitise it.
- Storage keys must never be URL-decoded. The path checks in the database are literal.
- Server-owned columns (status, finalised state, money, storage paths, `purge_at` and similar) are written through the service role, not by the app role.

### Adding a table or extension

New `public` table checklist: row level security enabled and forced, explicit grants only (no default grants), and no view without `security_invoker`. Extensions go in the `extensions` schema. `private` must never be an exposed API schema.

### Purge job protocol

Customer data is removed 30 days after last activity. The scheduled job runs the whole protocol in ONE transaction, on a service connection with no `request.jwt.claims` (a leaked claim makes the final-version guard refuse the purge, which fails closed), with a generous `statement_timeout`:

1. `private.claim_expired_customers` locks the expired customers and everything under them.
2. `private.expired_storage_paths` lists their files.
3. Delete those files from storage.
4. `private.purge_customers` deletes the claimed customers and writes a `purge_log` row (a zero-count run is a heartbeat).

Residual risk: if the connection drops after the files are deleted, the customer stays expired and is purged on the next run. A write in that gap can leave a kept customer pointing at deleted files. A single transaction and a long statement timeout keep this window small.

### Owner-requested erasure protocol

Same shape as the purge, one customer, ONE transaction on a service connection with no `request.jwt.claims`:

1. `private.claim_customer(tenant, customer)` takes the same lock set and order as the batch claim (`private.lock_customer_tree`). It returns false if the customer is not in that business.
2. `private.customer_storage_paths(tenant, customer)` lists the files.
3. Delete those files from storage; abort and roll back on any failure.
4. `private.erase_customer(tenant, customer)`, then commit.

### More server rules

- Uploads: insert the database row first, then upload the file, and delete the row (and any partial file) if the upload fails. A storage orphan sweep (files with no row) is still needed and is not built yet.
- Bank accounts: the app role can only read the safe columns; every write goes through the server on the service role. The server must check `role = owner` AND a fresh step-up before any bank write. The database does not check the owner role on these writes because the app role has no write grant at all.
- Share tokens: generate them on the server. The server applies the 14-day default expiry; the database only enforces a 30-day maximum.
- Deleting a staff auth user fails if they created finalised versions. Disable the person (`disabled_at`) and never delete them.
- `audit_log` IP addresses have no retention rule yet (decision pending). The audit personal-data check cannot catch names or addresses typed into free text, so callers must pass ids and codes only.

### Known residual risk (open decision for Plan 5)

Supabase Auth's own `/auth/v1/otp` and `/auth/v1/verify` endpoints are reachable with the public anon key, so the 5-wrong-codes lock in `verifyWithGuard` does not stop someone guessing codes directly against them. Mitigations in place: single-use 10-minute 6-digit codes and tight Supabase rate limits. Plan 5 must decide between server-issued codes (so the guard sits in front of every guess) and accepting Supabase's own limits.
