import { describe, expect, it } from 'vitest';
import { TRADESPRO_BRAND, brandFromRow, brandStyle, contrastRatio, isValidSlug, logoFromPath, planAccent } from '../../src/lib/brand';

const T = '11111111-1111-1111-1111-111111111111';
const row = (o: Record<string, unknown> = {}) => ({
  tenant_id: T, slug: 'fjc', name: 'FJC Roofing Ltd', accent: '#2f6fbf',
  logo_colour_path: `${T}/logo.png`, logo_colour_w: 1036, logo_colour_h: 439,
  logo_white_path: `${T}/logo_white.png`, logo_white_w: 1036, logo_white_h: 439, ...o,
}) as Parameters<typeof brandFromRow>[0];
const yes = () => true;

describe('slugs', () => {
  it.each(['fjc', 'top-choice', 'g-scott', 'a1b'])('accepts %s', (s) => expect(isValidSlug(s)).toBe(true));
  it.each(['login', 'api', 'admin', 'customers', 'documents', 'dev', '_next', 's', 'FJC', 'a', '-ab', 'ab-', 'a--b', 'a b', '../x', '', 'x'.repeat(41)])('rejects %j', (s) => expect(isValidSlug(s)).toBe(false));
});

describe('accent', () => {
  it('uses a business colour that passes AA on white for text and fills', () => {
    expect(planAccent('#2f6fbf')).toMatchObject({ fill: '#2f6fbf', ink: '#2f6fbf', onFill: '#ffffff' });
  });
  it('keeps a mid colour for fills only when it fails AA for text', () => {
    const p = planAccent('#0b9bea')!; // 3.05:1 on white
    expect(p.fill).toBe('#0b9bea');
    expect(p.ink).toBeNull();
  });
  it('drops a colour too faint to be a fill', () => {
    expect(planAccent('#f5d742')).toBeNull();
    expect(planAccent('#ffffff')).toBeNull();
  });
  it.each(['red', '#fff', '#12345', '#12345g', 'url(x)', '#2f6fbf;background:red', 'expression(1)', 123, null, undefined])('rejects %j', (v) => expect(planAccent(v)).toBeNull());
  it('only ever sets three variables, from validated hex', () => {
    const b = brandFromRow(row({ accent: '#2f6fbf' }), yes);
    expect(Object.keys(brandStyle(b)!).sort()).toEqual(['--accent', '--accent-ink', '--on-accent']);
    expect(brandStyle(TRADESPRO_BRAND)).toBeUndefined();
    expect(brandStyle(brandFromRow(row({ accent: 'red;x:y' }), yes))).toBeUndefined();
  });
  it('measures contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});

describe('logo paths', () => {
  it('maps a stored path inside the tenant prefix to our own public folder', () => {
    expect(logoFromPath('fjc', T, `${T}/logo.png`, 1036, 439, yes)).toEqual({ url: '/brands/fjc/logo.png', width: 1036, height: 439 });
  });
  it.each([`${T}/../x.png`, `other/logo.png`, `${T}/a/b.png`, `${T}/logo.exe`, `${T}/lo go.png`, 'https://evil.test/x.png', `${T}/%2e%2e.png`, `${T}/x.png?y`, 7, null])('refuses %j', (p) => {
    expect(logoFromPath('fjc', T, p, 10, 10, yes)).toBeNull();
  });
  it('refuses silly dimensions and missing files', () => {
    expect(logoFromPath('fjc', T, `${T}/logo.png`, 0, 10, yes)).toBeNull();
    expect(logoFromPath('fjc', T, `${T}/logo.png`, 99999, 10, yes)).toBeNull();
    expect(logoFromPath('fjc', T, `${T}/logo.png`, 10, 10, () => false)).toBeNull();
  });
});

describe('brandFromRow', () => {
  it('builds a business brand', () => {
    const b = brandFromRow(row(), yes);
    expect(b).toMatchObject({ name: 'FJC Roofing Ltd', slug: 'fjc', accent: '#2f6fbf', isOwnBrand: false });
    expect(b.logoLight?.url).toBe('/brands/fjc/logo.png');
    expect(b.logoDark.url).toBe('/brands/fjc/logo_white.png');
  });
  it('falls back to TradesPro for no row, a bad name or no slug', () => {
    expect(brandFromRow(undefined)).toBe(TRADESPRO_BRAND);
    expect(brandFromRow(row({ name: '   ' }), yes)).toBe(TRADESPRO_BRAND);
    const noSlug = brandFromRow(row({ slug: null }), yes);
    expect(noSlug.logoLight).toBeNull();
    expect(noSlug.logoDark).toEqual(TRADESPRO_BRAND.logoDark);
  });
  it('a business with no assets yet keeps the TradesPro mark and no light logo', () => {
    const b = brandFromRow(row({ logo_colour_path: null, logo_white_path: null }), yes);
    expect(b.logoLight).toBeNull();
    expect(b.logoDark).toEqual(TRADESPRO_BRAND.logoDark);
  });
  it('strips control characters from the name', () => {
    expect(brandFromRow(row({ name: 'A\u0000B\nC' }), yes).name).toBe('ABC');
  });
});
