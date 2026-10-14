-- 008_payments: recording payments by hand, the invoice-full and invoice-stage document types, and
-- document numbers that go through the used_numbers registry.
--
-- Payments are written by the server only (service role, after the session and tenant checks), so the
-- app role gets read access and nothing else. The row is never edited once a receipt has been issued
-- from it. The invoice is never touched by a payment: "paid" is derived from the payments.

-- 1. New document types. ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
--    so nothing below compares against these literals except as text, inside function bodies.
alter type public.doc_type add value if not exists 'invoice_full';
alter type public.doc_type add value if not exists 'invoice_stage';

-- 2. The registry holds invoice and receipt numbers too. INV-{quote}-S10 can be 8 characters longer than a
--    40 character quote number, so the limit moves to 64.
alter table public.used_numbers drop constraint used_numbers_number_length;
alter table public.used_numbers add constraint used_numbers_number_length check (length(number) between 1 and 64);
alter table public.documents add constraint documents_number_length check (length(number) between 1 and 64);

-- 3. Document numbers. Invoices and receipts are named after their job's quote number:
--      deposit INV-{q}-D, balance INV-{q}-B, full INV-{q}, stage INV-{q}-S{n} (n 1 to 10)
--      receipts RCP-{q}-D, RCP-{q}-B, RCP-{q}, RCP-{q}-S{n}
--    The number is claimed once in used_numbers, forever, and never changes, the same as a quote number.
--    A quotation's number is its job's reference, already claimed by the jobs trigger, so it is skipped
--    here. Guarantees and survey reports keep their free format. Runs as the caller (not security
--    definer) so the used_numbers insert policy applies to the signed-in user.
create function private.claim_document_number() returns trigger
language plpgsql set search_path = '' as $$
declare
  q text;
  t text := new.type::text;
  n text := new.number;
  ok boolean := true;
  tail text;
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
        tail := case when left(n, length('RCP-' || q || '-S')) = 'RCP-' || q || '-S' then substr(n, length('RCP-' || q || '-S') + 1) end;
        ok := n in ('RCP-' || q, 'RCP-' || q || '-D', 'RCP-' || q || '-B') or (tail is not null and tail ~ '^([1-9]|10)$');
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
create trigger documents_claim_number before insert or update of number on public.documents
  for each row execute function private.claim_document_number();
revoke all on function private.claim_document_number() from public, anon, authenticated;

-- 4. The payments table.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  document_id uuid not null,
  amount_pence bigint not null check (amount_pence between 1 and 125000000),
  paid_on date not null check (paid_on >= date '2000-01-01'),
  method text not null check (method in ('bank transfer', 'cash', 'cheque', 'card', 'other')),
  note text check (note is null or length(note) <= 200),
  receipt_document_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (job_id, tenant_id) references public.jobs (id, tenant_id) on delete cascade,
  foreign key (document_id, tenant_id) references public.documents (id, tenant_id) on delete cascade,
  foreign key (receipt_document_id, tenant_id) references public.documents (id, tenant_id)
);
create index payments_tenant_job_idx on public.payments (tenant_id, job_id);
create index payments_tenant_document_idx on public.payments (tenant_id, document_id);
create index payments_receipt_idx on public.payments (tenant_id, receipt_document_id);
-- One receipt per payment, and one payment per receipt.
create unique index payments_one_receipt on public.payments (receipt_document_id) where receipt_document_id is not null;

alter table public.payments enable row level security;
alter table public.payments force row level security;
create policy tenant_select on public.payments for select to authenticated
  using (tenant_id = (select private.current_tenant_id()));
create policy active_profile_only on public.payments as restrictive for all to authenticated
  using ((select private.current_tenant_id()) is not null) with check ((select private.current_tenant_id()) is not null);
-- Read only for the app role. Recording a payment is a server action on the service role.
grant select on public.payments to authenticated;

