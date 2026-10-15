import { z } from 'zod';
import { SCOPE_LIMITS } from './model';

/**
 * Wording a business keeps for each kind of job (job_types.scope_examples). Only suggestions: labels for the key
 * figures, headings, one-tap steps and a typical order of work. Never a price, a measurement, a brand or a guarantee,
 * and never inserted without a tap. Each business owns its own.
 */
const text = (max: number) => z.string().trim().min(1).max(max);

export const scopeExamplesSchema = z.strictObject({
  /** Default introduction for the cover. Editable. */
  intro: text(SCOPE_LIMITS.intro).optional(),
  /** Labels only, for the key figure cards. The owner types every value. */
  specLabels: z.array(text(SCOPE_LIMITS.specLabel)).max(12),
  headings: z.array(text(SCOPE_LIMITS.heading)).max(20),
  /** Groups of one-tap steps, shown under their heading. */
  starters: z.array(z.strictObject({ heading: text(SCOPE_LIMITS.heading), steps: z.array(text(SCOPE_LIMITS.step)).max(20) })).max(20),
  /** "Start from an example": a typical ordered sequence, to edit. */
  sequences: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        label: text(80),
        sections: z.array(z.strictObject({ heading: text(SCOPE_LIMITS.heading), steps: z.array(text(SCOPE_LIMITS.step)).min(1).max(SCOPE_LIMITS.stepsPerSection) })).min(1).max(SCOPE_LIMITS.sections),
      }),
    )
    .max(6),
});

export type ScopeExamples = z.infer<typeof scopeExamplesSchema>;

/** A stored value that does not fit is ignored rather than breaking the form. */
export function parseScopeExamples(raw: unknown): ScopeExamples | null {
  const r = scopeExamplesSchema.safeParse(raw);
  return r.success ? r.data : null;
}
