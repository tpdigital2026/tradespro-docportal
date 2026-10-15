import { describe, expect, it } from 'vitest';
import { sanitiseIncomingScope } from '../../src/lib/scope/approval';
import { COPY_TOO_OLD, emptyScope, sectionsKey, wordingEdited, type ScopeCopy } from '../../src/lib/scope/model';
import { COPY_TOO_OLD as SERVER_COPY } from '../../src/lib/data/scope';

const copy = (sections: ScopeCopy['sections'], genKey?: string): ScopeCopy => ({ sections, corrections: [], uncertain: [], engine: 'fallback', generatedAt: '2026-10-15T00:00:00Z', sourceKey: 'x', proof: 'p', genKey, approvedAt: null, approvalHash: null });

describe('scope follow-ups', () => {
  it('marks wording the owner changed after it was generated', () => {
    const s = [{ heading: 'The work', steps: ['Strip the roof.'] }];
    expect(wordingEdited(copy(s, sectionsKey(s)))).toBe(false);
    expect(wordingEdited(copy([{ heading: 'The work', steps: ['Strip the whole roof.'] }], sectionsKey(s)))).toBe(true);
    expect(wordingEdited(copy(s))).toBe(false);
    expect(wordingEdited(null)).toBe(false);
  });

  it('the screen and the server share one too-old message', () => {
    expect(COPY_TOO_OLD).toBe(SERVER_COPY);
  });

  it('discarding old notes is an explicit empty string; leaving the field out keeps them', () => {
    const stored = { ...emptyScope(), legacyOverflow: 'old notes' };
    expect(sanitiseIncomingScope({ ...emptyScope() }, stored, () => true).legacyOverflow).toBe('old notes');
    expect(sanitiseIncomingScope({ ...emptyScope(), legacyOverflow: '' }, stored, () => true).legacyOverflow).toBe('');
  });
});
