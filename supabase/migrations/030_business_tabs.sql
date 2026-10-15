-- 030_business_tabs: the Pipeline, Money, Calendar and Guarantees tabs.
--   1. Their routes are reserved words, so no business can take them as its sign-in address.
--   2. appointments: the owner's calendar (site visits, surveys, job start and finish). Tenant scoped, row level
--      security forced, composite foreign keys, column grants. Erased with the customer (cascade) and locked with
--      the rest of the customer's rows by the purge and erasure claim. No reminders, no notifications.
--   3. lock_customer_tree locks appointments too (last, ordered by id, the same convention).
--   4. private.purge_unlinked_appointments: appointments with no customer are removed once they are older than the
--      business's retention period. Service role only; not scheduled yet (like the customer purge).

-- 1. Reserved words. No business uses any of the new ones (checked before this migration was written).
alter table public.tenants drop constraint tenants_slug_not_reserved;
alter table public.tenants add constraint tenants_slug_not_reserved
  check (slug is null or slug <> all (array['login','api','admin','customers','documents','dev','_next','s','static','public','favicon','robots','sitemap','pipeline','money','calendar','guarantees']));

-- 2. Appointments.
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  kind text not null check (kind in ('site_visit', 'survey', 'job_start', 'job_finish', 'other')),
  title text not null check (length(title) between 1 and 120 and title !~ '[[:cntrl:]]'),
  starts_at timestamptz not null check (starts_at >= timestamptz '2000-01-01 00:00:00+00' and starts_at < timestamptz '2100-01-01 00:00:00+00'),
  ends_at timestamptz,
  customer_id uuid,
  job_id uuid,
  notes text check (notes is null or length(notes) <= 1000),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  constraint appointments_end_after_start check (ends_at is null or (ends_at > starts_at and ends_at <= starts_at + interval '14 days')),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade,
  foreign key (job_id, tenant_id) references public.jobs (id, tenant_id) on delete cascade
);
create index appointments_tenant_starts_idx on public.appointments (tenant_id, starts_at);
create index appointments_tenant_customer_idx on public.appointments (tenant_id, customer_id);
create index appointments_tenant_job_idx on public.appointments (tenant_id, job_id);

alter table public.appointments enable row level security;
alter table public.appointments force row level security;
create policy tenant_select on public.appointments for select to authenticated using (tenant_id = (select private.current_tenant_id()));
create policy tenant_insert on public.appointments for insert to authenticated with check (tenant_id = (select private.current_tenant_id()));
create policy tenant_update on public.appointments for update to authenticated
  using (tenant_id = (select private.current_tenant_id())) with check (tenant_id = (select private.current_tenant_id()));
create policy tenant_delete on public.appointments for delete to authenticated using (tenant_id = (select private.current_tenant_id()));
create policy active_profile_only on public.appointments as restrictive for all to authenticated
  using ((select private.current_tenant_id()) is not null) with check ((select private.current_tenant_id()) is not null);

-- Column grants: the app writes what the owner types; id, created_by, created_at and updated_at are the server's.
revoke all on public.appointments from anon, authenticated;
grant select on public.appointments to authenticated;
grant insert (tenant_id, kind, title, starts_at, ends_at, customer_id, job_id, notes) on public.appointments to authenticated;
grant update (kind, title, starts_at, ends_at, customer_id, job_id, notes) on public.appointments to authenticated;
grant delete on public.appointments to authenticated;

-- A job link implies its customer: the customer is filled in from the job, and may not name someone else.
create function private.appointments_check() returns trigger
language plpgsql set search_path = '' as $$
declare jc uuid;
begin
  if new.job_id is not null then
    select j.customer_id into jc from public.jobs j where j.id = new.job_id and j.tenant_id = new.tenant_id;
    if jc is not null then
      if new.customer_id is null then
        new.customer_id := jc;
      elsif new.customer_id <> jc then
        raise exception 'That job belongs to a different customer' using errcode = '23514';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    -- created_by may only become null (the person's login was deleted).
    if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or new.created_at is distinct from old.created_at
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      raise exception 'An appointment cannot be moved to another business' using errcode = '23000';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger appointments_check before insert or update on public.appointments
  for each row execute function private.appointments_check();
revoke all on function private.appointments_check() from public, anon, authenticated;

-- Booking or changing an appointment for a customer is activity on that customer: only ever extends retention.
create function private.touch_customer_from_appointment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is not null then
    update public.customers c set last_activity_at = now(),
      purge_at = greatest(c.purge_at, now() + make_interval(days => private.retention_days_for(c.tenant_id)))
    where c.id = new.customer_id and c.tenant_id = new.tenant_id;
  end if;
  return new;
end $$;
create trigger appointments_touch_customer after insert or update on public.appointments
  for each row execute function private.touch_customer_from_appointment();
revoke all on function private.touch_customer_from_appointment() from public, anon, authenticated;

-- 3. The purge and erasure lock set now includes appointments, last, ordered by id.
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
  perform 1 from public.appointments a where a.customer_id = any (p_customer_ids) or a.job_id = any (jids) order by a.id for update;
end $$;
revoke all on function private.lock_customer_tree(uuid[]) from public, anon, authenticated;
grant execute on function private.lock_customer_tree(uuid[]) to service_role;

-- 4. Appointments with no customer: removed once they ended longer ago than the business's retention period.
create function private.purge_unlinked_appointments(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with d as (
    delete from public.appointments a
    where a.customer_id is null
      and coalesce(a.ends_at, a.starts_at) < least(p_now, now()) - make_interval(days => private.retention_days_for(a.tenant_id))
    returning 1
  ) select count(*) into n from d;
  return n;
end $$;
revoke all on function private.purge_unlinked_appointments(timestamptz) from public, anon, authenticated;
grant execute on function private.purge_unlinked_appointments(timestamptz) to service_role;
