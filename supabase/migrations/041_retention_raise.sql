-- 041_retention_raise: when an owner RAISES retention_days, customers already on file get the longer period too:
-- purge_at = greatest(purge_at, last_activity_at + new days). Never shortens (a lowered setting leaves existing dates
-- alone until something happens on the record). Service role only, tenant scoped; called by the server inside the same
-- transaction that saves the setting (src/lib/data/settings.ts setRetentionWith). Returns how many customers moved.
create function private.extend_purge_for_retention(p_tenant uuid, p_days int) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_days is null or p_days < 30 or p_days > 730 then
    raise exception 'Retention must be between 30 and 730 days' using errcode = '22023';
  end if;
  with u as (
    update public.customers c
       set purge_at = c.last_activity_at + make_interval(days => p_days)
     where c.tenant_id = p_tenant
       and c.purge_at < c.last_activity_at + make_interval(days => p_days)
    returning 1
  ) select count(*) into n from u;
  return n;
end $$;
revoke all on function private.extend_purge_for_retention(uuid, int) from public, anon, authenticated;
grant execute on function private.extend_purge_for_retention(uuid, int) to service_role;
