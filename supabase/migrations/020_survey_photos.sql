-- 020_survey_photos: survey report photos and numbers.
--
-- Photos are customer data. They are written by the server only (service role), after the image has been re-encoded
-- with every bit of metadata (EXIF, GPS, XMP, ICC comments) dropped. The row is inserted first, then the file is
-- uploaded; a failed upload deletes the row again (README "More server rules"). The app role keeps the read access
-- and the finding_ref update grant it had; it gets no insert or other update.
--
-- Paths: {tenant}/{customer}/{job}/{photo}.jpg in the private `documents` bucket. The tenant prefix check from 002b
-- still applies; customer erasure and the purge already list job_photos.storage_path and delete the customer folder.

-- 1. A fingerprint and the stored size, so a document's content key changes whenever a photo does, and so limits can
--    be checked without reading files. Both are filled by the server; old rows (there are none yet) may stay null.
alter table public.job_photos add column sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
alter table public.job_photos add column bytes int check (bytes is null or bytes between 1 and 20971520);
alter table public.job_photos add constraint job_photos_path_shape
  check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$') not valid;
create index job_photos_tenant_sha_idx on public.job_photos (tenant_id, job_id, sha256);

-- 2. The private bucket now also holds the re-encoded JPEG photos.
update storage.buckets
   set allowed_mime_types = array['application/pdf', 'image/png', 'application/json', 'image/jpeg']
 where id = 'documents';

-- 3. A survey report is numbered after its job: SR-{job reference}. Job references may never start with SR- (013),
--    so no survey number can equal a quote number. One survey report per job; a correction is a new version.
create function private.survey_number_matches_job() returns trigger
language plpgsql set search_path = '' as $$
declare
  q text;
begin
  if new.type::text <> 'survey_report' then
    return new;
  end if;
  select j.reference into q from public.jobs j where j.id = new.job_id and j.tenant_id = new.tenant_id;
  -- No such job in this business: left to the composite foreign key and row level security.
  if q is not null and new.number <> 'SR-' || q then
    raise exception 'That survey number does not match its job' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger documents_survey_number before insert on public.documents
  for each row execute function private.survey_number_matches_job();
revoke all on function private.survey_number_matches_job() from public, anon, authenticated;
