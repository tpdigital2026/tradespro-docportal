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

-- Login attempt rows only matter for the 15 minute lock window; keep 30 days then delete.
create function private.purge_old_login_attempts(p_older_than interval default interval '30 days')
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with d as (delete from public.login_attempts where at < now() - p_older_than returning 1) select count(*) into n from d;
  return n;
end $$;

revoke all on function private.expired_customers(timestamptz) from public, anon, authenticated;
revoke all on function private.customer_storage_paths(uuid[]) from public, anon, authenticated;
revoke all on function private.purge_expired_customers(timestamptz) from public, anon, authenticated;
revoke all on function private.erase_customer(uuid, uuid) from public, anon, authenticated;
revoke all on function private.purge_old_login_attempts(interval) from public, anon, authenticated;
grant execute on function private.expired_customers(timestamptz) to service_role;
grant execute on function private.customer_storage_paths(uuid[]) to service_role;
grant execute on function private.purge_expired_customers(timestamptz) to service_role;
grant execute on function private.erase_customer(uuid, uuid) to service_role;
grant execute on function private.purge_old_login_attempts(interval) to service_role;
