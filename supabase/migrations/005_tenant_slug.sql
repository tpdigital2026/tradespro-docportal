-- 005_tenant_slug: each business gets a short public sign-in address (/fjc) and the app can read the
-- public face of a business (name, accent, logos) without a user session. Branding on the sign-in page
-- is public by design and carries nothing about users.

alter table public.tenants add column slug text;
alter table public.tenants add constraint tenants_slug_format
  check (slug is null or (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and slug !~ '--'));
alter table public.tenants add constraint tenants_slug_not_reserved
  check (slug is null or slug <> all (array['login','api','admin','customers','documents','dev','_next','s','static','public','favicon','robots','sitemap']));
create unique index tenants_slug_key on public.tenants (slug) where slug is not null;

-- FJC is the first branded business.
update public.tenants set slug = 'fjc' where name = 'FJC Roofing Ltd' and slug is null;

-- Its two real logo files are served from /brands/fjc/ in the app's own public folder until storage buckets exist.
insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path, width, height, alt)
select k.tenant_id, k.id, v.kind::public.asset_kind, k.tenant_id::text || '/' || v.file, 1036, 439, 'FJC Roofing logo'
from public.brand_kits k
join public.tenants t on t.id = k.tenant_id and t.slug = 'fjc'
cross join (values ('logo_colour', 'logo.png'), ('logo_white', 'logo_white.png')) as v(kind, file)
where not exists (select 1 from public.brand_assets a where a.brand_kit_id = k.id and a.kind = v.kind::public.asset_kind);

-- The public face of one business, by slug or by id. Service role only: the app calls these on its
-- own server connection and never exposes the tenant id. Returns no row for an unknown slug.
create function private.public_brand(p_slug text, p_tenant uuid) returns table (
  tenant_id uuid, slug text, name text, accent text,
  logo_colour_path text, logo_colour_w int, logo_colour_h int,
  logo_white_path text, logo_white_w int, logo_white_h int
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.slug, t.name,
    case when jsonb_typeof(k.colours -> 'accent') = 'string' then k.colours ->> 'accent'
         when jsonb_typeof(k.colours -> 'blue') = 'string' then k.colours ->> 'blue' end,
    c.storage_path, c.width, c.height, w.storage_path, w.width, w.height
  from public.tenants t
  left join public.brand_kits k on k.tenant_id = t.id
  left join lateral (select a.* from public.brand_assets a where a.brand_kit_id = k.id and a.kind = 'logo_colour' order by a.created_at desc limit 1) c on true
  left join lateral (select a.* from public.brand_assets a where a.brand_kit_id = k.id and a.kind = 'logo_white' order by a.created_at desc limit 1) w on true
  where (p_slug is not null and t.slug = p_slug) or (p_slug is null and t.id = p_tenant)
$$;
revoke all on function private.public_brand(text, uuid) from public, anon, authenticated;
grant execute on function private.public_brand(text, uuid) to service_role;
