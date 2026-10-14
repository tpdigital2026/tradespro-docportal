-- 007_vat_rate_cap: a business VAT rate above 25% is never valid (UK VAT tops out at 20%). The app refuses
-- to quote with a stored rate outside 0 to 2500 basis points, so the database now refuses to store one.
-- Checked before writing this: no existing row is above 2500.
alter table public.tenant_defaults add constraint tenant_defaults_vat_rate_max check (vat_rate_bp between 0 and 2500);
