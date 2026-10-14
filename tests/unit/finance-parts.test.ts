import { describe, expect, it } from 'vitest';
import { html } from '../../src/lib/html';
import {
  compactGuaranteeBand,
  dueBox,
  financeFooter,
  financeHeader,
  financePage,
  partyBlock,
  payCard,
} from '../../src/templates/finance-parts';
import { bank, customer } from '../fixtures/common';
import { fakeBrand, fakeTenant } from '../fixtures/fake';

describe('financeHeader', () => {
  it('shows the title, business contact lines and meta rows', () => {
    const v = financeHeader(fakeTenant, fakeBrand, 'Deposit Invoice', [['Date', '07/10/2026'], ['Invoice no.', 'INV-JS-001-D']]).value;
    expect(v).toContain('<h1>Deposit Invoice</h1>');
    expect(v).toContain('Company No. 13855379');
    expect(v).toContain('<span>Invoice no.</span><span>INV-JS-001-D</span>');
  });
  it('escapes meta values', () => {
    expect(financeHeader(fakeTenant, fakeBrand, 'T', [['Ref', '<b>x</b>']]).value).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('partyBlock', () => {
  it('lists each address line, then email and phone', () => {
    const v = partyBlock('Invoice for', customer).value;
    expect(v).toContain('Invoice for');
    expect(v).toContain('123 Bromley Road<br>Bromley<br>BR2 8BG<br>');
    expect(v).toContain('john.smith@example.com · 07700 900123');
  });
  it('escapes the customer name', () => {
    expect(partyBlock('x', { ...customer, name: '<script>1</script>' }).value).not.toContain('<script>');
  });
});

describe('dueBox', () => {
  it('shows the label, amount and note', () => {
    const v = dueBox('Total due today', '£988.20', 'Payable before works start').value;
    expect(v).toContain('Total due today');
    expect(v).toContain('£988.20');
    expect(v).toContain('Payable before works start');
  });
});

describe('payCard', () => {
  it('shows every bank field and the reference', () => {
    const v = payCard(bank, 'INV-JS-001-D').value;
    for (const s of ['Metro Bank', 'FJC Roofing Ltd', '00-00-00', '00000000', 'INV-JS-001-D']) expect(v).toContain(s);
  });
  it('escapes bank fields', () => {
    expect(payCard({ ...bank, bankName: 'A<B' }, 'r').value).toContain('A&lt;B');
  });
});

describe('compactGuaranteeBand', () => {
  it('shows the years and the supplied text', () => {
    const v = compactGuaranteeBand(25, 'The roofing system is covered.').value;
    expect(v).toContain('25<small>Year</small>');
    expect(v).toContain('The roofing system is covered.');
  });
});

describe('financeFooter and financePage', () => {
  it('footer is a reserved box with tagline and website', () => {
    const v = financeFooter(fakeTenant).value;
    expect(v).toContain('class="ffoot" data-reserved');
    expect(v).toContain(fakeTenant.web);
  });
  it('wraps header, body and footer in a page', () => {
    const v = financePage(html`<div id="h"></div>`, html`<p>in</p>`, html`<div id="f"></div>`).value;
    expect(v).toBe('<section class="page"><div id="h"></div><div class="fbody"><p>in</p></div><div id="f"></div></section>');
  });
});
