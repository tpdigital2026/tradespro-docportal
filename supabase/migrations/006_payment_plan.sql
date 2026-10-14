-- 006_payment_plan: how a job is billed, chosen on the quote form and stored with the job.
-- Shape (snake_case, whole pence and basis points only):
--   {"kind":"full"}
--   {"kind":"deposit","pct_bp":3000}                                  1% to 99% in half-percent steps
--   {"kind":"staged","stages":[{"label":"...","mode":"pct","pct_bp":2000},{"label":"...","mode":"amount","gross_pence":150000}, ...]}
--   plus, once the plan has been checked against the quote total, "instalments":[{"index":1,"label":"...","net_pence":..,"vat_pence":..,"gross_pence":..}, ...]
-- The database checks the shape and the lock. That the stages add up to the job total is checked by the
-- app (money.ts), because the quote total lives in the version, not on the job.
--
-- Same rules as the other job columns: row level security is unchanged (tenant policies apply to the
-- whole row), the app role gets column grants for exactly this column, and once the quotation has left
-- draft only the server can change it.

alter table public.jobs add column payment_plan jsonb;
alter table public.jobs add constraint jobs_payment_plan_kind
  check (payment_plan is null or (jsonb_typeof(payment_plan) = 'object' and payment_plan ->> 'kind' in ('deposit', 'full', 'staged')));

grant insert (payment_plan) on public.jobs to authenticated;
grant update (payment_plan) on public.jobs to authenticated;

-- Runs as the caller (not security definer), like the other job triggers, and calls no other private
-- function, so the app role needs no execute grant. App role detection is inline, as in 002b and 002c.
create function private.validate_job_payment_plan() returns trigger
language plpgsql set search_path = '' as $$
declare
  p jsonb := new.payment_plan;
  k text;
  s jsonb;
  inst jsonb;
  ord int;
  expected int;
  is_app boolean;
begin
  if tg_op = 'UPDATE' and new.payment_plan is not distinct from old.payment_plan then
    return new;
  end if;

  is_app := current_user = 'authenticated'
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated';
  if tg_op = 'UPDATE' and is_app and exists (
    select 1 from public.documents d
    where d.job_id = new.id and d.tenant_id = new.tenant_id and d.type = 'quotation' and d.status <> 'draft'
  ) then
    raise exception 'The payment plan cannot be changed once the quote has been issued' using errcode = '42501';
  end if;

  if p is null then
    return new;
  end if;
  if jsonb_typeof(p) <> 'object' or octet_length(p::text) > 8000 then
    raise exception 'The payment plan is not valid' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('kind', 'pct_bp', 'stages', 'instalments') then
      raise exception 'The payment plan is not valid' using errcode = '22023';
    end if;
  end loop;

  if p ->> 'kind' = 'full' then
    if p ? 'pct_bp' or p ? 'stages' then
      raise exception 'The payment plan is not valid' using errcode = '22023';
    end if;
    expected := 1;
  elsif p ->> 'kind' = 'deposit' then
    if p ? 'stages' or jsonb_typeof(p -> 'pct_bp') is distinct from 'number'
       or (p ->> 'pct_bp') !~ '^[0-9]{1,4}$' or (p ->> 'pct_bp')::int not between 100 and 9900 or (p ->> 'pct_bp')::int % 50 <> 0 then
      raise exception 'The payment plan is not valid' using errcode = '22023';
    end if;
    expected := 2;
  elsif p ->> 'kind' = 'staged' then
    if p ? 'pct_bp' or jsonb_typeof(p -> 'stages') is distinct from 'array' or jsonb_array_length(p -> 'stages') not between 2 and 10 then
      raise exception 'The payment plan is not valid' using errcode = '22023';
    end if;
    for s in select value from jsonb_array_elements(p -> 'stages') loop
      if jsonb_typeof(s) <> 'object' or jsonb_typeof(s -> 'label') is distinct from 'string'
         or length(btrim(s ->> 'label')) not between 1 and 80 then
        raise exception 'The payment plan is not valid' using errcode = '22023';
      end if;
      if s ->> 'mode' = 'pct' then
        if jsonb_typeof(s -> 'pct_bp') is distinct from 'number'
           or (s ->> 'pct_bp') !~ '^[0-9]{1,4}$' or (s ->> 'pct_bp')::int not between 1 and 9999 then
          raise exception 'The payment plan is not valid' using errcode = '22023';
        end if;
      elsif s ->> 'mode' = 'amount' then
        if jsonb_typeof(s -> 'gross_pence') is distinct from 'number'
           or (s ->> 'gross_pence') !~ '^[0-9]{1,12}$' or (s ->> 'gross_pence')::bigint < 1 then
          raise exception 'The payment plan is not valid' using errcode = '22023';
        end if;
      else
        raise exception 'The payment plan is not valid' using errcode = '22023';
      end if;
    end loop;
    expected := jsonb_array_length(p -> 'stages');
  else
    raise exception 'The payment plan is not valid' using errcode = '22023';
  end if;

  if p ? 'instalments' then
    if jsonb_typeof(p -> 'instalments') is distinct from 'array' or jsonb_array_length(p -> 'instalments') <> expected then
      raise exception 'The payment plan is not valid' using errcode = '22023';
    end if;
    for inst, ord in select value, ordinality from jsonb_array_elements(p -> 'instalments') with ordinality loop
      if jsonb_typeof(inst) <> 'object'
         or jsonb_typeof(inst -> 'label') is distinct from 'string' or length(btrim(inst ->> 'label')) not between 1 and 100
         or jsonb_typeof(inst -> 'index') is distinct from 'number' or (inst ->> 'index') !~ '^[0-9]{1,2}$' or (inst ->> 'index')::int <> ord
         or jsonb_typeof(inst -> 'net_pence') is distinct from 'number' or (inst ->> 'net_pence') !~ '^[0-9]{1,12}$'
         or jsonb_typeof(inst -> 'vat_pence') is distinct from 'number' or (inst ->> 'vat_pence') !~ '^[0-9]{1,12}$'
         or jsonb_typeof(inst -> 'gross_pence') is distinct from 'number' or (inst ->> 'gross_pence') !~ '^[0-9]{1,12}$'
         or (inst ->> 'net_pence')::bigint + (inst ->> 'vat_pence')::bigint <> (inst ->> 'gross_pence')::bigint then
        raise exception 'The payment plan is not valid' using errcode = '22023';
      end if;
    end loop;
  end if;

  return new;
end $$;

create trigger jobs_validate_payment_plan before insert or update of payment_plan on public.jobs
  for each row execute function private.validate_job_payment_plan();

revoke all on function private.validate_job_payment_plan() from public, anon, authenticated;
