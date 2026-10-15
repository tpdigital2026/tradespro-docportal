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

Security model in one paragraph: every table has row level security (enabled and forced); signed-in users only ever see their own business; bank details are encrypted in the app and unreadable to the app role; sensitive writes happen on the server after a fresh email code; the audit log is append only and holds no personal data; customer data is purged after a per-business retention period (default 90 days) with no activity.

### Tenant wording

Terms, due labels and guarantee wording belong to each business. They live in `tenant_defaults.terms`, validated by `tenantWordingSchema` (`src/db/wording.ts`). Code never writes them. The FJC seed uses only wording already present in FJC's documents. Not seeded yet because there is no confirmed source: `tenant_defaults.disclaimer_text`, `tenant_defaults.number_formats`, bank details, brand assets and logos.

### Supabase Auth settings (dashboard)

- Sign-ups off, so only invited people can get an account.
- Email one-time code: 8 digits (Supabase's default; the app reads the length from `OTP_LENGTH` in `src/lib/otp.ts`, so change both together), valid for 10 minutes, single use. The short life and single use are what cap guessing, so do not lengthen them.
- Sessions end at the business's session policy (Settings, "Signing out"): after `idle_logout_minutes` with no activity (10 to 480, default 30) and `max_session_days` after the email code was entered (1 to 30, default 7), never later than 30 days. See "Session policy" below. Also set Supabase's "time-box user sessions" to 30 days as an outer cap.
- Required environment variables: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `LOGIN_PEPPER` (32+ characters) and `SESSION_SECRET` (32+ characters, signs the login-time and activity cookies). With any missing, both login routes answer a generic "try again shortly", no code is emailed and nobody can sign in. Also needed: `SUPABASE_SERVICE_ROLE_KEY` (storage), `BANK_ENCRYPTION_KEY` (32 bytes, base64; without it bank accounts cannot be saved or printed) and `CRON_SECRET` (32+ random characters; Vercel sends it as `Authorization: Bearer ...` to the maintenance cron, which answers 401 without it).

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
- Lock order is the job row, then the document row, everywhere a job's documents or payments change: finalise (phase B), revise of an issued quote, saving a follow-on draft (`saveFollowOnWith`) and recording a payment (`recordPaymentWith`, which locks the job row before its invoice row: the payment insert takes a key share on the job row through its foreign key, so locking the invoice first could wait behind a finalise holding the job while that finalise waits for the invoice). Taking the rows in one order removes the deadlocks we know of between these paths, but foreign key checks and triggers take other row locks too, so this is not a proof that none can ever happen: finalise, revise, `recordPaymentWith` and `saveFollowOnWith` each retry once on 40P01 (a deadlock rolls the whole attempt back), and a lock timeout (55P03) on the job or document row answers "someone else is working on this, try again".
- Finalise renders and uploads before taking any lock, into a folder unique to that request (`{tenant}/{customer}/{job}/{version}/{random}/`), never overwriting. The committed row records the exact PDF path (page images sit beside it). A request deletes only its own folder, only when it is certain the folder is unreferenced; when a commit's outcome is unknown nothing is deleted and the storage orphan sweep removes unreferenced request folders and `preview-{key}` folders later.
- Finalising and sending run on a service connection with no app JWT. Never run them through a `SECURITY DEFINER` function that carries a user JWT: the draft lock will refuse it, by design.
- Server code that acts as a user on a pooled connection must reset `request.jwt.claims` afterwards, or the next borrower inherits that identity.
- Archive bank accounts, never delete them, once a finalised version references them.
- `css_overrides` is untrusted input and the renderer must sanitise it.
- Storage keys must never be URL-decoded. The path checks in the database are literal.
- Server-owned columns (status, finalised state, money, storage paths, `purge_at` and similar) are written through the service role, not by the app role.

### Adding a table or extension

New `public` table checklist: row level security enabled and forced, explicit grants only (no default grants), and no view without `security_invoker`. Extensions go in the `extensions` schema. `private` must never be an exposed API schema.

### Purge job protocol

Customer data is removed once a customer's `purge_at` passes. `purge_at` is last activity plus the business's `tenant_defaults.retention_days` (30 to 730, default 90; set by migration 004, existing dates are only ever extended, never shortened). The scheduled job runs the whole protocol in ONE transaction, on a service connection with no `request.jwt.claims` (a leaked claim makes the final-version guard refuse the purge, which fails closed), with a generous `statement_timeout`:

1. `private.claim_expired_customers` locks the expired customers and everything under them.
2. `private.expired_storage_paths` lists their files.
3. Delete those files from storage.
4. `private.purge_customers` deletes the claimed customers and writes a `purge_log` row (a zero-count run is a heartbeat).

Residual risk: if the connection drops after the files are deleted, the customer stays expired and is purged on the next run. A write in that gap can leave a kept customer pointing at deleted files. A single transaction and a long statement timeout keep this window small.

It is scheduled: Vercel Cron (`vercel.json`, daily at 03:15 UTC) calls `GET /api/cron/maintenance` with `Authorization: Bearer ${CRON_SECRET}` (compared in constant time; 401 without it or when the variable is unset or shorter than 32 characters). The route is public in the proxy because it carries no session. It runs, in order and each on its own service connection: this purge protocol (`purgeExpiredWith`, one transaction, no claims, 300 second statement timeout, the real storage client; a storage failure rolls the database step back), `private.purge_old_login_attempts`, then the storage orphan sweep. A failed step does not stop the next; the answer is 500 when any failed. Logs and the answer hold counts only. `?dry=1` makes the sweep report without deleting.

### Storage orphan sweep

`sweepOrphansWith` (`src/lib/maintenance/orphan-sweep.ts`) lists every file under each business's `{tenant}/` folder and deletes a file only when it is older than 24 hours (with a known creation time), has one of the shapes this app writes (a finalise request folder, the older per-version files, a `preview-{key}` folder, a `{photo}.jpg`, a `brand/signature-{id}.png`) and nothing references it: no `documents`/`document_versions` `pdf_path` or the folder the PDF and its page images share, no `final_content.files`, no `job_photos` path, no `brand_assets` path; a preview is in use while its version is a draft. Any other shape is never deleted, only counted, so a file written by code the sweep does not know is safe. **Merge hazard:** any new kind of stored file (a new table or column holding a path, or a new path shape) must be added to the sweep's shape list and reference query (`SWEEP_REFERENCE_COLUMNS`, `SWEEP_REVIEWED_TABLES` in `orphan-sweep.ts`). Otherwise its files are either kept forever (unknown shape) or, worse, deleted after a day (a known shape whose column is not read). `tests/db/maintenance.test.ts` fails when a path-like column or an unreviewed table appears; at integration, review `appointments` (business tabs) and any survey table and add them.

### Retention and the in-app notice

No email is sent in Phase 1, so the owner is told on screen. A customer's page and the customers list show "Data kept until {date}". With 14 days or fewer left they show a warning and a one-tap "Keep for another {retention_days} days". That action runs on the server through `private.extend_customer_retention(tenant, customer)` (service role only, tenant scoped, only ever extends) and writes an audit entry with the customer id and nothing else. The app role has no write grant on `purge_at`.

### Owner-requested erasure protocol

Same shape as the purge, one customer, ONE transaction on a service connection with no `request.jwt.claims`:

1. `private.claim_customer(tenant, customer)` takes the same lock set and order as the batch claim (`private.lock_customer_tree`). It returns false if the customer is not in that business.
2. `private.customer_storage_paths(tenant, customer)` lists the files.
3. Delete those files from storage; abort and roll back on any failure.
4. `private.erase_customer(tenant, customer)`, then commit.

In the app this is `eraseCustomerWith` (`src/lib/data/customer-admin.ts`). It needs the owner role and a fresh emailed code (`requireFreshStepUpForRequest`, which verifies the token's signature before reading `amr`). Storage deletion goes through the `StorageDeleter` interface (`src/lib/storage.ts`); until buckets exist this is an in-memory stand-in, so wire the real bucket client in before launch.

### More server rules

- Uploads: insert the database row first, then upload the file, and delete the row (and any partial file) if the upload fails; or upload under a fresh name first and record it in one transaction, deleting the file only when that transaction was refused (finalise and the signature do this). The storage orphan sweep removes files with no row.
- Bank accounts: the app role can only read the safe columns; every write goes through the server on the service role. The server must check `role = owner` AND a fresh step-up before any bank write. The database does not check the owner role on these writes because the app role has no write grant at all.

### Owner settings (/settings, migration 040)

- Everyone in the business can open Settings; only the owner sees controls, and every server action checks the role from the session again. Bank accounts (add, rename, make default, archive), turning signature printing on, storing a signature picture, `retention_days` and the session policy each need a fresh emailed code (`requireFreshStepUpForRequest`): the browser runs the code step when the action answers `step-up`, then repeats the same action. Turning printing off and deleting the picture need only the owner role. Every change writes an audit row with ids and setting values only.
- Bank numbers are validated and normalised (`src/lib/validation/settings.ts`, the same normalisers encryption uses: sort code 6 digits, account number exactly 8), encrypted with `encryptBankDetails` (AES-256-GCM, AAD per tenant and field) before the transaction starts, never logged and never returned: after saving only the last four digits appear anywhere outside the encrypted columns. They are decrypted only at render time. The first account becomes the default; archiving the default makes the oldest other active account the default; accounts are never deleted. At most 10 active accounts.
- Signature: a PNG or JPG up to 1 MB, checked by its header (type and dimensions) before decoding, then redrawn by the render browser (no network) to a fresh PNG of at most 1200 by 400 with near-white paper made transparent, cut down to its essential PNG chunks: no EXIF, GPS, XMP, ICC profile or text survives. It is stored in the private `documents` bucket at `{tenant}/brand/signature-{id}.png` with a `brand_assets` row (kind `signature`, server-only by trigger). The loader prints it (`signatureWith`) only when `tenant_defaults.signature_consent` is on; it is part of the brand fingerprint in the content key, so switching it means reading the document again.
- Migration 040's trigger refuses any app-role change to `retention_days`, `idle_logout_minutes`, `max_session_days` and the consent columns, any app-role delete of the `tenant_defaults` row (which would reset them) and any app-role insert that is not all defaults. Other `tenant_defaults` columns keep the owner policies from 002.
- Demo mode: the fresh-code step uses a stand-in that is separate from real mode (`src/lib/step-up-demo.ts`, `POST /api/demo/step-up`, 404 unless `isDemo()`): the dummy code is shown on screen and a correct entry sets a process-signed cookie valid for 10 minutes. Real mode never reads that cookie.

### Session policy

- At sign-in the verify route writes an activity cookie (`dp-la`): `userId.sessionId.lastAt.idleMinutes.maxDays.mac`, HMAC-SHA256 under a key derived from `SESSION_SECRET` with its own label (domain separated from `dp-st`), bound to the person and the Supabase session, carrying the business's limits. The proxy checks it with the login-time cookie on every authenticated request, signs out (clearing every cookie, `/login?notice=signed-out`, "You were signed out for your security.") when idle too long or past `max_session_days`, and refreshes the time on the response once it is a minute old. It never rewrites the request's copy, so `getSession` checks the time the browser sent against the limits stored in the database now: a stricter setting applies to everyone at once (an ended session goes through `/api/auth/expired`, which clears the cookies); a looser one applies to others from their next sign-in. A missing, forged or mismatched activity cookie is a plain sign-out (people signed in before this release sign in once more).
- A step-up code goes through the same verify route, which keeps the original login time when a genuine, unexpired `dp-st` for the same person is present, so a fresh code can never stretch a session past the maximum.
- Share tokens: generate them on the server. The server applies the 14-day default expiry; the database only enforces a 30-day maximum.
- Deleting a staff auth user fails if they created finalised versions. Disable the person (`disabled_at`) and never delete them.
- `audit_log` IP addresses have no retention rule yet (decision pending). The audit personal-data check cannot catch names or addresses typed into free text, so callers must pass ids and codes only.

### Known residual risk (open decision for Plan 5)

Supabase Auth's own `/auth/v1/otp` and `/auth/v1/verify` endpoints are reachable with the public anon key, so the 5-wrong-codes lock in `verifyWithGuard` does not stop someone guessing codes directly against them. Mitigations in place: single-use 10-minute 8-digit codes and tight Supabase rate limits. Plan 5 must decide between server-issued codes (so the guard sits in front of every guess) and accepting Supabase's own limits.

### Payment plans (jobs.payment_plan)

- The truth for how a job is billed is the plan's **inputs** (kind, deposit percent or the stages as typed) together with the **totals of the quote version** they were made from. `buildSchedule(totals, plan)` in `src/lib/money.ts` recomputes the instalments from those, always.
- The `instalments` array stored inside `payment_plan` is a convenience copy written at draft time, from the totals as they were then. It is **not** the truth: it can be stale after a draft edit and must never be used to raise an invoice. Invoices, balances and stage derivation recompute from the issued version's totals and the plan inputs.
- Quote money is bounded before any plan maths (`MAX_AMOUNT_PENCE`, `MAX_TOTAL_NET_PENCE`, `MAX_VAT_RATE_BP` in money.ts) so integer products stay exact. A stored business VAT rate above 25% is refused loudly ("Your VAT rate setting is not valid"), never swapped for a default, and migration 007 stops the database storing one.
- The quote number and customer belong to the job row. Saves return them, and the form shows what was stored, never what it sent.

### Payments, invoices and receipts (migration 008)

- Document types `invoice_full` (number `INV-{q}`) and `invoice_stage` (`INV-{q}-S{n}`, n 1 to 10) sit beside `deposit_invoice` (`INV-{q}-D`) and `balance_invoice` (`INV-{q}-B`). Receipts are `RCP-{q}-D`, `RCP-{q}-B`, `RCP-{q}` (paid in full) and `RCP-{q}-S{n}`. `{q}` is the job's quote number. `private.claim_document_number` checks the pattern against the job and type, then claims the number in `used_numbers` (forever, never changed), the same as a quote number. The registry limit is now 64 characters because `INV-` plus a 40 character quote number plus `-S10` is 48.
- `payments` is written by the server only (service connection, tenant from the session). The app role can read its own business's rows and nothing else. A payment may only point at a final or sent invoice of the same job, never changes the invoice, and is immutable (change and delete) once a receipt has been finalised from it. Every insert writes an audit entry by trigger: ids, amount and method, never the free-text note.
- "Paid" is derived. An instalment is paid when its recorded payments add up to at least its gross amount, where the gross comes from `buildSchedule` over the latest quote version, as for every other figure. `src/lib/job-stage.ts` derives the rail (Quoted, then Invoiced and Paid per instalment, then Guarantee issued) and the next step from those facts. A "Surveyed" step is reserved for the survey task.
- Recording a payment locks the invoice row, re-reads the payments already recorded and refuses anything that would take the total past the invoice. A repeat of the same payment within 30 seconds returns the first one.
- Every payment has its own receipt. The first payment on an instalment keeps `RCP-{q}-D`, `-B`, `-S{n}` or `RCP-{q}`; the second and later ones end in `-P2` to `-P99` (`RCP-{q}-S3-P2`; migration 011 replaced the bare `-2` of migration 009, which could collide with another job's number). A payment's place among the instalment's payments, in the order recorded, fixes its number, so a retry lands on the same document. A receipt stores the payment's own net, VAT and gross (the instalment's VAT share of the amount, cumulative, so part payments add up exactly). A 100th payment on one invoice cannot have a receipt.
- Saving an invoice or receipt draft from a job (`saveFollowOnWith`) is ONE transaction on the service connection: document, first version, current-version pointer and the payment's receipt link. A failure rolls everything back, so a number is never burnt. Saving again is safe and repairs: a document with that number but no version gets its version, and an unlinked payment gets linked, but only when the receipt on record was made for that same payment; otherwise the save is refused.
- Phase 1 has no void. A correction to an invoice or receipt is a new version of the same numbered document (as for a revised quote), never a new number, so nothing re-raises a number that was already used.
- Quote numbers may not end in `-D`, `-B`, `-S{digits}` or `-P{digits}`, and may not start with `INV-`, `RCP-`, `GC-` or `SR-`, because document numbers are built from them and two jobs could otherwise produce the same number. Enforced in the app (save and number check) and by the database (`jobs_reference_not_document_like`, migration 011). With that rule no two jobs can share an invoice or receipt number; a test generates related references to check it. The quote number suggestion ignores `INV-` and `RCP-` entries in the registry.
- "Today" for payments, the date picker and drafts is the UK date (Europe/London), not UTC. The 008 comment saying only the receipt link may change a payment is superseded by 009: amount, date, method and note stay editable by the server until a receipt is finalised; `created_by` may become null (user deleted) and nothing else may change with it.
