-- 011_receipt_marker: receipts for the second and later payments on an instalment end in -P{k} (k 2 to 99),
-- for example RCP-Q-5-P2 or RCP-Q-5-S3-P2, and quote numbers can no longer look like part of a document number.
--
-- Why: 009 used a bare -{k} ending, so job Q-5's second receipt (RCP-Q-5-2) was also job Q-5-2's first receipt.
-- A quote number may not end in -D, -B, -S{digits} or -P{digits}, and may not start with INV-, RCP-, GC- or SR-
-- (the prefixes of the documents made from it), so no two jobs can ever produce the same document number.
-- Checked before writing this: no existing job reference breaks the rule and no receipt carries a bare -{k} ending.
-- Existing documents are never re-checked (the number trigger runs on insert), so nothing already stored is affected.

alter table public.jobs add constraint jobs_reference_not_document_like
  check (reference !~ '-(D|B|S[0-9]+|P[0-9]+)$' and reference !~ '^(INV|RCP|GC|SR)-') not valid;
do $$
begin
  if not exists (select 1 from public.jobs where not (reference !~ '-(D|B|S[0-9]+|P[0-9]+)$' and reference !~ '^(INV|RCP|GC|SR)-')) then
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
