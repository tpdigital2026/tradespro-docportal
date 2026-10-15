-- 009_receipt_per_payment: every payment gets its own receipt, and a small immutability fix.
--
-- Receipt numbers: the first payment on an instalment keeps RCP-{q}-D, RCP-{q}-B, RCP-{q}-S{n} or RCP-{q}; further
-- payments on the same instalment add -2 to -99 (RCP-{q}-S3-2). Everything else about numbers is as in 008.
create or replace function private.claim_document_number() returns trigger
language plpgsql set search_path = '' as $$
declare
  q text;
  t text := new.type::text;
  n text := new.number;
  ok boolean := true;
  tail text;
  base text;
  stripped text;
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
        -- A receipt is a base number, optionally followed by -2 to -99. Both the whole number and the number
        -- with that ending removed are tried, because a quote number may itself end in digits.
        ok := false;
        stripped := case when n ~ '-([2-9]|[1-9][0-9])$' then regexp_replace(n, '-([2-9]|[1-9][0-9])$', '') end;
        foreach base in array array[n, stripped] loop
          if base is not null then
            tail := case when left(base, length('RCP-' || q || '-S')) = 'RCP-' || q || '-S' then substr(base, length('RCP-' || q || '-S') + 1) end;
            if base in ('RCP-' || q, 'RCP-' || q || '-D', 'RCP-' || q || '-B') or (tail is not null and tail ~ '^([1-9]|10)$') then
              ok := true;
            end if;
          end if;
        end loop;
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

-- Payments. Until a receipt is finalised from a payment, the server may correct its amount, date, method and note
-- and set the receipt link once. After that nothing about it changes. The one exception in every case is created_by
-- going to null, which is what deleting the person's account does (on delete set null); nothing else may change then.
-- (This replaces the comment in 008, which said only the receipt link could change.)
create or replace function private.payments_immutable() returns trigger
language plpgsql set search_path = '' as $$
declare rs text; is_app boolean;
begin
  is_app := current_user = 'authenticated'
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated';
  if tg_op = 'DELETE' then
    if old.receipt_document_id is not null then
      select x.status::text into rs from public.documents x where x.id = old.receipt_document_id and x.tenant_id = old.tenant_id;
      if rs is not null and rs <> 'draft' and (coalesce(current_setting('app.allow_final_delete', true), '') <> 'on' or is_app) then
        raise exception 'A payment with an issued receipt cannot be deleted' using errcode = '23000';
      end if;
    end if;
    return old;
  end if;
  -- The person who recorded it was deleted: only created_by changes, and only to null.
  if new.created_by is null and old.created_by is not null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  if old.receipt_document_id is not null then
    select x.status::text into rs from public.documents x where x.id = old.receipt_document_id and x.tenant_id = old.tenant_id;
    if rs is not null and rs <> 'draft' then
      raise exception 'A payment with an issued receipt cannot be changed' using errcode = '23000';
    end if;
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or new.job_id is distinct from old.job_id
     or new.document_id is distinct from old.document_id or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'A payment cannot be moved to another invoice or job' using errcode = '23000';
  end if;
  return new;
end $$;
revoke all on function private.payments_immutable() from public, anon, authenticated;
