import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const K1 = 'a'.repeat(32);
const K2 = 'b'.repeat(32);
const ctx = (id: string, n?: string) => ({ params: Promise.resolve(n === undefined ? { id } : { id, n }) }) as never;

describe('document routes (demo mode, files placed directly in the in-memory store)', () => {
  beforeAll(async () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VERCEL', '');
    const { getStorage } = await import('../../src/lib/storage');
    const s = getStorage();
    const final = 'demo-tenant/demo-customer-1/demo-job-3001/demo-ver-demo-doc-3001-d-v1';
    await s.put(`${final}/document.pdf`, Buffer.from('%PDF-1.7 demo'), 'application/pdf', { overwrite: true });
    await s.put(`${final}/page-01.png`, Buffer.from('png'), 'image/png', { overwrite: true });
    const draft = 'demo-tenant/demo-customer-1/demo-job-2001/demo-ver-demo-doc-demo-job-2001-v1';
    await s.put(`${draft}/preview-${K1}/page-01.png`, Buffer.from('png'), 'image/png', { overwrite: true });
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('a final document downloads as an attachment named after its number', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/pdf/route');
    const res = await GET(new Request('http://x/api/documents/demo-doc-3001-d/pdf'), ctx('demo-doc-3001-d'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="INV-DEMO-3001-D.pdf"/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('a draft never downloads', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/pdf/route');
    expect((await GET(new Request('http://x/api/documents/demo-doc-demo-job-2001/pdf'), ctx('demo-doc-demo-job-2001'))).status).toBe(404);
  });

  it('?v= naming a version of another document is refused', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/pdf/route');
    const res = await GET(new Request('http://x/api/documents/demo-doc-3001-d/pdf?v=demo-ver-demo-doc-3001-q-v1'), ctx('demo-doc-3001-d'));
    expect(res.status).toBe(404);
  });

  it('page images: the current preview key gives the page and a read token; a stale key gives nothing', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/pages/[n]/route');
    const ok = await GET(new Request(`http://x/api/documents/demo-doc-demo-job-2001/pages/1?key=${K1}`), ctx('demo-doc-demo-job-2001', '1'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-read-token')).toMatch(/^r1\.1\./);
    const stale = await GET(new Request(`http://x/api/documents/demo-doc-demo-job-2001/pages/1?key=${K2}`), ctx('demo-doc-demo-job-2001', '1'));
    expect(stale.status).toBe(404);
    const bad = await GET(new Request('http://x/api/documents/demo-doc-demo-job-2001/pages/1?key=../../x'), ctx('demo-doc-demo-job-2001', '1'));
    expect(bad.status).toBe(404);
    // A draft has no issued pages to show without a key.
    expect((await GET(new Request('http://x/api/documents/demo-doc-demo-job-2001/pages/1'), ctx('demo-doc-demo-job-2001', '1'))).status).toBe(404);
    // A final document's issued pages need no key and carry no token.
    const fin = await GET(new Request('http://x/api/documents/demo-doc-3001-d/pages/1'), ctx('demo-doc-3001-d', '1'));
    expect(fin.status).toBe(200);
    expect(fin.headers.get('x-read-token')).toBeNull();
  });

  it('a token for one page or key does not prove another', async () => {
    const { allPagesRead, proofSecret } = await import('../../src/lib/documents/read-proof');
    const { GET } = await import('../../src/app/api/documents/[id]/pages/[n]/route');
    const res = await GET(new Request(`http://x/api/documents/demo-doc-demo-job-2001/pages/1?key=${K1}`), ctx('demo-doc-demo-job-2001', '1'));
    const t = res.headers.get('x-read-token') as string;
    const scope = { tenantId: 'demo-tenant', userId: 'demo-user', documentId: 'demo-doc-demo-job-2001', versionId: 'demo-ver-demo-doc-demo-job-2001-v1' };
    expect(allPagesRead(proofSecret(true), { ...scope, key: K1 }, 1, [t])).toBe(true);
    expect(allPagesRead(proofSecret(true), { ...scope, key: K2 }, 1, [t])).toBe(false);
  });
});
