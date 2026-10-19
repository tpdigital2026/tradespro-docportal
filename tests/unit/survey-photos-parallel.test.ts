import { describe, expect, it } from 'vitest';
import { mapBounded, PHOTO_CONCURRENCY, resolveSurveyPhotos } from '../../src/lib/survey/render';
import type { SurveyMappedInput } from '../../src/lib/survey/map';
import { placeholderPhoto } from '../fixtures/survey';

const DELAY = 40;
const PHOTOS = 40;

function stubStorage(bytes: Buffer) {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    storage: {
      async get(path: string) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, DELAY));
        inFlight -= 1;
        return path.startsWith('missing') ? null : bytes;
      },
    },
  };
}

const ref = (i: number, prefix = 'p') => ({ id: `${prefix}${i}`, path: `${prefix}/${i}.jpg`, sha256: String(i), width: 800, height: 600 });
function survey(n: number): SurveyMappedInput {
  const findings = Array.from({ length: Math.ceil(n / 4) }, (_, f) => ({
    title: `F${f}`,
    observation: ['o'],
    assessment: ['a'],
    photos: Array.from({ length: Math.min(4, n - f * 4) }, (_, k) => ref(f * 4 + k)),
  }));
  return { coverPhoto: ref(999, 'c'), findings } as unknown as SurveyMappedInput;
}

describe('resolveSurveyPhotos', () => {
  it('reads and encodes 40 photos four at a time, in order, much faster than one after another', async () => {
    const bytes = await placeholderPhoto(1, 900, 700);
    const { storage, peak } = stubStorage(bytes);
    const t0 = Date.now();
    const out = await resolveSurveyPhotos(survey(PHOTOS), storage);
    const ms = Date.now() - t0;
    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBeLessThanOrEqual(PHOTO_CONCURRENCY);
    // 41 reads of 40 ms is about 1640 ms in sequence. Four at a time the reads take about 440 ms.
    expect(ms).toBeLessThan(41 * DELAY * 0.75);
    expect(out.findings).toHaveLength(10);
    expect(out.findings.flatMap((f) => f.photos)).toHaveLength(PHOTOS);
    expect(out.coverPhoto).toMatch(/^data:image\/jpeg;base64,/);
  }, 30_000);

  it('keeps the order and gives the same output twice', async () => {
    const a = await placeholderPhoto(1, 900, 700);
    const b = await placeholderPhoto(2, 1000, 500);
    const mixed = { get: async (p: string) => (Number(/\/(\d+)\./.exec(p)?.[1]) % 2 ? a : b) };
    const first = await resolveSurveyPhotos(survey(9), mixed);
    const second = await resolveSurveyPhotos(survey(9), mixed);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const srcs = first.findings.flatMap((f) => f.photos.map((p) => p.src));
    expect(srcs[0]).not.toBe(srcs[1]);
    expect(srcs[0]).toBe(srcs[2]);
    expect(first.findings.map((f) => f.photos.length)).toEqual([4, 4, 1]);
  });

  it('fails when a photo is missing from storage', async () => {
    const bytes = await placeholderPhoto(1, 600, 400);
    const m = survey(5);
    m.findings[0].photos[1] = ref(1, 'missing');
    await expect(resolveSurveyPhotos(m, stubStorage(bytes).storage)).rejects.toThrow('missing from storage');
  });
});

describe('mapBounded', () => {
  it('never runs more than the limit at once, keeps order and stops starting work after a failure', async () => {
    let running = 0;
    let peak = 0;
    let started = 0;
    const out = await mapBounded([...Array(20).keys()], 4, async (i) => {
      started += 1;
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return i * 2;
    });
    expect(out).toEqual([...Array(20).keys()].map((i) => i * 2));
    expect(peak).toBe(4);
    started = 0;
    await expect(
      mapBounded([...Array(50).keys()], 4, async (i) => {
        started += 1;
        await new Promise((r) => setTimeout(r, 5));
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
    expect(started).toBeLessThan(20);
  });
});
