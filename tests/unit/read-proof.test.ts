import { describe, expect, it } from 'vitest';
import { allPagesRead, contentKey, readToken } from '../../src/lib/documents/read-proof';

const secret = 'x'.repeat(40);
const scope = { tenantId: 't', userId: 'u', documentId: 'd', versionId: 'v', key: 'k'.repeat(32) };

describe('read proof', () => {
  it('needs a valid token for every page', () => {
    const all = [1, 2, 3].map((p) => readToken(secret, scope, p));
    expect(allPagesRead(secret, scope, 3, all)).toBe(true);
    expect(allPagesRead(secret, scope, 3, all.slice(0, 2))).toBe(false);
    expect(allPagesRead(secret, scope, 3, [all[0], all[0], all[1]])).toBe(false);
  });

  it('refuses tokens for another person, version, content or secret, and junk', () => {
    const t = [1, 2].map((p) => readToken(secret, scope, p));
    expect(allPagesRead(secret, { ...scope, userId: 'other' }, 2, t)).toBe(false);
    expect(allPagesRead(secret, { ...scope, versionId: 'v2' }, 2, t)).toBe(false);
    expect(allPagesRead(secret, { ...scope, key: 'z'.repeat(32) }, 2, t)).toBe(false);
    expect(allPagesRead('y'.repeat(40), scope, 2, t)).toBe(false);
    expect(allPagesRead(secret, scope, 2, [42, null, 'r1.1.abc', {}])).toBe(false);
    // A token for page 1 cannot be relabelled as page 2.
    const forged = t[0].replace('r1.1.', 'r1.2.');
    expect(allPagesRead(secret, scope, 2, [t[0], forged])).toBe(false);
  });

  it('content keys change with any change to the content', () => {
    expect(contentKey(secret, '{"a":1}', 't1')).not.toBe(contentKey(secret, '{"a":2}', 't1'));
    expect(contentKey(secret, '{"a":1}', 't1')).not.toBe(contentKey(secret, '{"a":1}', 't2'));
    expect(contentKey(secret, '{"a":1}', 't1')).toMatch(/^[0-9a-f]{32}$/);
  });
});
