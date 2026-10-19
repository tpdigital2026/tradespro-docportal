# TradesPro DocPortal

Branded trade paperwork from a short form. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the build plans.

## Scripts

- `npm test` runs fast unit tests.
- `npm run test:render` runs the Chromium rendering tests twice, once on each render engine (`test:render:playwright`, `test:render:puppeteer`). It needs Chrome and the reference zip extracted to `reference/` (see below).
- `npm run check:render-bundle` runs `next build` and fails unless every rendering route's trace carries the serverless Chromium, the fonts, the document stylesheet and the brand files (`--no-build` checks an existing `.next`).
- `npm run ci` runs typecheck, unit tests, both render runs, the bundle check and `npm audit`.
- `npm run spike` renders the quotation to `out/`.
- Scope wording evaluation (real model, never in CI or `npm test`): `npx tsx --conditions=react-server --env-file=.env.local scripts/eval-scope-ai.ts --label r1 [--only 1,4]`. It runs twelve made-up rough scopes through the prompt (`src/ai/prompts/scope-copy.v2.ts`) and the business voice (`src/ai/voices/`), applies the live checks, and writes `out/eval-scope-ai/report-<label>.md`. Every model call is counted in `out/eval-scope-ai/ledger.json` and the script stops at `EVAL_MAX_CALLS` (default 60) in total. The key is read from the environment only and is never printed.

### Scope wording (AI)

The owner's steps go to the model with the business's voice (versioned tenant data in `src/ai/voices/`: its section headings, its own vetted one-tap bullets as style references, made-up worked examples). An answer is thrown away for the basic tidy unless it passes every check in `src/ai/scope-copy.ts`: the invention check (`src/ai/invention.ts`, unchanged), figures and names kept in the owner's form and no added work (`src/ai/facts.ts`), groups and headings (the business's own headings only, and only when their trade words are in the steps), at most two bullets per step. "Please check" questions may name a part, never a figure, brand or claim. "Things you could add" (`src/ai/suggestions.ts`) are worked out without the model from the business's checklist and the job type's usual steps; they are questions only and never part of the wording.

## Rendering on Vercel

Documents are drawn by a headless Chromium. Two engines sit behind one small interface (`src/pdf/engine.ts`: `RenderBrowser`, `RenderPage`), chosen by the environment:

| Where | Engine | Browser |
|---|---|---|
| Vercel (`VERCEL` set) or `RENDER_RUNTIME=serverless` | puppeteer-core | `@sparticuz/chromium` (Linux x64), launched in `src/pdf/serverless-chromium.ts` |
| Local, default | playwright-core | Chrome at `CHROMIUM_PATH`, else `/Applications/Google Chrome.app/...` |
| Local, `RENDER_ENGINE=puppeteer` | puppeteer-core | the same local Chrome |

Why two: playwright-core supports only its own Chromium build (1.64 drives Chromium 156), while `@sparticuz/chromium` is built for puppeteer-core with the matching Chrome major. The pair is pinned exactly: `@sparticuz/chromium` 153.0.0 and `puppeteer-core` 25.11.0 (Chrome 153.0.8010.36, see `node_modules/puppeteer-core/lib/puppeteer/revisions.js`). Bump them together, to a puppeteer-core whose Chrome major equals the new `@sparticuz/chromium` major, then run `npm run ci`.

Required settings:

