import { describe, expect, it } from 'vitest';
import { coverHero, runningFooter, totalsBlock } from '../../src/templates/parts';
import { fakeBrand, fakeTenant } from '../fixtures/fake';

describe('runningFooter', () => {
  it('is not reserved by default', () => {
    expect(runningFooter(fakeTenant, 1, 2).value).not.toContain('data-reserved');
  });
  it('can be marked reserved so overlap is detected', () => {
    expect(runningFooter(fakeTenant, 1, 2, true).value).toContain('class="rf" data-reserved');
  });
  it('pads page numbers', () => {
    expect(runningFooter(fakeTenant, 1, 12).value).toContain('Page 01 / 12');
  });
});

describe('totalsBlock', () => {
  it('renders after-rows below the grand total, escaped', () => {
    const v = totalsBlock([['Subtotal', '£1.00']], 'Total', '£1.20', [['Balance <due>', '£0.50']]).value;
    expect(v.indexOf('class="grand"')).toBeLessThan(v.indexOf('class="row sub"'));
    expect(v).toContain('Balance &lt;due&gt;');
  });
  it('still works without after-rows', () => {
    expect(totalsBlock([], 'Total', '£1.20').value).not.toContain('row sub');
  });
});

describe('coverHero', () => {
  it('marks its content layer so clipped content is detected', () => {
    const v = coverHero(fakeTenant, fakeBrand, { eyebrow: 'e', title: 't', sub: 's', strip: [] }).value;
    expect(v).toContain('class="in" data-fit');
  });
});
