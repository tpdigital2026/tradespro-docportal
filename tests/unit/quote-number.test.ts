import { describe, expect, it } from 'vitest';
import { suggestNextNumber } from '../../src/lib/quote-number';

describe('suggestNextNumber', () => {
  it('suggests nothing without history', () => {
    expect(suggestNextNumber([])).toBe('');
    expect(suggestNextNumber(['no digits here'])).toBe('');
  });
  it('follows the newest number and keeps leading zeros', () => {
    expect(suggestNextNumber(['QT-0041', 'QT-0040'])).toBe('QT-0042');
    expect(suggestNextNumber(['FJC/2026/9'])).toBe('FJC/2026/10');
    expect(suggestNextNumber(['0099'])).toBe('0100');
    expect(suggestNextNumber(['A9'])).toBe('A10');
  });
  it('skips numbers already taken', () => {
    expect(suggestNextNumber(['QT-0003', 'QT-0004', 'QT-0001'])).toBe('QT-0005');
    expect(suggestNextNumber(['QT-0001', 'QT-0002', 'QT-0003'])).toBe('QT-0004');
    expect(suggestNextNumber(['QT-0001', 'QT-0002'])).toBe('QT-0003');
  });
  it('never suggests a number longer than the allowed 40 characters', () => {
    expect(suggestNextNumber(['x'.repeat(39) + '9']).length).toBeLessThanOrEqual(40);
  });
  it('ignores invoice and receipt numbers in the registry when suggesting a quote number', () => {
    expect(suggestNextNumber(['RCP-QT-0100-S2', 'INV-QT-0100-S2', 'QT-0100'])).toBe('QT-0101');
    expect(suggestNextNumber(['INV-QT-0100-D'])).toBe('');
  });
});
