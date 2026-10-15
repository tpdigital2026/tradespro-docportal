import { describe, expect, it } from 'vitest';
import { splitNotes, tidyScope } from '../../src/lib/tidy';

describe('tidyScope (deterministic seam)', () => {
  it('turns sentences and lines into bullets, trims, merges repeats, adds nothing', async () => {
    const r = await tidyScope('strip the old felt. Lay new boards\n- clear waste\n\nclear waste');
    expect(r.sections).toEqual([{ heading: 'The works', steps: ['Strip the old felt.', 'Lay new boards.', 'Clear waste.'] }]);
    expect(r.uncertain).toEqual([]);
    expect(r.corrections.join(' ')).toMatch(/Merged a repeated step/);
  });

  it('never splits inside a number and never invents words', async () => {
    expect(splitNotes('Fit 2.5 metres of trim. Done')).toEqual(['Fit 2.5 metres of trim.', 'Done']);
    const words = (s: string) => s.toLowerCase().match(/[a-z0-9.]+/g) ?? [];
    const input = 'replace fascia boards. paint soffits';
    const out = (await tidyScope(input)).sections.flatMap((s) => s.steps).join(' ');
    for (const w of words(out)) expect(words(input).some((x) => x.replace(/\.$/, '') === w.replace(/\.$/, ''))).toBe(true);
  });

  it('empty notes give no sections', async () => {
    expect((await tidyScope('  \n ')).sections).toEqual([]);
  });
});
