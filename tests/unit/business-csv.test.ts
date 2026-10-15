import { describe, expect, it } from 'vitest';
import { csvCell, pounds, toCsv } from '../../src/lib/business/csv';

/** A tiny RFC 4180 reader, so the tests check what a spreadsheet would see. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && t[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else cell += c;
  }
  return rows;
}

describe('CSV export', () => {
  it('neutralises formula injection: = + - @ tab and carriage return at the start', () => {
    for (const bad of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      const read = readCsv(`${csvCell(bad)}\r\n`)[0][0];
      expect(read.startsWith("'"), bad).toBe(true);
    }
    expect(readCsv(`${csvCell('Mr Smith')}\r\n`)[0][0]).toBe('Mr Smith');
    expect(readCsv(`${csvCell('a = b')}\r\n`)[0][0]).toBe('a = b');
  });

  it('quotes everything and doubles quotes, keeping commas and line breaks inside the cell', () => {
    const csv = toCsv(['A', 'B'], [['He said "hi", then left', 'line\nbreak'], [null, 12]]);
    expect(csv.startsWith('﻿"A","B"\r\n')).toBe(true);
    expect(readCsv(csv)).toEqual([['A', 'B'], ['He said "hi", then left', 'line\nbreak'], ['', '12']]);
  });

  it('property: no cell ever reads back starting with a formula character', () => {
    let s = 7;
    const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const chars = ['=', '+', '-', '@', '\t', '\r', '\n', '"', ',', 'a', ' ', '\u0000', '1'];
    for (let n = 0; n < 2000; n += 1) {
      const v = Array.from({ length: 1 + Math.floor(r() * 8) }, () => chars[Math.floor(r() * chars.length)]).join('');
      const back = readCsv(toCsv(['x'], [[v]]))[1][0];
      expect(/^[=+\-@\t\r]/.test(back), JSON.stringify(v)).toBe(false);
    }
  });

  it('writes money as plain pounds', () => {
    expect(pounds(123456)).toBe('1234.56');
    expect(pounds(5)).toBe('0.05');
  });
});
