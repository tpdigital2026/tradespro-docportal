-- 002c_version_lock: the draft lock reaches versions and emails, current_version_id belongs to its own
-- document, and the app role cannot choose a revocation time.
--
-- App role detection is inline in each trigger (no helper, so nothing extra is executable by the app
-- role): a session running as authenticated, or a JWT whose role claim is authenticated. These trigger
-- functions are not security definer, so current_user is the caller.

-- Versions of a document that has left draft cannot be inserted or changed by the app role.
create function private.version_locked_after_draft() returns trigger
language plpgsql set search_path = '' as $$
declare parent_status public.doc_status;
begin
  if (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated') then
    select d.status into parent_status from public.documents d where d.id = new.document_id and d.tenant_id = new.tenant_id;
    -- Not found (another tenant's document, or none) is left to row level security and the foreign key.
    if parent_status is not null and parent_status <> 'draft' then
      raise exception 'A version of a document that is no longer a draft cannot be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger document_versions_locked_after_draft before insert or update on public.document_versions
  for each row execute function private.version_locked_after_draft();

-- current_version_id must be a version of the same document (the tenant composite key stays as well).
alter table public.document_versions add constraint document_versions_id_document_id_key unique (id, document_id);
alter table public.documents add constraint documents_current_version_same_document
  foreign key (current_version_id, id) references public.document_versions (id, document_id)
  on delete set null (current_version_id) deferrable initially deferred;

-- Emails that have left draft cannot be edited by the app role.
create function private.email_locked_after_draft() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'draft'
     and (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated')
     and (new.to_email is distinct from old.to_email or new.subject is distinct from old.subject or new.body is distinct from old.body) then
    raise exception 'An email that is no longer a draft cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger document_emails_locked_after_draft before update on public.document_emails
  for each row execute function private.email_locked_after_draft();

-- A revoked share link stays revoked, for everyone; when the app role revokes, the database sets the time.
create or replace function private.share_link_no_unrevoke() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revoked share link cannot be reinstated' using errcode = '23000';
  end if;
  if old.revoked_at is null and new.revoked_at is not null
     and (current_user = 'authenticated' or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated') then
    new.revoked_at := now();
  end if;
  return new;
end $$;

revoke all on function private.version_locked_after_draft() from public, anon, authenticated;
revoke all on function private.email_locked_after_draft() from public, anon, authenticated;