- Nothing to set for the renderer itself. Do not set `CHROMIUM_PATH`, `RENDER_ENGINE`, `RENDER_RUNTIME`, `FONTCONFIG_PATH` or `LD_LIBRARY_PATH` in the Vercel project: `@sparticuz/chromium` sets the last two itself on import, and a value in the project would override it.
- Node.js 22.x or 24.x (Project Settings, Build and Deployment). puppeteer-core 25 needs Node 22.12 or later, and `@sparticuz/chromium` only adds the Amazon Linux 2023 libraries on Node 20 or later.
- Memory: at least 2 GB (the Standard function size on Pro is 2 GB, 1 vCPU; Performance, 4 GB and 2 vCPU, makes cold starts faster). Set it under Project Settings, Functions. `@sparticuz/chromium` recommends 1600 MB or more.
- Duration: the rendering routes declare `maxDuration = 60` (preview page, finalise, signature). A cold start inflates about 70 MB of Chromium into `/tmp` before the first launch; later requests on a warm instance skip that.
- The page also needs the usual real-mode secrets (`SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `BANK_ENCRYPTION_KEY` for invoices). A missing one shows the same "We could not draw the pages just now" page, logged with `"stage":"prepare"`.

Bundle: `next.config.ts` keeps `@sparticuz/chromium`, `puppeteer-core` and `playwright-core` external and adds `node_modules/@sparticuz/chromium/bin/**`, the fonts, `src/themes/fjc/base.css` and `public/brands/**` to every rendering route with `outputFileTracingIncludes`. Those files are read by path at run time, so the tracer cannot find them alone. `npm run check:render-bundle` proves they are in `.next/server/**/*.nft.json`; without the Chromium entry the deployed error is `The input directory ".../@sparticuz/chromium/bin" does not exist`.

Reading the logs (Vercel, Project, Logs, filter on `[render]`). Every failed render writes one line, with no document content:

```
[render] {"event":"render_failed","where":"preview","stage":"extract","engine":"puppeteer","runtime":"serverless","error":"Error","detail":"The input directory ... does not exist ..."}
```

- `where`: `preview`, `finalise` or `signature`.
- `stage`: `extract` (inflating Chromium into /tmp: missing bin files or a full /tmp), `launch` (the browser process did not start: a missing shared library or a version mismatch; `detail` carries the launch message), `page` (opening a page or setting the network lock), `layout` (loading the document, fonts, print media), `check` (the overflow guard refused the layout: a content problem, not a deployment one), `pdf`, `screenshot`, `decode` (signature picture), `upload` (storage), `prepare` (anything before the renderer: database, settings, a missing secret).
- `error` and `code` are the error's class name and code. A message is logged only for `extract` and `launch`, which run before any document exists.

On serverless a successful render also writes `[render] {"event":"render_ok","where":"document","engine":"puppeteer","cold":true,"ms":{"launch":...,"build":...,"pdf":...,"screenshot":...},"pages":3}`, so a slow cold start is visible. Set `RENDER_DEBUG=1` to see it locally.

Testing on a preview deployment: push the branch, open the Vercel preview URL, sign in, open a draft and choose Preview and finalise. The first visit after a deploy is a cold start (allow 10 to 20 seconds). Then check the function logs for the `render_ok` line, or the `render_failed` line and its stage. Try a second preview straight away to see the warm timing, and upload a signature picture in Settings to exercise the `signature` route.

Within one function instance renders run one at a time on serverless (Chromium runs with `--single-process` there, so one crashed page would take the browser down for every render in flight). A browser that has died is relaunched on the next request, and a render whose browser died mid-way is retried once on a fresh browser.

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

5. Separately, in the same maintenance run: `select private.purge_unlinked_appointments(now())` (service role, migration 031). It deletes appointments with no customer once the latest of their `created_at`, `updated_at` and own end (or start) is older than the business's `retention_days`. It touches no files and returns the number deleted. It is not scheduled yet: add it to the maintenance cron alongside the customer purge.

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

Appointments linked to the customer (directly or through one of their jobs) are locked by the claim and erased by the same cascade; they hold no files. Appointments with no customer are not reached by an erasure: they are removed by `private.purge_unlinked_appointments` (purge job protocol, step 5).

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
- Guarantee certificates (migration 050, `src/lib/guarantee/*`, `src/lib/data/guarantees.ts`): numbered `GC-{q}` for the first on a job and `GC-{q}-G2` to `-G20` for later ones. A job has at most one certificate per roof type, enforced by `private.guarantee_one_per_roof` on the version's `input.guarantee.roofKey` (roofs outside the list are keyed by their words). Quote numbers may therefore not end in `-G{digits}` either. The completion date is typed by the owner (no default, never in the future, checked again at preview and finalise); the issue date is never typed: `documents.doc_date` is today (London) when the draft is made and is set again to today when it is finalised. The certificate wording is `tenant_defaults.terms.guarantee`. A finalised certificate cannot be changed (there is no void in Phase 1).
- Quote numbers may not end in `-D`, `-B`, `-S{digits}`, `-P{digits}` or `-G{digits}`, and may not start with `INV-`, `RCP-`, `GC-` or `SR-`, because document numbers are built from them and two jobs could otherwise produce the same number. Enforced in the app (save and number check) and by the database (`jobs_reference_not_document_like`, migration 011). With that rule no two jobs can share an invoice or receipt number; a test generates related references to check it. The quote number suggestion ignores `INV-` and `RCP-` entries in the registry.
- "Today" for payments, the date picker and drafts is the UK date (Europe/London), not UTC. The 008 comment saying only the receipt link may change a payment is superseded by 009: amount, date, method and note stay editable by the server until a receipt is finalised; `created_by` may become null (user deleted) and nothing else may change with it.

### Survey reports (migrations 020 to 022)

- A survey report is a document on a job, numbered `SR-{job number}` (a trigger checks it; one per job). Job numbers may never start with `SR-` (013), so a survey number never equals a quote number. A survey can start a job: the first save creates the customer if new, the job and the report in ONE transaction on the service connection (`saveSurveyWith`, `src/lib/data/surveys.ts`). "Create quote from this survey" starts the quote on the same job, from the FINALISED version (never a correction still in draft).
- A correction to an issued report is a new version (`reviseWith`, "Correct this report"): every approval is taken off, so each finding and the opinion are approved, read and ticked again. The issued version never changes.
- The kind of report and its fixed wording are tenant data (`tenant_defaults.terms.survey`, `surveyWordingSchema`), never code. Without it a survey cannot be finalised. FJC's is seeded from its own report (`npm run db:seed` fills it in where missing).
- Photos, upload route `POST /api/surveys/{id}/photos?finding=f-...`, in this order: signed in and same origin; a `Content-Length` is required (411) and capped at 8 MB plus 64 KB of form wrapping (413); 60 uploads per person per 10 minutes (429, counted in the route before any work); the survey, its job and the finding must exist in this business with room, before the body is read; the body is read with a hard byte cap (`src/lib/survey/read-capped.ts`, never an unbounded `formData()`; a body longer than its declared length is refused). Room means: 4 photos on the finding and 60 shown by the report's findings, and a hard cap on stored rows checked again under the document lock: at most 120 photos for the job in all, and fewer than 4 that no finding shows (uploads still being added, or left behind; the form lists them under "Photos not in a finding" with Remove). Then `src/lib/survey/images.ts`: at most two decodes at once per server process; first bytes must be JPEG, PNG or WebP; the header must agree; at most 36 megapixels (refused from the header, before decoding); ONE streamed decode turns the image upright, shrinks it to 2000 pixels and writes a fresh JPEG with no EXIF, GPS, XMP or comments.
- Body sizes: the proxy in front of every route (`src/proxy.ts`) has Next buffer at most 10 MB of a request body (Next's default `proxyClientMaxBodySize`); a longer body would reach the route cut short. The photo route's cap (8 MB plus wrapping) stays under that on purpose, and the browser's shrunk photos are 1 to 3 MB. On Vercel the platform's own request limit (4.5 MB) is lower still. Raise any of these together, never one alone.
- The browser offers JPEG, PNG and WebP only (`accept`, so iOS converts HEIC to JPEG; the camera button keeps `capture="environment"`) and shrinks the photo first. A photo it cannot decode is never sent: the owner is told to take it again with the camera button or choose a JPEG.
- Storage: private `documents` bucket at `{tenant}/{customer}/{job}/{photo}.jpg`. The database checks the shape and that every part is the row's own tenant, customer (via its job), job and photo id (022). The `job_photos` row is written first, then the file; the row is deleted if the upload fails. Deleting a photo removes the row first and the file after the commit (a failed file delete is left to the storage orphan sweep, which is still to build). A photo still shown by the draft, or by any finalised version, is not deleted. Reads go only through `/api/surveys/photos/{id}` (session and tenant checked, `Cache-Control: private, no-store`). Photos belong to the customer: erasure and the purge list `job_photos.storage_path` and delete the customer folder.
- AI: `draftFinding({ photos, ownerLine })` and `draftOpinion` (`src/ai/survey-finding.ts`, prompts `src/ai/prompts/survey-*.v1.ts`). Photos go to the model only when `ANTHROPIC_API_KEY` is set, server side, as smaller copies, and are never logged or kept. Replies are checked by `src/ai/finding-check.ts` (no numbers, units, claims, names, causes, standards or costs the owner did not give; a material seen in a photo is allowed only if it is also listed under "Please check"). The opinion is drafted only from findings whose approval is on record in the audit log. Without the key, or when a draft fails the check, the owner's line goes into the observation word for word and the assessment is left for the owner.
- Approval: every finding and the professional opinion are approved on the server only (`approveSurveyPartWith`): time and fingerprint (`findingHash`; `opinionHash` covers the opinion, remedial line, signer, prepared-by and signing date) are set there, saved with the draft and written to the audit log (`survey.approve`, the user id, and in meta the part, the role and the fingerprint, never words) in the same transaction. Saves keep an approval only while the content still matches the stored fingerprint. Finalise refuses unless every fingerprint has its audit row, and for the opinion: the draft names the signer's user id (`opinionSignerId`, set by the server with the approval), the audit row for that fingerprint has that user id, the person's profile is still active, and its name (tidied as on save) is the name that signs and prepares the report.
- Signer: "Prepared by" and the signature are never free text. Every save sets both to the signed-in person's profile `full_name`; an approval sent in anyone else's name is refused. The signature is that name and a date; a stored signature image is not used until a consent setting exists.

### Business tabs: Pipeline, Money, Calendar, Guarantees (migration 030)

- Every figure is a sum of recorded facts, read on a service connection with the session's tenant in every query (`src/lib/data/business.ts`): the issued quote version's stored `money` (gross and schedule), the stored `total_pence` of issued invoices, and recorded payments. Nothing is recomputed, estimated or forecast. A quote finalised without a stored schedule shows a plain "cannot be worked out" note instead of a stage.
- Due dates are read only from the due wording printed on each issued invoice, and only when counted from the invoice ("due upon receipt", "within 14 days", "14 days from the invoice date"). Days counted from anything else ("of completion", "after the due date") give no due date and show "Check the due date on this invoice"; wording such as "Before works start" has no calendar date. Overdue compares Europe/London dates. A job's outstanding is the sum of each invoice's own outstanding, so an overpaid invoice never hides an unpaid one. Calendar files carry SEQUENCE (from `updated_at`) so an edited appointment replaces the old copy when imported again.
- The Money CSV export (`/api/money/export`) is the rows on screen; every cell is quoted and a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading single quote.
- `appointments`: tenant scoped, row level security forced, composite foreign keys to customers and jobs (a job fills in its customer and may not name another), column grants for what the owner types. Erased with the customer and locked in `private.lock_customer_tree`. Booking or moving an appointment extends the customer's retention to at least the retention period after the appointment itself (migration 031), so a customer is never purged before a booked visit. Appointments with no customer are removed by `private.purge_unlinked_appointments` (see the purge protocol, step 5); the form tells the owner both rules.
- Calendar files (`/api/calendar/ics`) are RFC 5545 with UTC times, escaped text and folded lines, carrying only the title and the notes the owner typed. No reminders or notifications.
- `pipeline`, `money`, `calendar` and `guarantees` are reserved sign-in words (app and database check).