-- The paying document must be a final invoice of the same job; the receipt must be a receipt of the same job.
create function private.payments_check_links() returns trigger
language plpgsql set search_path = '' as $$
declare d record; r record;
begin
  if tg_op = 'INSERT' or new.document_id is distinct from old.document_id or new.job_id is distinct from old.job_id then
    select x.job_id, x.type::text as type, x.status::text as status into d
      from public.documents x where x.id = new.document_id and x.tenant_id = new.tenant_id;
    if not found then return new; end if; -- left to the foreign key
    if d.job_id <> new.job_id then
      raise exception 'The invoice belongs to a different job' using errcode = '23514';
    end if;
    if d.type not in ('deposit_invoice', 'balance_invoice', 'invoice_full', 'invoice_stage') then
      raise exception 'A payment can only be recorded against an invoice' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' and d.status not in ('final', 'sent') then
      raise exception 'A payment can only be recorded against a final invoice' using errcode = '23514';
    end if;
  end if;
  if new.receipt_document_id is not null and (tg_op = 'INSERT' or new.receipt_document_id is distinct from old.receipt_document_id) then
    select x.job_id, x.type::text as type into r
      from public.documents x where x.id = new.receipt_document_id and x.tenant_id = new.tenant_id;
    if found and (r.job_id <> new.job_id or r.type <> 'receipt') then
      raise exception 'The receipt must be a receipt for the same job' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger payments_check_links before insert or update on public.payments
  for each row execute function private.payments_check_links();

-- Once a receipt has been finalised from a payment, nothing about it changes and it cannot be deleted.
-- Before that, only the receipt link may be set, once. The purge (which sets app.allow_final_delete) may
-- delete it as part of removing a customer; the app role can never use that override.
create function private.payments_immutable() returns trigger
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
  -- update
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
create trigger payments_immutable before update or delete on public.payments
  for each row execute function private.payments_immutable();

-- Every recorded payment leaves an audit entry with ids and the amount, never names or addresses.
create function private.payments_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (tenant_id, user_id, action, entity, entity_id, meta)
  values (new.tenant_id, new.created_by, 'payment.record', 'payment', replace(new.id::text, '-', ''),
    jsonb_build_object('job', replace(new.job_id::text, '-', ''), 'invoice', replace(new.document_id::text, '-', ''), 'amountPence', new.amount_pence, 'method', new.method));
  return new;
end $$;
create trigger payments_audit after insert on public.payments
  for each row execute function private.payments_audit();

revoke all on function private.payments_check_links() from public, anon, authenticated;
revoke all on function private.payments_immutable() from public, anon, authenticated;
revoke all on function private.payments_audit() from public, anon, authenticated;

-- 5. The purge and erasure lock set now includes payments, last, ordered by id (same convention).
create or replace function private.lock_customer_tree(p_customer_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare jids uuid[]; dids uuid[];
begin
  select coalesce(array_agg(x.id), '{}'::uuid[]) into jids from (
    select j.id from public.jobs j where j.customer_id = any (p_customer_ids) order by j.id for update
  ) x;
  select coalesce(array_agg(x.id), '{}'::uuid[]) into dids from (
    select d.id from public.documents d where d.job_id = any (jids) order by d.id for update
  ) x;
  perform 1 from public.document_versions v where v.document_id = any (dids) order by v.id for update;
  perform 1 from public.job_photos p where p.job_id = any (jids) order by p.id for update;
  perform 1 from public.share_links s where s.document_id = any (dids) order by s.id for update;
  perform 1 from public.document_emails e where e.document_id = any (dids) order by e.id for update;
  perform 1 from public.ai_runs r where r.document_id = any (dids) order by r.id for update;
  perform 1 from public.payments y where y.job_id = any (jids) order by y.id for update;
end $$;
revoke all on function private.lock_customer_tree(uuid[]) from public, anon, authenticated;
grant execute on function private.lock_customer_tree(uuid[]) to service_role;
