/**
 * Turns the photo references of a mapped survey into the pictures the template prints. Server only: reads the
 * stored (already cleaned) photos and makes a smaller copy sized to how large each is printed. Nothing is stored.
 * Photos are read and encoded four at a time: one after another a large survey would not finish inside the route's
 * time limit, and without a bound the memory of a 60 photo report would not be sensible. The order of the output
 * is always the order of the survey.
 */
import type { SurveyInput } from '../../templates/survey';
import type { DocumentStorage } from '../storage';
import { printCopy } from './images';
import type { PhotoRef, SurveyMappedInput } from './map';

/** Long edge of the printed copy, by how many photos share the finding's page. */
const PRINT_EDGE: Record<number, number> = { 1: 1800, 2: 1400, 3: 1100, 4: 1300 };

/** How many photos are read and encoded at once. */
export const PHOTO_CONCURRENCY = 4;

/** Maps in parallel, at most `limit` at a time, results in input order. After the first failure no new item starts. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function resolveSurveyPhotos(m: SurveyMappedInput, storage: Pick<DocumentStorage, 'get'>): Promise<SurveyInput> {
  const jobs: { ref: PhotoRef; edge: number }[] = [];
  for (const f of m.findings) for (const p of f.photos) jobs.push({ ref: p, edge: PRINT_EDGE[f.photos.length] ?? 1100 });
  if (m.coverPhoto) jobs.push({ ref: m.coverPhoto, edge: 1800 });
  const done = await mapBounded(jobs, PHOTO_CONCURRENCY, async ({ ref, edge }) => {
    const bytes = await storage.get(ref.path);
    if (!bytes) throw new Error('A survey photo is missing from storage');
    return printCopy(bytes, edge);
  });
  let at = 0;
  const findings = m.findings.map((f) => ({ ...f, photos: f.photos.map(() => done[at++]) }));
  const coverPhoto = m.coverPhoto ? done[at++].src : null;
  return { ...m, coverPhoto, findings };
}
