# TradesPro DocPortal: design (Phase 1)

Status: draft for Alfie's review. Nothing in this file is built yet.

## Purpose

A secure web app where a UK trade business owner fills in a short form on their phone and gets a finished, on-brand A4 PDF: quotation, deposit invoice, balance invoice, receipt, guarantee certificate or survey report. Rough notes become professional scope-of-works wording through AI. The PDF is rendered from code-owned templates in that client's brand.

Phase 1 is a single-tenant MVP for FJC Roofing Ltd, but the data model is multi-tenant from day one.

## Confirmed decisions

### Where it lives
- Separate repo (`TradesPro DocPortal`) and separate Vercel project. The marketing site is not touched.
- Served at `docs.tradesprodigital.io`. DNS for `tradesprodigital.io` is already managed in the ClickSmart Vercel team, so adding the domain to the project configures it automatically.
- Outgoing email is independent of the web address. SPF/DKIM exist for the `tradespro.digital` sending domain; confirm which sender address and domain the app uses before Send to customer is built.
- Alfie pushes with GitHub Desktop and sets up Vercel in the browser. Claude commits locally only.
- Hosted Supabase dev project (no Docker or Homebrew on this machine). Keys go in `.env.local`, never in chat.

### Scope of Phase 1
Six document types: quotation, deposit invoice, balance invoice, receipt, guarantee certificate, survey report. Completion certificate and CIS labour invoice are deferred to Phase 3. A second and third client (Top Choice, G Scott) come in Phase 2 once their brand assets and business details exist.

### Stack
Next.js (App Router) and TypeScript, Supabase (Postgres, Auth, Storage), zod, Vitest, Playwright/Chromium for PDFs and snapshots, Anthropic API server-side only, email via Resend or Postmark on the existing domain.

### Quote number is the job key
- The owner types the quote number when creating a quote. The system suggests the next one. It must be unique per tenant.
- For follow-on documents the owner types or searches the quote number, or picks the customer. Customer, address, scope, price, deposits received and guarantee years fill from the latest final version of that quote.
- Derived numbers: `INV-{quote}-D`, `INV-{quote}-B`, `RCP-{quote}-D`, `RCP-{quote}-B`, `GC-{quote}`.
- A revised quote is a new version of the same quote number. Old versions stay in history.

### Retention
- Customer data is deleted 30 days after the customer's last activity (any document created or edited for them resets the clock).
- A daily scheduled job deletes the customer, jobs, documents, typed input, PDFs and photos.
- The owner is emailed a reminder 5 days before, with a "keep for another 30 days" action.
- The audit log and used-number registry survive. They hold no names.
- The terms state that the trader is responsible for keeping their own records. A solicitor should check that wording.

### Owner flow (mobile first)
1. Log in with their email address and a one-time code sent to it. There are no passwords.
2. New document, pick the type, select an existing customer or add one.
3. Short form: customer, date, scope notes, price ex VAT, VAT yes/no, extras, discount, guarantee years, bank account.
4. Generate. The AI drafts the wording. The owner sees a live preview and edits inline. The AI lists `corrections[]` and `uncertain[]` for review before finalising.
5. Finalise. The PDF is created and saved to the job. A Download button saves to the phone (share sheet on mobile). A ready-written covering email appears with Copy and Send to customer. Sending is never automatic.

## Architecture

- **Templates** are TypeScript functions using a tagged `html` template that escapes by default. Colours, fonts, logos and images come from the tenant's brand kit. FJC is the first theme. `docs.py` and `fjc.css` are ported faithfully, not redesigned.
- **Pagination** is a two-pass layout in Chromium. Pass one measures content. Pass two splits scope at section level, then bullet level, and fills in "Page n / total" and contents numbers. Finalise is blocked if any page still overflows.
- **PDF rendering** runs Chromium with JavaScript off and all network blocked, with bundled fonts. It starts as `@sparticuz/chromium` in a Vercel route behind a `renderPdf()` interface so it can move to a separate render service. Vercel Pro is needed for function duration. Page checks use Chromium screenshots of the HTML (not pdf.js, which renders CMYK photos incorrectly).
- **Money** is a pure `money.ts` in integer pence with unit tests. VAT is per line, half-up, then summed. A deposit is its percentage of the ex-VAT subtotal. Balance is the quote gross minus deposits and credits. The AI never calculates money.
- **AI** is Claude (model from env var), server-side only, strict JSON validated by zod with one retry. Output shape: `{ title, intro, sections[{heading, bullets[]}], spec_cards[], notes_callout?, guarantee_text?, corrections[], uncertain[] }`. It keeps the owner's meaning, fixes spelling and trade terms, and never invents work, materials, prices, guarantees or accreditations. The guarantee card and wording come from the form and defaults, never the AI. Job-type blurbs come from the job type record.
- **Bank details** are encrypted with AES-256-GCM (key in a server env var), with the last 4 digits readable. Decrypted server-side at render time only. Never logged.
- **Files** live in private buckets with short-lived signed URLs. Survey photos have EXIF stripped and are resized.
- **Share links** are our own `/s/{token}` URLs, 14 days by default, revocable. They mint a signed URL on click.
- **Auth** (decided by Alfie, 2026-10-14): invite-only, passwordless. Supabase Auth email one-time codes, with sign-up disabled. A TradesPro admin registers each person's email against one tenant (a `profiles` row); an email with no profile cannot get in. Codes are 6 digits, expire after 10 minutes and are single use. Lockout is custom: a server-side login route with a `login_attempts` table, a progressive 15 minute lock after 5 wrong codes, and a rate limit on sending codes. Sessions last at most 30 days. Compensating controls for the weaker single factor: a notification email on every login from a new device, and **step-up**: adding or changing a bank account, deleting a customer, or inviting another user requires a fresh email code within the last 10 minutes. An authenticator-app factor can be added later without changing the data model.

