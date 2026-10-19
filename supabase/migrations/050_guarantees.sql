-- 050_guarantees: numbering and one certificate per roof type for guarantee certificates.
--
-- 1. A guarantee certificate is numbered after its job: GC-{job reference} for the first, GC-{job reference}-G2 to
--    GC-{job reference}-G20 for later ones (a job can have a certificate for each roof type). Job references may not
--    start with GC- (011), and now may not end in -G and a number either, so a job's second certificate can never have
--    the same number as another job's first one (the same reason -P{k} is reserved for later receipts).
--    Counted before writing: no existing job reference ends in -G and digits. Existing documents are never re-checked.
-- 2. One certificate per roof type per job, enforced by the database too: no two certificates of a job (that are not void)
--    may have the same roofKey in their current version. The server computes roofKey from the roof type chosen.

alter table public.jobs drop constraint jobs_reference_not_document_like;
alter table public.jobs add constraint jobs_reference_not_document_like
  check (
    reference !~ '[[:space:][:cntrl:]]'
    and reference !~ '-(D|B|S[0-9]+|P[0-9]+|G[0-9]+)$'
    and reference !~ '^(INV|RCP|GC|SR|GUA|SUR)-'
  ) not valid;
do $$
begin
  if not exists (
    select 1 from public.jobs
    where not (reference !~ '[[:space:][:cntrl:]]' and reference !~ '-(D|B|S[0-9]+|P[0-9]+|G[0-9]+)$' and reference !~ '^(INV|RCP|GC|SR|GUA|SUR)-')
  ) then
    alter table public.jobs validate constraint jobs_reference_not_document_like;
  end if;
end $$;

create or replace function private.claim_document_number() returns trigger
language plpgsql set search_path = '' as $$
declare
  q text;
  t text := new.type::text;
  n text := new.number;
  ok boolean := true;
  tail text;
  base text;
begin
  if tg_op = 'UPDATE' then
    if new.number is distinct from old.number then
      raise exception 'A document number cannot be changed' using errcode = '23000';
    end if;
    return new;
  end if;

  if t = 'quotation' then
    return new;
  end if;

  if t = 'guarantee' then
    select j.reference into q from public.jobs j where j.id = new.job_id and j.tenant_id = new.tenant_id;
    if q is not null then
      tail := case when left(n, length('GC-' || q || '-G')) = 'GC-' || q || '-G' then substr(n, length('GC-' || q || '-G') + 1) end;
      ok := n = 'GC-' || q or (tail is not null and tail ~ '^([2-9]|1[0-9]|20)$');
      if not ok then
        raise exception 'That document number does not match its job and document type' using errcode = '23514';
      end if;
    end if;
  end if;

  if t in ('deposit_invoice', 'balance_invoice', 'invoice_full', 'invoice_stage', 'receipt') then
    select j.reference into q from public.jobs j where j.id = new.job_id and j.tenant_id = new.tenant_id;
    -- No such job in this business: left to the composite foreign key and row level security.
    if q is not null then
      if t = 'deposit_invoice' then
        ok := n = 'INV-' || q || '-D';
      elsif t = 'balance_invoice' then
        ok := n = 'INV-' || q || '-B';
      elsif t = 'invoice_full' then
        ok := n = 'INV-' || q;
      elsif t = 'invoice_stage' then
        tail := case when left(n, length('INV-' || q || '-S')) = 'INV-' || q || '-S' then substr(n, length('INV-' || q || '-S') + 1) end;
        ok := tail is not null and tail ~ '^([1-9]|10)$';
      else
        -- A base receipt number, optionally followed by -P2 to -P99 for the second and later payments.
        base := case when n ~ '-P([2-9]|[1-9][0-9])$' then regexp_replace(n, '-P([2-9]|[1-9][0-9])$', '') else n end;
        tail := case when left(base, length('RCP-' || q || '-S')) = 'RCP-' || q || '-S' then substr(base, length('RCP-' || q || '-S') + 1) end;
        ok := base in ('RCP-' || q, 'RCP-' || q || '-D', 'RCP-' || q || '-B') or (tail is not null and tail ~ '^([1-9]|10)$');
      end if;
      if not ok then
        raise exception 'That document number does not match its job and document type' using errcode = '23514';
      end if;
    end if;
  end if;

  insert into public.used_numbers (tenant_id, number) values (new.tenant_id, new.number);
  return new;
exception when unique_violation then
  raise exception 'Document number % has already been used', n using errcode = '23505';
end $$;
revoke all on function private.claim_document_number() from public, anon, authenticated;

create function private.guarantee_one_per_roof() returns trigger
language plpgsql set search_path = '' as $$
declare
  key text := new.input -> 'guarantee' ->> 'roofKey';
  job uuid;
  kind text;
begin
  if key is null or key = '' then
    return new;
  end if;
  select d.job_id, d.type::text into job, kind from public.documents d where d.id = new.document_id and d.tenant_id = new.tenant_id;
  if kind is distinct from 'guarantee' then
    return new;
  end if;
  if exists (
    select 1
      from public.documents d
      join public.document_versions v on v.id = d.current_version_id and v.tenant_id = d.tenant_id
     where d.tenant_id = new.tenant_id and d.job_id = job and d.type = 'guarantee' and d.id <> new.document_id and d.status <> 'void'
       and v.input -> 'guarantee' ->> 'roofKey' = key
  ) then
    raise exception 'This job already has a guarantee certificate for that roof type' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger document_versions_guarantee_one_per_roof before insert or update of input on public.document_versions
  for each row execute function private.guarantee_one_per_roof();
revoke all on function private.guarantee_one_per_roof() from public, anon, authenticated;
