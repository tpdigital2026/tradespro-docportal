-- 021_survey_photo_path: drops the photo path shape check added in 020. The existing tenant-prefix check from 002b
-- (path inside the tenant's folder, never climbing out) stays the database rule; the exact
-- {tenant}/{customer}/{job}/{photo}.jpg shape is built by the server only (src/lib/data/surveys.ts photoPath) and
-- checked again before any storage call (src/lib/storage.ts assertSafePath).
alter table public.job_photos drop constraint if exists job_photos_path_shape;
