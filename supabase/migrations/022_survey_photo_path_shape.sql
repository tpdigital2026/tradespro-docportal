-- 022_survey_photo_path_shape: a photo's storage path names its own customer, job and photo, so a row can never
-- point into another customer's or job's folder (review of 020/021). Replaces the shape check that 021 dropped.
--
--   storage_path = {tenant}/{customer}/{job}/{photo id}.jpg
--
-- The CHECK ties the tenant, job and photo id parts to the row itself. The customer part is checked by a trigger
-- against the job's customer (a CHECK cannot read another table). The trigger only looks at paths that already have
-- the right shape, so a wrong path is still reported by the 002b tenant check or by this shape check, by name.
-- NOT VALID: rows written before this migration keep their paths (the dev database has none from the app).

alter table public.job_photos add constraint job_photos_path_shape
  check (
    storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and split_part(storage_path, '/', 1) = tenant_id::text
    and split_part(storage_path, '/', 3) = job_id::text
    and split_part(storage_path, '/', 4) = id::text || '.jpg'
  ) not valid;

create function private.job_photo_path_customer() returns trigger
language plpgsql set search_path = '' as $$
declare
  c uuid;
begin
  if new.storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$' then
    return new;
  end if;
  select j.customer_id into c from public.jobs j where j.id = new.job_id and j.tenant_id = new.tenant_id;
  if c is not null and split_part(new.storage_path, '/', 2) <> c::text then
    raise exception 'A photo path must sit in its own customer''s folder' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger job_photos_path_customer before insert or update of storage_path, job_id on public.job_photos
  for each row execute function private.job_photo_path_customer();
revoke all on function private.job_photo_path_customer() from public, anon, authenticated;
