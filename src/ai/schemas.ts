import { z } from 'zod';
import { SCOPE_LIMITS } from '../lib/scope/model';

const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (max: number) => z.string().trim().min(1).max(max).refine((v) => !CONTROL.test(v), 'control characters');

/** What the model must send back. Anything else is refused. */
export const scopeCopyResponseSchema = z.object({
  sections: z
    .array(z.object({ heading: text(SCOPE_LIMITS.heading), steps: z.array(text(SCOPE_LIMITS.step)).min(1).max(SCOPE_LIMITS.stepsPerSection) }))
    .min(1)
    .max(SCOPE_LIMITS.sections + 1),
  corrections: z.array(text(SCOPE_LIMITS.step)).max(SCOPE_LIMITS.notes),
  uncertain: z.array(text(SCOPE_LIMITS.step)).max(SCOPE_LIMITS.notes),
});
export type ScopeCopyResponse = z.infer<typeof scopeCopyResponseSchema>;

/** Models sometimes wrap JSON in a code fence or add a sentence. Take the outermost object. */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}
