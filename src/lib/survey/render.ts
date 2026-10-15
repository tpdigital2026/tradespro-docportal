/**
 * Turns the photo references of a mapped survey into the pictures the template prints. Server only: reads the
 * stored (already cleaned) photos and makes a smaller copy sized to how large each is printed. Nothing is stored.
 */
import type { SurveyInput } from '../../templates/survey';
import type { DocumentStorage } from '../storage';
import { printCopy } from './images';
import type { PhotoRef, SurveyMappedInput } from './map';

/** Long edge of the printed copy, by how many photos share the finding's page. */
const PRINT_EDGE: Record<number, number> = { 1: 1800, 2: 1400, 3: 1100, 4: 1300 };

export async function resolveSurveyPhotos(m: SurveyMappedInput, storage: Pick<DocumentStorage, 'get'>): Promise<SurveyInput> {
  const read = async (p: PhotoRef, edge: number) => {
    const bytes = await storage.get(p.path);
    if (!bytes) throw new Error('A survey photo is missing from storage');
    return printCopy(bytes, edge);
  };
  const findings = [];
  for (const f of m.findings) {
    const photos = [];
    for (const p of f.photos) photos.push(await read(p, PRINT_EDGE[f.photos.length] ?? 1100));
    findings.push({ ...f, photos });
  }
  const coverPhoto = m.coverPhoto ? (await read(m.coverPhoto, 1800)).src : null;
  return { ...m, coverPhoto, findings };
}
