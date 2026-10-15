import { describe, expect, it } from 'vitest';
import { findInventions } from '../../src/ai/invention';
import { CLAIM_WORDS } from '../../src/ai/vocab/claims';
import { NUMBER_WORDS } from '../../src/ai/vocab/numbers';
import { PRODUCT_WORDS } from '../../src/ai/vocab/products';
import { UNIT_WORDS } from '../../src/ai/vocab/units';
import { hasInvisible, stripInvisible } from '../../src/lib/scope/invisible';
import { cleanLine } from '../../src/lib/scope/model';

const inv = (input: string[], output: string[]) => findInventions(input, output).map((i) => `${i.kind}:${i.word.toLowerCase()}`);
const base = ['fit a new roof'];

describe('invisible characters', () => {
  const SOFT = '­';
  it('strips format and default-ignorable characters', () => {
    for (const ch of ['­', '​', '‌', '‍', '‎', '‏', '‪', '‮', '⁠', '⁦', '﻿', '͏', '᠎', '️', 'ㅤ', '\u{E0041}']) {
      expect(hasInvisible(`a${ch}b`), ch.codePointAt(0)!.toString(16)).toBe(true);
      expect(stripInvisible(`a${ch}b`)).toBe('ab');
    }
    expect(hasInvisible('plain text, with £ and é')).toBe(false);
  });
  it('a word split by an invisible character is still caught, and the output is refused for carrying it', () => {
    const r = inv(base, [`Fit it with a gua${SOFT}rantee.`]);
    expect(r).toContain('claim:guarantee');
    expect(r).toContain('hidden:hidden character');
    for (const ch of ['​', '‍', '‎', '⁠', '﻿']) {
      expect(inv(base, [`Fit a gua${ch}rantee.`]), ch.codePointAt(0)!.toString(16)).toContain('claim:guarantee');
      expect(inv(base, [`Use fe${ch}lt.`])).toContain('product:felt');
      expect(inv(base, [`Fit ${'2'}${ch}5 tiles.`]).join()).toContain('hidden');
    }
  });
  it('hidden characters in what the owner typed are removed before the comparison', () => {
    // the owner's "fel​t" is the word felt; the AI's plain "felt" is theirs
    expect(inv([`strip the fel​t`], ['Strip the felt.'])).toEqual([]);
    expect(inv([`fit a gua${SOFT}rantee`], ['Fit a guarantee.'])).toEqual([]);
  });
  it('is stripped from the owner\'s lines wherever they are cleaned for showing', () => {
    expect(cleanLine(`Fit${'​'} the ro${SOFT}of`)).toBe('Fit the roof');
  });
});

