-- 014_brand_images: the Home banner, the sign-in photo and the share card come from each business's brand kit, not
-- from code that names one business. New asset kinds, and a reader for the public brand images (service role only,
-- like private.public_brand). A business with none of these rows gets the plain TradesPro look.
--
-- The new enum values are only compared as text below, never used as enum literals in this transaction.
-- Rows are seeded by npm run db:seed (FJC: its banner and its van photo and card), not by this migration.

alter type public.asset_kind add value if not exists 'hero_image';
alter type public.asset_kind add value if not exists 'sign_in_photo';
alter type public.asset_kind add value if not exists 'share_card';

create function private.public_brand_images(p_slug text, p_tenant uuid) returns table (
  kind text, storage_path text, width int, height int, alt text
)
language sql stable security definer set search_path = '' as $$
  select distinct on (a.kind) a.kind::text, a.storage_path, a.width, a.height, a.alt
  from public.tenants t
  join public.brand_kits k on k.tenant_id = t.id
  join public.brand_assets a on a.brand_kit_id = k.id and a.tenant_id = t.id
  where ((p_slug is not null and t.slug = p_slug) or (p_slug is null and t.id = p_tenant))
    and a.kind::text in ('hero_image', 'sign_in_photo', 'share_card')
  order by a.kind, a.created_at desc
$$;
revoke all on function private.public_brand_images(text, uuid) from public, anon, authenticated;
grant execute on function private.public_brand_images(text, uuid) to service_role;
