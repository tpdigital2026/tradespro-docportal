/**
 * CSV for spreadsheets, safe against formula injection. Pure.
 *
 * A cell that starts with = + - @ (or a tab or carriage return, which some spreadsheets strip before reading a formula)
 * gets a single quote in front, so Excel, Numbers and Google Sheets show it as text and never run it. Every cell is
 * quoted, quotes inside are doubled, and rows end with CRLF (RFC 4180). The file starts with a UTF-8 byte order mark so
 * Excel reads the pound sign correctly.
 */

const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Line breaks inside a cell are kept inside the quotes; NUL and other control characters are dropped.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (DANGEROUS.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Pence as plain pounds for a spreadsheet: 123456 -> "1234.56". Never negative here. */
export function pounds(pence: number): string {
  const abs = Math.abs(pence);
  return `${pence < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
