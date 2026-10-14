-- 002_security: tenant-leading indexes, private helpers, grants, row level security, integrity triggers.

-- Tenant-leading indexes for the composite foreign keys and the row level security filters.
create index document_versions_tenant_idx on public.document_versions (tenant_id, document_id);
create index job_photos_tenant_idx on public.job_photos (tenant_id, job_id);
create index share_links_tenant_idx on public.share_links (tenant_id, document_id);
create index document_emails_tenant_idx on public.document_emails (tenant_id, document_id);
create index ai_runs_tenant_idx on public.ai_runs (tenant_id, document_id);
create index brand_assets_tenant_idx on public.brand_assets (tenant_id, brand_kit_id);
create index documents_tenant_job_idx on public.documents (tenant_id, job_id);
create index jobs_tenant_customer_idx on public.jobs (tenant_id, customer_id);

-- Functions created by this role are not executable by PUBLIC unless granted explicitly.
alter default privileges revoke execute on functions from public;

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

-- Start from nothing: no table privileges for anon or the signed-in role, now or for new objects.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
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

-- Quote numbers: read, and claimed by the jobs trigger running as the signed-in user. The insert
-- policy is what stops a forged insert into another business, and it is checked before the unique
-- index, so the "already used" error never reveals another business's numbers.
create policy tenant_select on public.used_numbers for select to authenticated using (tenant_id = (select private.current_tenant_id()));
create policy tenant_insert on public.used_numbers for insert to authenticated with check (tenant_id = (select private.current_tenant_id()));
grant select on public.used_numbers to authenticated;
grant insert (tenant_id, number) on public.used_numbers to authenticated;

-- The business itself: read own, owners edit the business details (never id or created_at).
create policy tenant_select on public.tenants for select to authenticated using (id = (select private.current_tenant_id()));
create policy owner_update on public.tenants for update to authenticated
  using (id = (select private.current_tenant_id()) and (select private.is_owner()))
  with check (id = (select private.current_tenant_id()) and (select private.is_owner()));
grant select on public.tenants to authenticated;
grant update (name, trade_type, company_number, vat_registered, vat_number, address_lines, postcode, phone, email, website, tagline, owner_name, owner_title)
  on public.tenants to authenticated;

-- People in the same business. Read only; disabled_at is never shown.
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

-- login_attempts, purge_log and _migrations: row level security on, no policies, no grants. Server only.

-- A restrictive guard on top of every policy: disabled or unknown users get nothing.
do $$
declare t text;
begin
  foreach t in array array['tenants','profiles','brand_kits','brand_assets','job_types','bank_accounts','tenant_defaults','customers','jobs','used_numbers','documents','document_versions','job_photos','share_links','document_emails','ai_runs','audit_log'] loop
    execute format('create policy active_profile_only on public.%I as restrictive for all to authenticated using ((select private.current_tenant_id()) is not null) with check ((select private.current_tenant_id()) is not null)', t);
  end loop;
end $$;

-- Finalised versions never change and are only deleted by the purge (which sets app.allow_final_delete).
-- Any role can set that setting, so this guard relies on the app role having no delete privilege on
-- document_versions or on any table that cascades into it.
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

-- A quote number is claimed once, forever, and never changes. Runs as the caller (not security
-- definer) so that the used_numbers insert policy applies to the signed-in user.
create function private.claim_job_number() returns trigger
language plpgsql set search_path = '' as $$
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

-- Any activity on a customer pushes their 30-day purge date out. Security definer because the purge
-- columns are server-maintained; the triggering row has already passed its own row level security.
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

-- Function privileges: nothing in private is callable except the two helpers, and only by the signed-in and server roles.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_tenant_id() to authenticated, service_role;
grant execute on function private.is_owner() to authenticated, service_role;
