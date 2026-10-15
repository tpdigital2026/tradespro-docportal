-- 012_documents_storage: the private bucket for finalised PDFs and page images.
--
-- Only the server uses it, with the service role (which bypasses row level security). Nobody signed in through the
-- app, and nobody anonymous, can list, read, write or delete anything in it: storage.objects has row level security
-- on, this bucket gets no permissive policy, and the restrictive policy below makes sure a permissive policy added
-- later for some other bucket can never open this one. Files reach the owner only through our own routes, after the
-- session and tenant checks.
--
-- Paths: {tenant}/{customer}/{job}/{version}/... The pdf_path columns already have to start with the tenant id
-- (002b). Customer erasure and the purge delete the customer's whole folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf', 'image/png', 'application/json'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy documents_bucket_no_app_access on storage.objects as restrictive for all to anon, authenticated
  using (bucket_id <> 'documents') with check (bucket_id <> 'documents');
