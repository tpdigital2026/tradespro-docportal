-- 010_scope_examples: each business keeps its own scope-of-works wording per kind of job.
--
-- scope_examples is a json object of suggestions only (see src/lib/scope/examples.ts): the default cover
-- introduction, labels for the key figure cards, headings, one-tap steps and typical orders of work. Wording
-- data, owned by the business: never a price, a measurement, a brand or a guarantee. The app only reads it;
-- the FJC rows are filled by `npm run db:seed` from src/lib/scope/fjc-examples.ts.
alter table public.job_types add column scope_examples jsonb;

alter table public.job_types
  add constraint job_types_scope_examples_shape
  check (scope_examples is null or (jsonb_typeof(scope_examples) = 'object' and pg_column_size(scope_examples) <= 32768));
