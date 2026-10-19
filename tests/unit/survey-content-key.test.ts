import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/survey/map', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/survey/map')>()),
  mapSurvey: () => ({ ok: true, input: { number: 'S-1', findings: [], coverPhoto: null } }),
}));

import { prepareLoaded } from '../../src/lib/documents/finalise';
import type { Loaded } from '../../src/lib/documents/facts-sql';

const SECRET = 'test-secret-test-secret-test-secret';
const brand = (logo: string) => ({ assets: { logoWhite: logo }, theme: { accent: '#0b9bea' } });
function loaded(name: string, logo: string): Loaded {
  return {
    head: { type: 'survey' },
    problems: [],
    survey: {},
    business: { tenant: { name, ownerName: 'Owner' }, wording: { survey: {} } },
    brand: brand(logo),
  } as unknown as Loaded;
}
const key = (l: Loaded) => {
  const p = prepareLoaded(l, SECRET);
  if (!p.ok) throw new Error('not ok');
  return p.key;
};

describe('survey content key', () => {
  it('is steady for the same survey, business and brand', () => {
    expect(key(loaded('FJC Roofing', 'logo-a'))).toBe(key(loaded('FJC Roofing', 'logo-a')));
  });

  it('changes when the business name changes, so stored preview pages and the read proof no longer match', () => {
    expect(key(loaded('FJC Roofing', 'logo-a'))).not.toBe(key(loaded('FJC Roofing Ltd', 'logo-a')));
  });

  it('changes when the logo changes', () => {
    expect(key(loaded('FJC Roofing', 'logo-a'))).not.toBe(key(loaded('FJC Roofing', 'logo-b')));
  });
});
