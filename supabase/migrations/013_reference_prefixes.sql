-- 013_reference_prefixes: a quote number may not start with GUA- or SUR- either (guarantee and survey numbers use
-- them in this repo), and may not hold a space or control character anywhere, so a trailing newline can never slip a
-- reserved ending past the check (PostgreSQL's $ is end of string, so 'Q-5-D' followed by a newline did not match
-- the ending pattern). The format check from 001 already refuses whitespace; this makes the rule explicit here too.
--
-- Counted before writing: no job reference starts with GUA- or SUR- or holds whitespace or a control character.
-- Existing documents are never re-checked, so nothing stored is affected.

alter table public.jobs drop constraint jobs_reference_not_document_like;
alter table public.jobs add constraint jobs_reference_not_document_like
  check (
    reference !~ '[[:space:][:cntrl:]]'
    and reference !~ '-(D|B|S[0-9]+|P[0-9]+)$'
    and reference !~ '^(INV|RCP|GC|SR|GUA|SUR)-'
  ) not valid;
do $$
begin
  if not exists (
    select 1 from public.jobs
    where not (reference !~ '[[:space:][:cntrl:]]' and reference !~ '-(D|B|S[0-9]+|P[0-9]+)$' and reference !~ '^(INV|RCP|GC|SR|GUA|SUR)-')
  ) then
    alter table public.jobs validate constraint jobs_reference_not_document_like;
  end if;
end $$;
