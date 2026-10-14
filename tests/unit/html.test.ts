import { describe, expect, it } from 'vitest';
import { html, raw } from '../../src/lib/html';

describe('html', () => {
  it('escapes interpolated strings', () => {
    const evil = `<script>alert("x")</script> & 'q'`;
    expect(html`<p>${evil}</p>`.value).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>',
    );
  });
  it('escapes values placed in attributes', () => {
    expect(html`<img alt="${'a" onerror="x'}">`.value).toBe('<img alt="a&quot; onerror=&quot;x">');
  });
  it('does not double-escape nested html', () => {
    const inner = html`<b>${'a & b'}</b>`;
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>a &amp; b</b></p>');
  });
  it('flattens arrays of values', () => {
    const items = ['a', 'b'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe('<ul><li>a</li><li>b</li></ul>');
  });
  it('renders null, undefined and false as nothing', () => {
    expect(html`<p>${null}${undefined}${false}</p>`.value).toBe('<p></p>');
  });
  it('renders numbers', () => {
    expect(html`<p>${42}</p>`.value).toBe('<p>42</p>');
  });
  it('passes raw markup through untouched', () => {
    expect(html`<p>${raw('<br>')}</p>`.value).toBe('<p><br></p>');
  });
});
