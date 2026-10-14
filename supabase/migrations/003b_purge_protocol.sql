-- 003b_purge_protocol: replaces the 003 purge functions with a protocol tied to the exact set
-- of customers whose files were deleted. Service role only.
--
-- PROTOCOL (the scheduled job must run ALL of this in ONE transaction):
--   1. begin
--   2. private.claim_expired_customers(now())      -- locks the expired customer rows (for update)
--   3. private.expired_storage_paths(claimed ids)  -- every stored file belonging to those customers
--   4. delete those storage objects                -- abort and roll back on ANY storage failure
--   5. private.purge_customers(claimed ids, now()) -- deletes only those ids, and only if still expired
--   6. commit
-- The row locks taken in step 2 last until commit, so the touch triggers, the owner's
-- "keep another 30 days" update and new job inserts for those customers wait instead of racing
-- the delete. purge_customers re-checks purge_at, so a customer that was touched is never deleted.
-- The job connection must have NO request.jwt.claims set (run `reset role` and clear the setting
-- first). If a session-level request.jwt.claims claiming the authenticated role leaks onto the job
-- connection, the final-version delete guard refuses the purge: it fails closed, nothing is deleted.
-- purge_log gets one row on every purge_customers call, including runs that delete nothing, so the
-- log doubles as a heartbeat showing that the job ran.

drop function private.purge_expired_customers(timestamptz);
drop function private.expired_customers(timestamptz);
drop function private.customer_storage_paths(uuid[]);

create function private.claim_expired_customers(p_now timestamptz default now())
returns table (id uuid, tenant_id uuid)
language sql security definer set search_path = '' as $$
  select c.id, c.tenant_id from public.customers c where c.purge_at < least(p_now, now()) for update
$$;

create function private.expired_storage_paths(p_customer_ids uuid[])
returns setof text
language sql stable security definer set search_path = '' as $$
  select d.pdf_path from public.documents d
    join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
    join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
    where c.id = any (p_customer_ids) and c.purge_at < now() and d.pdf_path is not null
  union
  select v.pdf_path from public.document_versions v
    join public.documents d on d.id = v.document_id and d.tenant_id = v.tenant_id
    join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
    join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
    where c.id = any (p_customer_ids) and c.purge_at < now() and v.pdf_path is not null
  union
  select p.storage_path from public.job_photos p
    join public.jobs j on j.id = p.job_id and j.tenant_id = p.tenant_id
    join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
    where c.id = any (p_customer_ids) and c.purge_at < now()
$$;

create function private.purge_customers(p_ids uuid[], p_now timestamptz default now())
returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare deleted uuid[]; prior text;
begin
  -- A function-level SET clause for this setting is refused on the hosted database, so set it
  -- for the transaction here and restore the previous value before returning.
  prior := coalesce(current_setting('app.allow_final_delete', true), '');
  perform set_config('app.allow_final_delete', 'on', true);
  with d as (
    delete from public.customers where id = any (p_ids) and purge_at < least(p_now, now()) returning id
  ) select coalesce(array_agg(id), '{}'::uuid[]) into deleted from d;
  insert into public.purge_log (customers_purged) values (cardinality(deleted));
  perform set_config('app.allow_final_delete', prior, true);
  return deleted;
end $$;

create or replace function private.erase_customer(p_tenant uuid, p_customer uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; prior text;
begin
  prior := coalesce(current_setting('app.allow_final_delete', true), '');
  perform set_config('app.allow_final_delete', 'on', true);
  with d as (delete from public.customers where id = p_customer and tenant_id = p_tenant returning 1) select count(*) into n from d;
  perform set_config('app.allow_final_delete', prior, true);
  return n;
end $$;

-- For owner-requested erasure: list the files first, delete them, then call erase_customer, all in one transaction.
create function private.customer_storage_paths(p_tenant uuid, p_customer uuid)
returns setof text
language sql stable security definer set search_path = '' as $$
  select d.pdf_path from public.documents d
    join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
    join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
    where c.id = p_customer and c.tenant_id = p_tenant and d.tenant_id = p_tenant and d.pdf_path is not null
  union
  select v.pdf_path from public.document_versions v
    join public.documents d on d.id = v.document_id and d.tenant_id = v.tenant_id
    join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
    join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
    where c.id = p_customer and c.tenant_id = p_tenant and v.tenant_id = p_tenant and v.pdf_path is not null
  union
  select p.storage_path from public.job_photos p
    join public.jobs j on j.id = p.job_id and j.tenant_id = p.tenant_id
    join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
    where c.id = p_customer and c.tenant_id = p_tenant and p.tenant_id = p_tenant
$$;

create or replace function private.purge_old_login_attempts(p_older_than interval default interval '30 days')
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with d as (
    delete from public.login_attempts where at < now() - greatest(p_older_than, interval '1 day') returning 1
  ) select count(*) into n from d;
  return n;
end $$;

revoke all on function private.claim_expired_customers(timestamptz) from public, anon, authenticated;
revoke all on function private.expired_storage_paths(uuid[]) from public, anon, authenticated;
revoke all on function private.purge_customers(uuid[], timestamptz) from public, anon, authenticated;
revoke all on function private.erase_customer(uuid, uuid) from public, anon, authenticated;
revoke all on function private.customer_storage_paths(uuid, uuid) from public, anon, authenticated;
revoke all on function private.purge_old_login_attempts(interval) from public, anon, authenticated;
grant execute on function private.claim_expired_customers(timestamptz) to service_role;
grant execute on function private.expired_storage_paths(uuid[]) to service_role;
grant execute on function private.purge_customers(uuid[], timestamptz) to service_role;
grant execute on function private.erase_customer(uuid, uuid) to service_role;
grant execute on function private.customer_storage_paths(uuid, uuid) to service_role;
grant execute on function private.purge_old_login_attempts(interval) to service_role;
