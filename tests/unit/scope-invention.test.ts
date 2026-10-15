import { describe, expect, it } from 'vitest';
import { findInventions } from '../../src/ai/invention';

const inv = (input: string[], output: string[]) => findInventions(input, output).map((i) => `${i.kind}:${i.word.toLowerCase()}`);

describe('findInventions', () => {
  it('lets the owner\'s own words, figures and plurals through', () => {
    expect(inv(['strip off 24 m2 of felt and fit 3 layers'], ['Strip off 24 m2 of felt.', 'Fit three layers.'])).toEqual([]);
    expect(inv(['remove the tile'], ['Remove the tiles.'])).toEqual([]);
  });
  it('catches a new number, in digits or in words, and a new sign', () => {
    expect(inv(['fit the roof'], ['Fit the roof in 2 days.'])).toContain('number:2');
    expect(inv(['fit the roof'], ['Fit the roof with twenty screws.'])).toContain('number:20');
    expect(inv(['fit the roof'], ['Fit the roof for £500.'])).toEqual(expect.arrayContaining(['number:500', 'number:£']));
    expect(inv(['fit the roof'], ['Fit it to 100% of the roof.'])).toContain('number:%');
  });
  it('treats a spoken number and its digits as the same number', () => {
    expect(inv(['fit two layers'], ['Fit 2 layers.'])).toEqual([]);
    expect(inv(['fit 2 layers'], ['Fit two layers.'])).toEqual([]);
  });
  it('catches products, materials and parts the owner did not mention', () => {
    expect(inv(['fit a new roof'], ['Fit a new roof using EPDM rubber and OSB boards.'])).toEqual(expect.arrayContaining(['product:epdm', 'product:rubber', 'product:osb']));
    expect(inv(['fit a new roof'], ['Replace the fascia and gutters.'])).toEqual(expect.arrayContaining(['product:fascia', 'product:gutters']));
  });
  it('catches units, guarantees, standards and marketing claims', () => {
    expect(inv(['fit a new roof'], ['Fit a roof 9mm thick.'])).toEqual(expect.arrayContaining(['number:9']));
    expect(inv(['fit a new roof'], ['Fit it with a lifetime guarantee.'])).toEqual(expect.arrayContaining(['claim:lifetime', 'claim:guarantee']));
    expect(inv(['fit a new roof'], ['Fit it to British standards.'])).toEqual(expect.arrayContaining(['claim:british', 'claim:standards']));
    expect(inv(['fit a new roof'], ['A durable, high quality finish.'])).toEqual(expect.arrayContaining(['claim:durable', 'claim:quality']));
    expect(inv(['fit a new roof'], ['Allow a year for it.'])).toContain('unit:year');
  });
  it('catches brand names and acronyms, but not a capital at the start of a sentence', () => {
    expect(inv(['fit tiles'], ['Fit Marley tiles.'])).toContain('name:marley');
    expect(inv(['fit tiles'], ['Fit tiles. Clear up.'])).toEqual([]);
    expect(inv(['fit tiles'], ['Fit tiles to BS 5534.'])).toEqual(expect.arrayContaining(['claim:bs', 'number:5534']));
    expect(inv(['fit Marley tiles'], ['Fit Marley tiles.'])).toEqual([]);
  });
  it('allows a close misspelling to be fixed, but not a new product word far from anything', () => {
    expect(inv(['fit the fasher boards'], ['Fit the fascia boards.'])).toContain('product:fascia');
    expect(inv(['fit the fascias'], ['Fit the fascia.'])).toEqual([]);
    expect(inv(['replace the guttering'], ['Replace the guttering.'])).toEqual([]);
    expect(inv(['strip the felt roff'], ['Strip the felt roof.'])).toEqual([]);
  });
  it('does not count "step 3" as a figure', () => {
    expect(inv(['fit the roof'], ['Kept step 3 as written.'])).toEqual([]);
  });
});
