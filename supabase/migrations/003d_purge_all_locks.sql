-- 003d_purge_all_locks: the claim now locks EVERY row the purge cascade reaches. Service role only.
-- This supersedes the guarantees described in the 003c header, which said less than it should.
--
-- Lock order (always this order, each table ordered by id, FOR UPDATE):
--   customers, jobs, documents, document_versions, job_photos, share_links, document_emails, ai_runs
-- These are all the tables reached from public.customers by ON DELETE CASCADE or SET NULL chains
-- (tests/db/purge.test.ts derives the set from pg_constraint and fails if a table is added that this
-- function does not lock). Because every row the cascade will delete or update is already locked by the
-- claiming transaction, step 5 (purge_customers) acquires no new row lock, so it cannot deadlock with a
-- writer, and any writer that wants one of those rows or a parent of a new child row waits.
--
-- WHAT IS GUARANTEED, when the whole protocol runs in ONE transaction:
--   * a write that needs a locked row, or a new child of a locked row, waits until the purge commits
--     (then fails its foreign key) or aborts (then proceeds and its touch trigger resets the clock);
--   * a customer touched before the claim is not claimed (the claim rechecks purge_at after locking);
--   * if any step fails, the transaction rolls back: no customer is deleted, and no stored file has
--     been deleted by this transaction's database work (storage is outside the transaction, see below).
-- WHAT IS NOT GUARANTEED: storage deletion is outside the database transaction. If the connection drops
-- or a timeout fires in step 5 or at commit AFTER the files were deleted, the transaction rolls back:
-- the customer stays expired with dangling paths and the next run purges it. If, in that gap, the owner
-- touches the customer (resetting the clock) the customer is kept with files already gone. This is
-- tolerated: the window is a few statements wide, and is mitigated by running the whole protocol in one
-- transaction with a statement timeout generous enough that it does not fire in normal use.

create or replace function private.claim_expired_customers(p_now timestamptz default now())
returns table (id uuid, tenant_id uuid)
language plpgsql security definer set search_path = '' as $$
declare cids uuid[]; jids uuid[]; dids uuid[];
begin
  select coalesce(array_agg(x.id), '{}'::uuid[]) into cids from (
    select c.id from public.customers c where c.purge_at < least(p_now, now()) order by c.id for update
  ) x;
  select coalesce(array_agg(x.id), '{}'::uuid[]) into jids from (
    select j.id from public.jobs j where j.customer_id = any (cids) order by j.id for update
  ) x;
  select coalesce(array_agg(x.id), '{}'::uuid[]) into dids from (
    select d.id from public.documents d where d.job_id = any (jids) order by d.id for update
  ) x;
  perform 1 from public.document_versions v where v.document_id = any (dids) order by v.id for update;
  perform 1 from public.job_photos p where p.job_id = any (jids) order by p.id for update;
  perform 1 from public.share_links s where s.document_id = any (dids) order by s.id for update;
  perform 1 from public.document_emails e where e.document_id = any (dids) order by e.id for update;
  perform 1 from public.ai_runs r where r.document_id = any (dids) order by r.id for update;
  return query select c.id, c.tenant_id from public.customers c where c.id = any (cids);
end $$;

-- Changing a photo's path is activity too.
drop trigger job_photos_touch_customer on public.job_photos;
create trigger job_photos_touch_customer after insert or update of storage_path on public.job_photos
  for each row execute function private.touch_customer_from_photo();
