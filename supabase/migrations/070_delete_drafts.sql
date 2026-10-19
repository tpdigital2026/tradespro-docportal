-- 070_delete_drafts: the owner (or staff) can delete a draft document that was never issued.
--
-- 1. The database refuses to delete any document that has left draft, or that has an issued (finalised) version, such as
--    a quote changed after it was issued (it is back in draft but its issued version must stay). Only the purge and
--    owner-requested erasure may (they set app.allow_final_delete, which never counts for the app role).
-- 2. private.delete_draft_document(tenant, document) does the whole delete in the caller's transaction, on a service
--    connection only: it locks the job and the document, checks the rules again, removes the draft's photos (a survey's),
--    the document (its versions, share links and emails go with it), and the job too when nothing else is left on it
--    (no other document, payment or appointment). It returns what the caller must then remove from storage.
-- 3. Numbers. A document number (and a job's quote number) is claimed in used_numbers when the draft is first saved, not
--    at finalise. A draft that is deleted was never issued, so its number never appeared on anything a customer saw;
--    this function releases exactly that claim (the document's own number, and the job's reference when the job goes
--    too) so deleting a draft burns nothing and the same number is offered again. Every other delete keeps the claim
--    forever, as before (tests/db/payments.test.ts, integrity.test.ts).

create function private.block_issued_document_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (old.status <> 'draft'
      or exists (select 1 from public.document_versions v where v.document_id = old.id and v.tenant_id = old.tenant_id and v.finalised_at is not null))
     and (coalesce(current_setting('app.allow_final_delete', true), '') <> 'on'
          or current_user = 'authenticated'
          or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated') then
    raise exception 'Only a draft that was never issued can be deleted' using errcode = '23000';
  end if;
  return old;
end $$;
create trigger documents_delete_only_drafts before delete on public.documents
  for each row execute function private.block_issued_document_delete();
revoke all on function private.block_issued_document_delete() from public, anon, authenticated;

-- Result: {"status": "deleted" | "not_found" | "issued" | "in_use", "customerId", "jobId", "type", "jobDeleted",
--          "versionIds": [...], "photoPaths": [...]}. Nothing is changed unless status is "deleted".
create function private.delete_draft_document(p_tenant uuid, p_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  j record;
  versions uuid[];
  photos text[] := '{}';
  job_gone boolean := false;
begin
  -- Job first, then the document: the same order as finalise and revise, so the two never deadlock.
  select jb.id, jb.reference, jb.customer_id into j
    from public.jobs jb
   where jb.tenant_id = p_tenant and jb.id = (select x.job_id from public.documents x where x.id = p_document and x.tenant_id = p_tenant)
     for update;
  if j.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select x.id, x.type::text as type, x.number, x.status::text as status into d
    from public.documents x where x.id = p_document and x.tenant_id = p_tenant and x.job_id = j.id for update;
  if d.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if d.status <> 'draft' or exists (select 1 from public.document_versions v where v.document_id = d.id and v.tenant_id = p_tenant and v.finalised_at is not null) then
    return jsonb_build_object('status', 'issued');
  end if;
  if exists (select 1 from public.payments p where p.tenant_id = p_tenant and (p.document_id = d.id or p.receipt_document_id = d.id)) then
    return jsonb_build_object('status', 'in_use');
  end if;

  select coalesce(array_agg(v.id order by v.version), '{}') into versions
    from public.document_versions v where v.document_id = d.id and v.tenant_id = p_tenant;

  -- A survey report's photos belong to it alone (no other document uses job photos).
  if d.type = 'survey_report' then
    with gone as (delete from public.job_photos ph where ph.tenant_id = p_tenant and ph.job_id = j.id returning ph.storage_path)
    select coalesce(array_agg(storage_path), '{}') into photos from gone;
  end if;

  delete from public.documents x where x.id = d.id and x.tenant_id = p_tenant;
  if d.type <> 'quotation' then
    delete from public.used_numbers u where u.tenant_id = p_tenant and u.number = d.number;
  end if;

  if not exists (select 1 from public.documents x where x.job_id = j.id and x.tenant_id = p_tenant)
     and not exists (select 1 from public.payments p where p.job_id = j.id and p.tenant_id = p_tenant)
     and not exists (select 1 from public.appointments a where a.job_id = j.id and a.tenant_id = p_tenant) then
    with gone as (delete from public.job_photos ph where ph.tenant_id = p_tenant and ph.job_id = j.id returning ph.storage_path)
    select photos || coalesce(array_agg(storage_path), '{}') into photos from gone;
    delete from public.jobs jb where jb.id = j.id and jb.tenant_id = p_tenant;
    delete from public.used_numbers u where u.tenant_id = p_tenant and u.number = j.reference;
    job_gone := true;
  end if;

  return jsonb_build_object(
    'status', 'deleted', 'customerId', j.customer_id, 'jobId', j.id, 'type', d.type, 'jobDeleted', job_gone,
    'versionIds', to_jsonb(versions), 'photoPaths', to_jsonb(photos));
end $$;
revoke all on function private.delete_draft_document(uuid, uuid) from public, anon, authenticated;
