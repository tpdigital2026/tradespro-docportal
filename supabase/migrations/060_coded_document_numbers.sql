-- 060_coded_document_numbers: document numbers the way the owner's real documents carry them.
--
-- A quote is numbered QT-{CODE}-{NNN} (QT-GW-001). Its invoices, receipts and guarantee are built from the quote number
-- WITHOUT the QT- in front: INV-GW-001-D, INV-GW-001-B, RCP-GW-001-D, RCP-GW-001-B, GC-GW-001. Older quote numbers such as
-- FJC1003 have no QT- and keep giving INV-FJC1003-D, so existing records stay valid.
--
-- This replaces private.claim_document_number() (last written in 050) so that a document number is accepted when it
-- matches its job's reference in EITHER form: the whole reference (what the code before this change builds, e.g.
-- INV-QT-GW-001-D) or its stem (the new form, INV-GW-001-D). Nothing that was accepted before is refused now, so the
-- version of the app that is already deployed keeps working against this database, and the new version works too.
-- No data is changed, no constraint is added, and existing documents are never re-checked.

create or replace function private.claim_document_number() returns trigger
language plpgsql set search_path = '' as $$
declare
  q text;
  stem text;
  qs text[];
  t text := new.type::text;
  n text := new.number;
  ok boolean := true;
  tail text;
  base text;
  x text;
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
      stem := case when q ~* '^QT-.' then substr(q, 4) else q end;
      qs := array[q, stem];
      ok := false;
      foreach x in array qs loop
        tail := case when left(n, length('GC-' || x || '-G')) = 'GC-' || x || '-G' then substr(n, length('GC-' || x || '-G') + 1) end;
        if n = 'GC-' || x or (tail is not null and tail ~ '^([2-9]|1[0-9]|20)$') then
          ok := true;
        end if;
      end loop;
      if not ok then
        raise exception 'That document number does not match its job and document type' using errcode = '23514';
      end if;
    end if;
  end if;

  if t in ('deposit_invoice', 'balance_invoice', 'invoice_full', 'invoice_stage', 'receipt') then
    select j.reference into q from public.jobs j where j.id = new.job_id and j.tenant_id = new.tenant_id;
    -- No such job in this business: left to the composite foreign key and row level security.
    if q is not null then
      stem := case when q ~* '^QT-.' then substr(q, 4) else q end;
      qs := array[q, stem];
      ok := false;
      foreach x in array qs loop
        if t = 'deposit_invoice' then
          if n = 'INV-' || x || '-D' then ok := true; end if;
        elsif t = 'balance_invoice' then
          if n = 'INV-' || x || '-B' then ok := true; end if;
        elsif t = 'invoice_full' then
          if n = 'INV-' || x then ok := true; end if;
        elsif t = 'invoice_stage' then
          tail := case when left(n, length('INV-' || x || '-S')) = 'INV-' || x || '-S' then substr(n, length('INV-' || x || '-S') + 1) end;
          if tail is not null and tail ~ '^([1-9]|10)$' then ok := true; end if;
        else
          -- A base receipt number, optionally followed by -P2 to -P99 for the second and later payments.
          base := case when n ~ '-P([2-9]|[1-9][0-9])$' then regexp_replace(n, '-P([2-9]|[1-9][0-9])$', '') else n end;
          tail := case when left(base, length('RCP-' || x || '-S')) = 'RCP-' || x || '-S' then substr(base, length('RCP-' || x || '-S') + 1) end;
          if base in ('RCP-' || x, 'RCP-' || x || '-D', 'RCP-' || x || '-B') or (tail is not null and tail ~ '^([1-9]|10)$') then ok := true; end if;
        end if;
      end loop;
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
