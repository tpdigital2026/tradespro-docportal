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
- Sessions end 30 days after the email code was entered: the app enforces this itself with a signed login-time cookie that token refreshes never renew. Also set Supabase's "time-box user sessions" to 30 days as a second cap.
- Required environment variables: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `LOGIN_PEPPER` (32+ characters) and `SESSION_SECRET` (32+ characters, signs the login-time cookie). With any missing, both login routes answer a generic "try again shortly", no code is emailed and nobody can sign in.

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

Customer data is removed once a customer's `purge_at` passes. `purge_at` is last activity plus the business's `tenant_defaults.retention_days` (30 to 730, default 90; set by migration 004, existing dates are only ever extended, never shortened). The scheduled job runs the whole protocol in ONE transaction, on a service connection with no `request.jwt.claims` (a leaked claim makes the final-version guard refuse the purge, which fails closed), with a generous `statement_timeout`:

1. `private.claim_expired_customers` locks the expired customers and everything under them.
2. `private.expired_storage_paths` lists their files.
3. Delete those files from storage.
4. `private.purge_customers` deletes the claimed customers and writes a `purge_log` row (a zero-count run is a heartbeat).

Residual risk: if the connection drops after the files are deleted, the customer stays expired and is purged on the next run. A write in that gap can leave a kept customer pointing at deleted files. A single transaction and a long statement timeout keep this window small.

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

- Uploads: insert the database row first, then upload the file, and delete the row (and any partial file) if the upload fails. A storage orphan sweep (files with no row) is still needed and is not built yet.
- Bank accounts: the app role can only read the safe columns; every write goes through the server on the service role. The server must check `role = owner` AND a fresh step-up before any bank write. The database does not check the owner role on these writes because the app role has no write grant at all.
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

### Survey reports (migrations 020 and 021)

- A survey report is a document on a job, numbered `SR-{job number}` (a trigger checks it; one per job; a correction is a new version). Job numbers may never start with `SR-` (013), so a survey number never equals a quote number. A survey can start a job: the first save creates the customer if new, the job and the report in ONE transaction on the service connection (`saveSurveyWith`, `src/lib/data/surveys.ts`). "Create quote from this survey" starts the quote on the same job.
- The kind of report and its fixed wording are tenant data (`tenant_defaults.terms.survey`, `surveyWordingSchema`), never code. Without it a survey cannot be finalised. FJC's is seeded from its own report (`npm run db:seed` fills it in where missing).
- Photos: the server checks the first bytes (JPEG, PNG, WebP only), refuses anything over 12 MB or 100 megapixels, turns the image upright, shrinks it to 2000 pixels and re-encodes it as a fresh JPEG with no EXIF, GPS, XMP or comments (`src/lib/survey/images.ts`). The browser shrinks first, to save upload time, but is never trusted. Stored in the private `documents` bucket at `{tenant}/{customer}/{job}/{photo}.jpg`; the `job_photos` row is written first, then the file, and the row is deleted if the upload fails. Photos are read only through `/api/surveys/photos/{id}` after the session and tenant checks. Up to 4 per finding and 60 per survey. They belong to the customer: erasure and the purge already list `job_photos.storage_path` and delete the customer folder.
- AI: `draftFinding({ photos, ownerLine })` and `draftOpinion` (`src/ai/survey-finding.ts`, prompts `src/ai/prompts/survey-*.v1.ts`). Photos go to the model only when `ANTHROPIC_API_KEY` is set, server side, as smaller copies, and are never logged or kept. Replies are checked by `src/ai/finding-check.ts` (no numbers, units, claims, names, causes, standards or costs the owner did not give; a material seen in a photo is allowed only if it is also listed under "Please check"). Without the key, or when a draft fails the check, the owner's line goes into the observation word for word and the assessment is left for the owner.
- Approval: every finding and the professional opinion are approved on the server only (`approveSurveyPartWith`): time and fingerprint (`findingHash`, `opinionHash`) are set there, saved with the draft and written to the audit log (`survey.approve`, document id, part and fingerprint, never words) in the same transaction. Saves keep an approval only while the content still matches the stored fingerprint. Finalise refuses unless every fingerprint has its audit row (`surveyApprovalProblemsWith`).
- The signature is the typed name and a date. A stored signature image is not used until a consent setting exists.
