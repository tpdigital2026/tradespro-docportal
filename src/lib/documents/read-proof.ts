/**
 * Proof that the owner's browser fetched every page image of the exact document they are confirming.
 *
 * Each page image is served by our own route, and only when the page scrolls into view (or is opened full size). The
 * response carries a token: an HMAC over the business, the person, the document, the version, the content key and the
 * page number. The browser cannot make one. Finalise needs a valid token for every page of the content it is about to
 * issue, so a confirmation sent without the pages having been fetched (or for content that changed since) is refused.
 *
 * It proves the pages were delivered to this person's browser, not that a human read them; the tick is the person's
 * own statement that they did.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ReadScope {
  tenantId: string;
  userId: string;
  documentId: string;
  versionId: string;
  /** The content key of the rendered pages (see contentKey). */
  key: string;
}

const PREFIX = 'r1';

function sign(secret: string, s: ReadScope, page: number): string {
  return createHmac('sha256', secret).update(`docportal-read:${PREFIX}:${s.tenantId}:${s.userId}:${s.documentId}:${s.versionId}:${s.key}:${page}`).digest('base64url');
}

export function readToken(secret: string, s: ReadScope, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new RangeError('Bad page number');
  return `${PREFIX}.${page}.${sign(secret, s, page)}`;
}

/** True when there is a valid token for every page from 1 to pageCount. Extra or repeated tokens are ignored. */
export function allPagesRead(secret: string, s: ReadScope, pageCount: number, tokens: readonly unknown[]): boolean {
  if (!Number.isInteger(pageCount) || pageCount < 1) return false;
  const seen = new Set<number>();
  for (const t of tokens.slice(0, 400)) {
    if (typeof t !== 'string' || t.length > 120) continue;
    const m = /^r1\.(\d{1,3})\.([A-Za-z0-9_-]{43})$/.exec(t);
    if (!m) continue;
    const page = Number(m[1]);
    if (page < 1 || page > pageCount) continue;
    const want = Buffer.from(sign(secret, s, page));
    const got = Buffer.from(m[2]);
    if (want.length === got.length && timingSafeEqual(want, got)) seen.add(page);
  }
  return seen.size === pageCount;
}

/**
 * A short key for exactly what a document says (the mapped template input, bank numbers included), keyed with the
 * server secret so it reveals nothing. Any change to the content gives a different key.
 */
export function contentKey(secret: string, mappedJson: string, templateVersion: string): string {
  return createHmac('sha256', secret).update(`docportal-content:${templateVersion}:${mappedJson}`).digest('hex').slice(0, 32);
}

let demoSecret: string | null = null;

/** The server secret used for these proofs. Outside demo mode SESSION_SECRET must be set (it is required for sign-in anyway). */
export function proofSecret(demo: boolean): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return `${s}:read-proof`;
  if (demo) {
    demoSecret ??= `demo-${randomBytes(24).toString('hex')}`;
    return demoSecret;
  }
  throw new Error('SESSION_SECRET is not set');
}
