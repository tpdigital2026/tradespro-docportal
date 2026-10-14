-- 003e_final_review: owner erasure takes the same locks as the purge, business names are unique,
-- and the draft lock reads the document status under a share lock.

-- 1. One place for the cascade lock set. Order (fixed): customers, jobs, documents, document_versions,
--    job_photos, share_links, document_emails, ai_runs, each ordered by id. The caller has already
--    locked the customers (and passes their ids) so the customer lock always comes first.
create function private.lock_customer_tree(p_customer_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare jids uuid[]; dids uuid[];
begin
  select coalesce(array_agg(x.id), '{}'::uuid[]) into jids from (
    select j.id from public.jobs j where j.customer_id = any (p_customer_ids) order by j.id for update
  ) x;
  select coalesce(array_agg(x.id), '{}'::uuid[]) into dids from (
    select d.id from public.documents d where d.job_id = any (jids) order by d.id for update
  ) x;
  perform 1 from public.document_versions v where v.document_id = any (dids) order by v.id for update;
  perform 1 from public.job_photos p where p.job_id = any (jids) order by p.id for update;
  perform 1 from public.share_links s where s.document_id = any (dids) order by s.id for update;
  perform 1 from public.document_emails e where e.document_id = any (dids) order by e.id for update;
  perform 1 from public.ai_runs r where r.document_id = any (dids) order by r.id for update;
end $$;

create or replace function private.claim_expired_customers(p_now timestamptz default now())
returns table (id uuid, tenant_id uuid)
language plpgsql security definer set search_path = '' as $$
declare cids uuid[];
begin
  select coalesce(array_agg(x.id), '{}'::uuid[]) into cids from (
    select c.id from public.customers c where c.purge_at < least(p_now, now()) order by c.id for update
  ) x;
  perform private.lock_customer_tree(cids);
  return query select c.id, c.tenant_id from public.customers c where c.id = any (cids);
end $$;

-- Owner-requested erasure, ONE transaction: claim_customer, then customer_storage_paths, delete the
-- files, then erase_customer, then commit. Returns false if the customer is not in that tenant.
create function private.claim_customer(p_tenant uuid, p_customer uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  select c.id into cid from public.customers c where c.id = p_customer and c.tenant_id = p_tenant for update;
  if cid is null then return false; end if;
  perform private.lock_customer_tree(array[cid]);
  return true;
end $$;

revoke all on function private.lock_customer_tree(uuid[]) from public, anon, authenticated;
revoke all on function private.claim_customer(uuid, uuid) from public, anon, authenticated;
grant execute on function private.lock_customer_tree(uuid[]) to service_role;
grant execute on function private.claim_customer(uuid, uuid) to service_role;

-- 2. Business names are unique, ignoring case, so an invite by name can never reach the wrong business.
create unique index tenants_name_lower_key on public.tenants (lower(name));

-- 3. The draft check reads the parent status under a share lock, so a concurrent finalise (which holds
--    the document row for update) is waited for instead of raced.
create or replace function private.version_locked_after_draft() returns trigger
language plpgsql set search_path = '' as $$
declare parent_status public.doc_status;
begin
  if (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated') then
    select d.status into parent_status from public.documents d where d.id = new.document_id and d.tenant_id = new.tenant_id for share;
    if parent_status is not null and parent_status <> 'draft' then
      raise exception 'A version of a document that is no longer a draft cannot be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
