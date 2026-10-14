-- 003c_purge_locks: closes the child-row races left by 003b. Service role only.
--
-- claim_expired_customers now locks, in one fixed order (customers, then jobs, then documents, each
-- ordered by id), every row a concurrent writer would have to touch to add stored files to a claimed
-- customer. Inserting a job, a document, a document version or a photo takes a KEY SHARE lock on its
-- parent row, which conflicts with FOR UPDATE, so those writes WAIT until the purge transaction ends.
--   * purge committed: the waiting write then fails its foreign key (the customer is gone).
--   * purge aborted:   the waiting write goes ahead and its touch trigger resets the 30-day clock.
-- A writer that got a lock first can deadlock with the claim; PostgreSQL aborts one of the two. If the
-- purge is the victim nothing has been deleted yet (storage deletion comes after the claim), so the
-- job simply retries on its next run.

-- Photos are customer activity too (they had no touch trigger).
create function private.touch_customer_from_photo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(), purge_at = now() + interval '30 days'
  from public.jobs j
  where j.id = new.job_id and j.tenant_id = new.tenant_id and c.id = j.customer_id and c.tenant_id = j.tenant_id;
  return new;
end $$;
create trigger job_photos_touch_customer after insert on public.job_photos
  for each row execute function private.touch_customer_from_photo();
revoke all on function private.touch_customer_from_photo() from public, anon, authenticated;

create or replace function private.claim_expired_customers(p_now timestamptz default now())
returns table (id uuid, tenant_id uuid)
language plpgsql security definer set search_path = '' as $$
declare ids uuid[];
begin
  select coalesce(array_agg(x.id), '{}'::uuid[]) into ids from (
    select c.id from public.customers c where c.purge_at < least(p_now, now()) order by c.id for update
  ) x;
  perform 1 from public.jobs j where j.customer_id = any (ids) order by j.id for update;
  perform 1 from public.documents d
    where d.job_id in (select j.id from public.jobs j where j.customer_id = any (ids)) order by d.id for update;
  return query select c.id, c.tenant_id from public.customers c where c.id = any (ids);
end $$;

-- Defence in depth: skip any customer another transaction holds locked, on top of the purge_at recheck.
-- This function is only safe as the last step of the protocol in 003b (claim, list files, delete files).
create or replace function private.purge_customers(p_ids uuid[], p_now timestamptz default now())
returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare deleted uuid[]; prior text;
begin
  prior := coalesce(current_setting('app.allow_final_delete', true), '');
  perform set_config('app.allow_final_delete', 'on', true);
  with d as (
    delete from public.customers where id in (
      select c.id from public.customers c where c.id = any (p_ids) and c.purge_at < least(p_now, now()) order by c.id for update skip locked
    ) returning id
  ) select coalesce(array_agg(id), '{}'::uuid[]) into deleted from d;
  insert into public.purge_log (customers_purged) values (cardinality(deleted));
  perform set_config('app.allow_final_delete', prior, true);
  return deleted;
end $$;
