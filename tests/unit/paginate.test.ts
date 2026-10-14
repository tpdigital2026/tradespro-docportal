import { describe, expect, it } from 'vitest';
import { PaginationError, paginate } from '../../src/pdf/paginate';

describe('paginate', () => {
  it('keeps everything on one page when it fits', () => {
    expect(paginate([100, 200, 300], { first: 700, rest: 900 })).toEqual([[0, 1, 2]]);
  });
  it('moves items to the next page when the first is full', () => {
    expect(paginate([400, 400, 400], { first: 900, rest: 900 })).toEqual([[0, 1], [2]]);
  });
  it('uses the larger "rest" capacity after the first page', () => {
    expect(paginate([500, 500, 500, 300], { first: 600, rest: 1000 })).toEqual([[0], [1, 2], [3]]);
  });
  it('returns one empty page for no items', () => {
    expect(paginate([], { first: 600, rest: 900 })).toEqual([[]]);
  });
  it('throws when one item is taller than a page', () => {
    expect(() => paginate([100, 1000], { first: 600, rest: 900 })).toThrow(PaginationError);
  });
  it('throws when the first item cannot fit the first page', () => {
    expect(() => paginate([700], { first: 600, rest: 900 })).toThrow(PaginationError);
  });
  it('throws on an invalid height', () => {
    expect(() => paginate([Number.NaN], { first: 600, rest: 900 })).toThrow(PaginationError);
  });
});
