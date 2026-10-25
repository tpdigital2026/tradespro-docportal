# Setting this project up on a new computer

Everything in the code is on GitHub (repository `tradespro-docportal`, branch `feature/owner-app`). A few things are
deliberately NOT on GitHub because they are private. This page says where each one lives.

## 1. Get the code
1. Install GitHub Desktop and sign in as `tpdigital2026`.
2. File, Clone repository, choose `tradespro-docportal`, branch `feature/owner-app`.
3. In the folder, run `npm install`.

## 2. Secrets (never in GitHub)
Copy `.env.example` to `.env.local` and fill in each name. The real values live in these places:

| Name | Where to find it |
|---|---|
| NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase project `obpqespuupybvoldjaio`, Settings, API |
| SUPABASE_SERVICE_ROLE_KEY | Supabase, Settings, API (secret key) |
| DATABASE_URL | Supabase, Settings, Database, connection string (pooler) |
| BANK_ENCRYPTION_KEY, LOGIN_PEPPER, SESSION_SECRET, CRON_SECRET | Vercel project `tradespro-docportal`, Settings, Environment Variables, and the password manager. BANK_ENCRYPTION_KEY must never change once bank details are saved. |
| ANTHROPIC_API_KEY | console.anthropic.com, API keys (make a new one if the old one is lost) |
| RESEND_API_KEY | resend.com, API keys (production sends from login@tradesprodigital.io) |

Production values are set in Vercel, not in a file. The live site is docs.tradesprodigital.io.

## 3. Private files kept outside GitHub
Back these up to Google Drive or an external drive, never to GitHub:
- `Ben-docs/` (Ben's real quotes, invoices, receipts, guarantees, surveys and signature). Customer data and bank details.
- `reference/` inside the project folder (the original FJC template pack). Git-ignored.
- `.superpowers/` inside the project folder (build notes, briefs, review reports). Git-ignored.
- `.env.local` (secrets): keep the values in a password manager, not in Drive.

## 4. Check it works
`npm run test`, then `npm run build`, then `npm run dev:demo` for the demo (dummy data only).
Database tests (`npm run test:db`) write to the shared Supabase project: do not run them against production data.

## 5. Branches
`feature/owner-app` is the live line of work. `main` is behind it and has not been updated since the owner app was built.
