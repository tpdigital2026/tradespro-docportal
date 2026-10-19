import { afterEach, describe, expect, it } from 'vitest';
import { types } from 'pg';
import { PG_TYPES, sqlDate } from '../../src/db/sql-date';

const ZONES = ['Europe/London', 'UTC', 'Pacific/Auckland', 'America/Los_Angeles'];
const before = process.env.TZ;
afterEach(() => {
  process.env.TZ = before;
});

// Summer (BST), winter, the clock-change days, year ends and a leap day.
const DATES = ['2026-07-01', '2026-01-15', '2026-03-29', '2026-10-25', '2026-12-31', '2027-01-01', '2028-02-29', '2000-01-01'];

describe('SQL dates come back as the same calendar day in every time zone', () => {
  for (const tz of ZONES) {
    it(`TZ=${tz}: node-postgres's default Date and the raw text both read back unchanged`, () => {
      process.env.TZ = tz;
      const defaultParser = types.getTypeParser(1082, 'text');
      for (const d of DATES) {
        const parsed = defaultParser(d);
        expect(parsed instanceof Date).toBe(true);
        expect(sqlDate(parsed), `${tz} ${d}`).toBe(d);
        expect(sqlDate(d)).toBe(d);
      }
    });
  }

  it('TZ=Europe/London: the old toISOString reading really did move a summer date a day early (guards the test)', () => {
    process.env.TZ = 'Europe/London';
    const parsed = types.getTypeParser(1082, 'text')('2026-07-01') as Date;
    expect(parsed.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('app connections parse DATE as the raw text and leave every other type to node-postgres', () => {
    expect(PG_TYPES.getTypeParser(1082, 'text')('2026-07-01')).toBe('2026-07-01');
    expect(PG_TYPES.getTypeParser(20, 'text')).toBe(types.getTypeParser(20, 'text'));
    expect(PG_TYPES.getTypeParser(1184, 'text')).toBe(types.getTypeParser(1184, 'text'));
  });

  it('junk is an empty string, a timestamp string keeps only its date', () => {
    expect(sqlDate(null)).toBe('');
    expect(sqlDate('soon')).toBe('');
    expect(sqlDate('2026-07-01T23:30:00+01:00')).toBe('2026-07-01');
  });
});
