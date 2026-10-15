-- 040_owner_settings: the owner's Settings screen (/settings).
--
-- 1. Session policy per business: sign out after N idle minutes (10 to 480, default 30) and at most M days after the
--    email code was entered (1 to 30, default 7). Enforced by the proxy and getSession (src/lib/session-policy.ts).
-- 2. Consent to print the owner's stored signature on documents (off by default). The image itself is a
--    brand_assets row of kind 'signature' whose file lives in the private documents bucket.
-- 3. These settings and retention_days change only on the server, after the owner role and a fresh emailed code are
--    checked there. The app role keeps its owner policies on tenant_defaults for the other columns, so a trigger (not a
--    grant, which would change every existing error message) refuses any app-role change to these columns, any
--    app-role delete of the row (which would reset them), and any app-role insert that is not all defaults.
--    Signature rows in brand_assets are written by the server only, for the same reason.
-- 4. 'settings' becomes a reserved word that no business can take as its sign-in address. It is a separate
--    constraint, so other migrations that add reserved words to tenants_slug_not_reserved do not undo it (and it
--    does not undo them). tests/unit/slug-reserved.test.ts reads every tenants_slug_not_reserved* constraint.
-- 5. Bank account names have a sensible length and the bank name is optional (stored as '').

alter table public.tenant_defaults
  add column idle_logout_minutes int not null default 30 check (idle_logout_minutes between 10 and 480),
  add column max_session_days int not null default 7 check (max_session_days between 1 and 30),
  add column signature_consent boolean not null default false,
  add column signature_consent_at timestamptz,
  add column signature_consent_by uuid references auth.users (id) on delete set null;

create function private.tenant_defaults_server_columns() returns trigger
language plpgsql set search_path = '' as $$
declare
  app boolean := current_user = 'authenticated'
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated';
begin
  if not app then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Business settings can only be removed by the server' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.retention_days <> 90 or new.idle_logout_minutes <> 30 or new.max_session_days <> 7
       or new.signature_consent or new.signature_consent_at is not null or new.signature_consent_by is not null then
      raise exception 'These settings can only be changed by the server' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.retention_days is distinct from old.retention_days
     or new.idle_logout_minutes is distinct from old.idle_logout_minutes
     or new.max_session_days is distinct from old.max_session_days
     or new.signature_consent is distinct from old.signature_consent
     or new.signature_consent_at is distinct from old.signature_consent_at
     or new.signature_consent_by is distinct from old.signature_consent_by then
    raise exception 'These settings can only be changed by the server' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tenant_defaults_server_columns before insert or update or delete on public.tenant_defaults
  for each row execute function private.tenant_defaults_server_columns();

create function private.signature_asset_server_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated')
     and ((tg_op <> 'INSERT' and old.kind::text = 'signature') or (tg_op <> 'DELETE' and new.kind::text = 'signature')) then
    raise exception 'A signature can only be stored by the server' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger brand_assets_signature_server_only before insert or update or delete on public.brand_assets
  for each row execute function private.signature_asset_server_only();

revoke all on function private.tenant_defaults_server_columns() from public, anon, authenticated;
revoke all on function private.signature_asset_server_only() from public, anon, authenticated;

alter table public.tenants add constraint tenants_slug_not_reserved_040
  check (slug is null or slug <> all (array['settings']));

alter table public.bank_accounts alter column bank_name set default '';
alter table public.bank_accounts add constraint bank_accounts_name_lengths
  check (char_length(account_name) between 1 and 60 and char_length(bank_name) <= 60);
