-- 002b_column_grants: column-level write grants, storage path checks, oracle-free version uniqueness,
-- version edits reset the purge clock, and app-role hardening of the integrity triggers.

-- The app role is detected inline in each trigger (no helper, so nothing extra is executable by the
-- app role): a session running as authenticated, or a JWT whose role claim is authenticated. These
-- trigger functions are not security definer, so current_user is the caller.

-- 1. Server-owned columns: replace table-level insert/update with column-level grants.
revoke insert, update on public.customers, public.jobs, public.documents, public.document_versions,
  public.job_photos, public.share_links, public.document_emails from authenticated;

grant insert (tenant_id, name, address_lines, postcode, email, phone) on public.customers to authenticated;
grant update (name, address_lines, postcode, email, phone) on public.customers to authenticated;

grant insert (tenant_id, customer_id, reference, property_address, job_type_id, status) on public.jobs to authenticated;
grant update (property_address, job_type_id, status) on public.jobs to authenticated;
alter table public.jobs alter column created_by set default auth.uid();

grant insert (tenant_id, job_id, type, number, doc_date) on public.documents to authenticated;
grant update (doc_date, current_version_id) on public.documents to authenticated;
alter table public.documents alter column created_by set default auth.uid();

grant insert (tenant_id, document_id, version, input, final_content, bank_account_id) on public.document_versions to authenticated;
grant update (input, final_content, bank_account_id) on public.document_versions to authenticated;
alter table public.document_versions alter column created_by set default auth.uid();

-- Photos are inserted by the server after EXIF strip and resize.
grant update (finding_ref) on public.job_photos to authenticated;

grant insert (tenant_id, document_id, token_hash, expires_at) on public.share_links to authenticated;
grant update (revoked_at) on public.share_links to authenticated;
alter table public.share_links add constraint share_links_max_30_days check (expires_at <= created_at + interval '30 days');

grant insert (tenant_id, document_id, to_email, subject, body) on public.document_emails to authenticated;
grant update (to_email, subject, body) on public.document_emails to authenticated;

-- Once a document leaves draft, the app role cannot change it; the server still can.
create function private.document_locked_after_draft() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'draft' and (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated') then
    raise exception 'Only a draft document can be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger documents_locked_after_draft before update on public.documents
  for each row execute function private.document_locked_after_draft();

-- A revoked share link stays revoked, for everyone.
create function private.share_link_no_unrevoke() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revoked share link cannot be reinstated' using errcode = '23000';
  end if;
  return new;
end $$;
create trigger share_links_no_unrevoke before update on public.share_links
  for each row execute function private.share_link_no_unrevoke();

-- 2. Storage paths live inside the tenant's own prefix and never climb out of it.
alter table public.job_photos add constraint job_photos_path_in_tenant
  check (storage_path like tenant_id::text || '/%' and storage_path not like '%..%');
alter table public.brand_assets add constraint brand_assets_path_in_tenant
  check (storage_path like tenant_id::text || '/%' and storage_path not like '%..%');
alter table public.documents add constraint documents_pdf_path_in_tenant
  check (pdf_path is null or (pdf_path like tenant_id::text || '/%' and pdf_path not like '%..%'));
alter table public.document_versions add constraint document_versions_pdf_path_in_tenant
  check (pdf_path is null or (pdf_path like tenant_id::text || '/%' and pdf_path not like '%..%'));

-- 3. Version uniqueness scoped by tenant, so a duplicate-key error cannot confirm another tenant's document id.
alter table public.document_versions drop constraint document_versions_document_id_version_key;
alter table public.document_versions add constraint document_versions_tenant_document_version_key unique (tenant_id, document_id, version);

-- 4. Editing a version is activity on the customer: push the purge date out.
create function private.touch_customer_from_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(), purge_at = now() + interval '30 days'
  from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
  where d.id = new.document_id and d.tenant_id = new.tenant_id and c.id = j.customer_id and c.tenant_id = j.tenant_id;
  return new;
end $$;
create trigger document_versions_touch_customer after insert or update on public.document_versions
  for each row execute function private.touch_customer_from_version();

-- Cheap extras.
alter table public.used_numbers add constraint used_numbers_number_length check (length(number) between 1 and 40);

-- The purge override never counts for the app role, even if it sets app.allow_final_delete itself.
create or replace function private.block_final_version_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.finalised_at is not null then
    raise exception 'A finalised document version cannot be changed' using errcode = '23000';
  end if;
  if tg_op = 'DELETE' then
    if old.finalised_at is not null
       and (coalesce(current_setting('app.allow_final_delete', true), '') <> 'on' or (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated')) then
      raise exception 'A finalised document version cannot be deleted' using errcode = '23000';
    end if;
    return old;
  end if;
  return new;
end $$;

-- Nothing new in private is callable by anyone but the owner (the helpers keep their grants from 002).
revoke all on function private.document_locked_after_draft() from public, anon, authenticated;
revoke all on function private.share_link_no_unrevoke() from public, anon, authenticated;
revoke all on function private.touch_customer_from_version() from public, anon, authenticated;