## Schema

```sql
user_role  : owner | staff | tradespro_admin
doc_type   : quotation | deposit_invoice | balance_invoice | receipt | guarantee | survey_report
doc_status : draft | final | sent | void
job_status : open | quoted | accepted | in_progress | complete | paid

tenants(id, name, trade_type, company_number, vat_registered, vat_number,
        address_lines text[], postcode, phone, email, website, tagline,
        owner_name, owner_title, created_at)
profiles(id = auth.users.id, tenant_id, role, full_name, created_at)

brand_kits(id, tenant_id, theme_key, colours jsonb, fonts jsonb, css_overrides)
brand_assets(id, tenant_id, brand_kit_id,
             kind: logo_colour|logo_white|signature|cover_photo|diagram|badge,
             storage_path, width, height, alt)
job_types(id, tenant_id, key, label, guarantee_years null,
          cover_asset_id, diagram_asset_id, spec_blurb)

bank_accounts(id, tenant_id, account_name, bank_name,
              sort_code_enc, account_number_enc, last4,
              is_default, archived_at)       -- one default per tenant
tenant_defaults(tenant_id, deposit_pct, quote_validity_days, vat_default,
                vat_rate_bp, terms_text, disclaimer_text, number_formats jsonb)

customers(id, tenant_id, name, address_lines text[], postcode, email, phone,
          last_activity_at, purge_at)
jobs(id, tenant_id, customer_id, reference /* owner-typed quote no., unique per tenant */,
     property_address, job_type_id, status, created_by, created_at)
used_numbers(tenant_id, number)              -- survives purge, no names
documents(id, tenant_id, job_id, type, number, doc_date, status,
          current_version_id, total_pence, balance_pence, pdf_path,
          finalised_at, sent_at, created_by)
document_versions(id, document_id, tenant_id, version,
          input jsonb, ai_output jsonb, final_content jsonb, money jsonb,
          bank_account_id, pdf_path, created_by, created_at)  -- final versions immutable
job_photos(id, tenant_id, job_id, finding_ref, storage_path, width, height)
share_links(id, tenant_id, document_id, token_hash, expires_at, revoked_at)
document_emails(id, tenant_id, document_id, to_email, subject, body, status, sent_at)
ai_runs(id, tenant_id, document_id, model, input_tokens, output_tokens, valid, created_at)
audit_log(id, tenant_id, user_id, impersonator_id, action, entity, entity_id,
          ip, user_agent, meta jsonb, at)    -- append-only, no customer names
login_attempts(id, email_hash, ip, success, at)
purge_log(id, run_at, customers_purged int)  -- counts only
```

RLS: every policy is `tenant_id = current_tenant_id()` plus a restrictive policy that the session belongs to an active `profiles` row (not disabled). Bank accounts are owner-write only, and the `*_enc` columns are revoked from the app role. `tradespro_admin` has no broad bypass; Phase 2 admin access goes through audited server routes. Service-role code always takes `tenant_id` from the verified session, never from the request. Automated tests prove tenant A cannot read tenant B.

## Data handling rules for this repo

- The reference zip (`~/Downloads/DocPortal_Reference.zip`) is not committed. Its samples and `docs.py` contain real customer details and what appear to be real bank numbers.
- Test fixtures use dummy data only: Mr John Smith, 123 Bromley Road, BR2 8BG, and bank 00-00-00 / 00000000.
- Never commit `.env*`, keys, or any client personal data.
- Nothing is invented: if a fact is missing the document shows a visible placeholder and the owner is asked.

## Build order

1. Render spike: port `fjc.css` and the quotation, then compare with the reference by eye.
2. `money.ts` and tests.
3. Schema, RLS, invite-only email-code login, lockout, step-up, and tenant isolation tests.
4. All six templates and pagination.
5. AI scope writing.
6. Form, preview, inline edit, finalise, download and email UI.
7. Seed data, README, "how to add a new client" guide, purge job.

## Open items before step 3

- Supabase hosted dev project created and keys placed in `.env.local`.
- Resend or Postmark account and API key.
- Vercel Pro (commercial use and function duration).
- Data Processing Agreement and privacy notice for clients (they become controllers, TradesPro a processor). A solicitor should review.
