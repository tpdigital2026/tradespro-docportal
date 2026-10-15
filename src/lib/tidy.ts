/**
 * The tidy seam from the plan: free notes in, scope sections out. Deterministic for now (sentences to bullets, trims,
 * merges exact repeats, never adds a word); the AI plan replaces the body behind this same signature. The scope
 * builder's step boxes use the same tidy (src/lib/scope/tidy.ts), so both give identical results for the same words.
 */
import { makeItem } from './scope/items';
import { tidyItems, type Tidied } from './scope/tidy';
import { stripInvisible } from './scope/invisible';

/** Splits on line ends and on sentence ends (". " followed by a capital), never inside a number like 2.5. */
export function splitNotes(notes: string): string[] {
  return stripInvisible(notes)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.replace(/^[\s\-*•]+/, '').trim())
    .filter((s) => s !== '');
}

export async function tidyScope(notes: string): Promise<Tidied> {
  return tidyItems(splitNotes(notes).map((t) => makeItem('step', t)));
}