describe('the vocabularies, word by word', () => {
  const claimsAsked = ['waterproof', 'weatherproof', 'certificate', 'accreditation', 'accredited', 'registered', 'kitemark', 'fensa', 'regs', 'regulations', 'forever', 'permanent', 'professional', 'expert'];
  it.each(claimsAsked)('claim: %s', (w) => {
    expect(inv(base, [`Fit it, ${w}.`])).toContain(`claim:${w}`);
  });
  it.each([
    ['waterproofed', 'waterproofed'], ['waterproofing', 'waterproofing'], ['weatherproofing', 'weatherproofing'], ['certificates', 'certificates'],
    ['certified', 'certified'], ['accredit', 'accredit'], ['registering', 'registering'], ['experts', 'experts'], ['expertly', 'expertly'],
    ['professionals', 'professionals'], ['professionally', 'professionally'], ['permanently', 'permanently'],
  ])('claim forms: %s', (w) => {
    expect(inv(base, [`Fit it ${w}.`]).some((x) => x.startsWith('claim:'))).toBe(true);
  });
  it('building regs and building regulations', () => {
    expect(inv(base, ['Fit to building regs.'])).toContain('claim:regs');
    expect(inv(base, ['Fit to building regulations.'])).toContain('claim:regulations');
  });
  it.each(['decades', 'annual', 'annually'])('time word: %s', (w) => {
    expect(inv(base, [`Fit it, ${w}.`]).some((x) => x.startsWith('unit:'))).toBe(true);
  });
  it('ordinals used as durations', () => {
    expect(inv(base, ['Fit it in the second year.'])).toEqual(expect.arrayContaining(['number:2', 'unit:year']));
    expect(inv(base, ['A third year of cover.'])).toEqual(expect.arrayContaining(['number:3', 'unit:year']));
    expect(inv(['fit it in the second year'], ['Fit it in the second year.'])).toEqual([]);
  });
  const products = ['painted', 'insulated', 'insulation', 'guttering', 'glazed', 'plastered', 'torch-on', 'sheeting', 'lintel', 'lintels', 'silicone', 'PIR'];
  it.each(products)('product form: %s', (w) => {
    expect(inv(base, [`Fit the ${w}.`]).some((x) => x.startsWith('product:'))).toBe(true);
  });
  it('more forms of listed products', () => {
    for (const w of ['slated', 'tiling', 'nailed', 'screwed', 'rendering', 'plasterer', 'painters', 'insulating', 'glazing', 'gutters']) {
      expect(inv(base, [`Do the ${w}.`]).some((x) => x.startsWith('product:')), w).toBe(true);
    }
  });
  it('look-alikes stay different: no fuzzy matching crept back in', () => {
    expect(inv(['do it after lunch'], ['Replace the rafters.'])).toContain('product:rafters');
    expect(inv(['do the work'], ['Do it after lunch.'])).toEqual([]);
    expect(inv(['fit a joint'], ['Replace the joists.'])).toContain('product:joists');
    expect(inv(['do the work'], ['Make a joint.'])).toEqual([]);
    expect(inv(['do the work'], ['Point the wall.'])).toEqual([]);
    expect(inv(['do the work'], ['Pointed brickwork.']).some((x) => x.startsWith('product:paint'))).toBe(false);
    expect(inv(['cross the bridge'], ['Repair the ridge.'])).toContain('product:ridge');
    expect(inv(['do the work'], ['Cross the bridge.'])).toEqual([]);
    expect(inv(['replace the slats'], ['Replace the slate.'])).toContain('product:slate');
    expect(inv(['do the work'], ['Replace the slats.'])).toEqual([]);
    expect(inv(['the steep pitch'], ['Fit steel.'])).toContain('product:steel');
    expect(inv(['do the work'], ['The steep pitch.'])).toEqual([]);
  });
  it('the owner\'s word unlocks only itself and its plural, never a derived form', () => {
    expect(inv(['paint the door'], ['Paint the door.'])).toEqual([]);
    expect(inv(['paint the doors'], ['Paint the door.'])).toEqual([]);
    // "slated" in another sense does not unlock the product slate
    expect(inv(['the job is slated for monday'], ['Strip the slate.'])).toContain('product:slate');
    // the safe direction: an owner's "insulation" does not unlock "insulate"
    expect(inv(['fit insulation'], ['Insulate the roof.'])).toContain('product:insulate');
  });
  it('every listed word is caught when the owner did not write it', () => {
    for (const w of PRODUCT_WORDS) expect(inv(['do the work'], [`Use ${w}.`]).some((x) => x.startsWith('product:') || x.startsWith('claim:') || x.startsWith('unit:')), w).toBe(true);
    for (const w of UNIT_WORDS) expect(inv(['do the work'], [`Allow ${w}.`]).some((x) => x.startsWith('unit:') || x.startsWith('product:') || x.startsWith('claim:')), w).toBe(true);
    for (const w of CLAIM_WORDS) expect(inv(['do the work'], [`It is ${w}.`]).some((x) => x.startsWith('claim:') || x.startsWith('unit:') || x.startsWith('product:') || x.startsWith('name:')), w).toBe(true);
    for (const [w] of Object.entries(NUMBER_WORDS)) expect(inv(['do the work'], [`Fit ${w} of them.`]).some((x) => x.startsWith('number:')), w).toBe(true);
  });
  it('the required words are really in the data files', () => {
    const has = (list: readonly string[], ...ws: string[]) => ws.forEach((w) => expect(list, w).toContain(w));
    has(CLAIM_WORDS, 'waterproof', 'weatherproof', 'certificate', 'accreditation', 'accredited', 'registered', 'kitemark', 'fensa', 'regs', 'forever', 'permanent', 'professional', 'expert');
    has(UNIT_WORDS, 'decade', 'annual', 'annually');
    has(PRODUCT_WORDS, 'lintel', 'silicone', 'pir', 'torch', 'plaster', 'glaze', 'sheet', 'insulate', 'guttering');
    expect(NUMBER_WORDS.second).toBe('2');
    expect(NUMBER_WORDS.third).toBe('3');
  });
});
