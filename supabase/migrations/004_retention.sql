-- 004_retention: how long customer data is kept is a per-business setting (30 to 730 days, default 90),
-- not a fixed 30 days. Existing rows are never shortened: every touch only extends (greatest).

alter table public.tenant_defaults
  add column retention_days int not null default 90 check (retention_days between 30 and 730);

-- One place that answers "how many days for this business". 90 when the business has no defaults row.
create function private.retention_days_for(p_tenant uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select d.retention_days from public.tenant_defaults d where d.tenant_id = p_tenant), 90)
$$;
revoke all on function private.retention_days_for(uuid) from public, anon, authenticated;
grant execute on function private.retention_days_for(uuid) to service_role;

-- New customers: the column default cannot read another table, so it becomes a sentinel that a
-- before-insert trigger replaces. An explicit purge_at (server or test) is left as given.
alter table public.customers alter column purge_at set default '-infinity'::timestamptz;
create function private.set_customer_purge_at() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purge_at = '-infinity'::timestamptz then
    new.purge_at := now() + make_interval(days => private.retention_days_for(new.tenant_id));
  end if;
  return new;
end $$;
create trigger customers_set_purge_at before insert on public.customers
  for each row execute function private.set_customer_purge_at();
revoke all on function private.set_customer_purge_at() from public, anon, authenticated;

-- The four touch triggers (job, document, version, photo) now read the business's setting and only extend.
create or replace function private.touch_customer_from_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(),
    purge_at = greatest(c.purge_at, now() + make_interval(days => private.retention_days_for(c.tenant_id)))
  where c.id = new.customer_id and c.tenant_id = new.tenant_id;
  return new;
end $$;

create or replace function private.touch_customer_from_document() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(),
    purge_at = greatest(c.purge_at, now() + make_interval(days => private.retention_days_for(c.tenant_id)))
  from public.jobs j
  where j.id = new.job_id and j.tenant_id = new.tenant_id and c.id = j.customer_id and c.tenant_id = j.tenant_id;
  return new;
end $$;

create or replace function private.touch_customer_from_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(),
    purge_at = greatest(c.purge_at, now() + make_interval(days => private.retention_days_for(c.tenant_id)))
  from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
  where d.id = new.document_id and d.tenant_id = new.tenant_id and c.id = j.customer_id and c.tenant_id = j.tenant_id;
  return new;
end $$;

create or replace function private.touch_customer_from_photo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.customers c set last_activity_at = now(),
    purge_at = greatest(c.purge_at, now() + make_interval(days => private.retention_days_for(c.tenant_id)))
  from public.jobs j
  where j.id = new.job_id and j.tenant_id = new.tenant_id and c.id = j.customer_id and c.tenant_id = j.tenant_id;
  return new;
end $$;

-- "Keep for another N days" from the owner's screen. The app role has no write grant on purge_at,
-- so the server calls this on a service connection after checking the session. Tenant scoped:
-- returns the new purge date, or null when the customer is not in that business.
create function private.extend_customer_retention(p_tenant uuid, p_customer uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare result timestamptz;
begin
  update public.customers c set last_activity_at = now(),
    purge_at = greatest(c.purge_at, now() + make_interval(days => private.retention_days_for(c.tenant_id)))
  where c.id = p_customer and c.tenant_id = p_tenant
  returning c.purge_at into result;
  return result;
end $$;
revoke all on function private.extend_customer_retention(uuid, uuid) from public, anon, authenticated;
grant execute on function private.extend_customer_retention(uuid, uuid) to service_role;
