-- 031_appointment_retention: appointments never outlive (or get purged before) the dates they are for.
--   1. Booking or moving an appointment keeps its customer until the business's retention period after the
--      appointment itself: purge_at = greatest(existing, now() + retention, coalesce(ends_at, starts_at) + retention).
--      Only ever extends. Runs on insert and on update (including a change of start or end).
--   2. Appointments with no customer hold free text the owner typed. Their clock is the latest of created_at,
--      updated_at and the appointment's own end (or start), plus the business's retention_days.
--      private.purge_unlinked_appointments(now) deletes those past it. Service role only: it must be called by the
--      maintenance run (the scheduled purge job), in the same way as the customer purge.

create or replace function private.touch_customer_from_appointment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is not null then
    update public.customers c set last_activity_at = now(),
      purge_at = greatest(
        c.purge_at,
        now() + make_interval(days => private.retention_days_for(c.tenant_id)),
        coalesce(new.ends_at, new.starts_at) + make_interval(days => private.retention_days_for(c.tenant_id))
      )
    where c.id = new.customer_id and c.tenant_id = new.tenant_id;
  end if;
  return new;
end $$;
revoke all on function private.touch_customer_from_appointment() from public, anon, authenticated;

create or replace function private.purge_unlinked_appointments(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with d as (
    delete from public.appointments a
    where a.customer_id is null
      and greatest(a.created_at, a.updated_at, coalesce(a.ends_at, a.starts_at))
          + make_interval(days => private.retention_days_for(a.tenant_id)) < least(p_now, now())
    returning 1
  ) select count(*) into n from d;
  return n;
end $$;
revoke all on function private.purge_unlinked_appointments(timestamptz) from public, anon, authenticated;
grant execute on function private.purge_unlinked_appointments(timestamptz) to service_role;
