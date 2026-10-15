import { describe, expect, it } from 'vitest';
import { initials } from '../../src/lib/initials';

describe('initials', () => {
  it('takes the first and last word and skips a title', () => {
    expect(initials('Mr John Smith')).toBe('JS');
    expect(initials('Mrs Jane Example')).toBe('JE');
    expect(initials('Demo Owner')).toBe('DO');
    expect(initials('Alfie')).toBe('A');
    expect(initials('Mr')).toBe('M');
    expect(initials('  ')).toBe('?');
    expect(initials('dr. ray pretend')).toBe('RP');
  });
});
