import { describe, expect, it } from 'vitest';
import { loadBaseCss, themeVarsCss } from '../../src/themes/theme';

describe('themeVarsCss', () => {
  it('emits CSS variables for each colour', () => {
    expect(themeVarsCss({ navy: '#0f2b4a', gold: '#C9A24B' })).toBe(':root{--navy:#0f2b4a;--gold:#C9A24B;}');
  });
  it('rejects values that are not 6-digit hex colours', () => {
    expect(() => themeVarsCss({ navy: 'red;}body{display:none' })).toThrow();
    expect(() => themeVarsCss({ navy: '#fff' })).toThrow();
  });
  it('rejects unsafe variable names', () => {
    expect(() => themeVarsCss({ 'na vy': '#0f2b4a' })).toThrow();
  });
});

describe('loadBaseCss', () => {
  it('loads the FJC stylesheet', () => {
    expect(loadBaseCss()).toContain('.scope-sec');
  });
});
