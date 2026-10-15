import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let permit = true;
let room: Error | null = null;

vi.mock('../../src/lib/session', () => ({ getSession: async () => ({ userId: 'u1', tenantId: 't1', role: 'owner', fullName: 'Test Owner' }) }));
vi.mock('../../src/lib/data/surveys', () => {
  class SurveyError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class PhotoError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    SurveyError,
    PhotoError,
    UPLOAD_LIMITED: 'limited',
    takeUploadPermit: () => {
      calls.push('permit');
      return permit;
    },
    checkSurveyPhotoRoom: async () => {
      calls.push('room');
      if (room) throw room;
    },
    uploadSurveyPhoto: async (_id: string, _finding: string, bytes: Uint8Array) => {
      calls.push(`upload:${bytes.length}`);
      return { id: 'p1', width: 10, height: 10 };
    },
  };
});

const { POST } = await import('../../src/app/api/surveys/[id]/photos/route');
const { SurveyError } = (await import('../../src/lib/data/surveys')) as unknown as { SurveyError: new (c: string, m: string) => Error };
const { readCapped } = await import('../../src/lib/survey/read-capped');
const { PHOTO_LIMITS } = await import('../../src/lib/survey/images');

const URL_OK = 'http://localhost/api/surveys/doc/photos?finding=f-abcdef1234';
const ctx = { params: Promise.resolve({ id: 'doc' }) };

/** A request whose body is a stream we watch, so the tests can tell whether it was ever read. */
function req(o: { length?: string | null; body?: Uint8Array; type?: string; url?: string }) {
  let pulled = false;
  const bytes = o.body ?? new Uint8Array(10);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled = true;
      c.enqueue(bytes);
      c.close();
    },
  }, { highWaterMark: 0 });
  const headers = new Headers({ 'content-type': o.type ?? 'multipart/form-data; boundary=x' });
  if (o.length !== null) headers.set('content-length', o.length ?? String(bytes.length));
  const r = { url: o.url ?? URL_OK, headers, body } as unknown as Request;
  return { r, pulled: () => pulled };
}

function multipart(size: number): { body: Uint8Array; type: string } {
  const head = '--b\r\nContent-Disposition: form-data; name="photo"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n';
  const tail = '\r\n--b--\r\n';
  const body = Buffer.concat([Buffer.from(head), Buffer.alloc(size, 7), Buffer.from(tail)]);
  return { body: new Uint8Array(body), type: 'multipart/form-data; boundary=b' };
}

beforeEach(() => {
  calls.length = 0;
  permit = true;
  room = null;
});

describe('photo upload route: the order of the checks', () => {
  it('no Content-Length: 411, and nothing else happens (no limit taken, no lookup, body never read)', async () => {
    const x = req({ length: null });
    expect((await POST(x.r, ctx)).status).toBe(411);
    expect(calls).toEqual([]);
    expect(x.pulled()).toBe(false);
  });

  it('a declared length over the cap: 413 before anything else', async () => {
    const x = req({ length: String(PHOTO_LIMITS.maxUploadBytes + 70 * 1024) });
    expect((await POST(x.r, ctx)).status).toBe(413);
    expect(calls).toEqual([]);
    expect(x.pulled()).toBe(false);
  });

  it('over the per-person limit: 429 before the survey is looked up or the body read', async () => {
    permit = false;
    const x = req({});
    expect((await POST(x.r, ctx)).status).toBe(429);
    expect(calls).toEqual(['permit']);
    expect(x.pulled()).toBe(false);
  });

  it('a survey, finding or room problem: refused before the body is read', async () => {
    room = new SurveyError('not_found', 'That finding is not saved yet.');
    const x = req({});
    const res = await POST(x.r, ctx);
    expect(res.status).toBe(404);
    expect(calls).toEqual(['permit', 'room']);
    expect(x.pulled()).toBe(false);
  });

  it('a bad finding id: 400 before anything else', async () => {
    const x = req({ url: 'http://localhost/api/surveys/doc/photos?finding=../../x' });
    expect((await POST(x.r, ctx)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('all good: the bounded body is parsed and the photo goes to the server pipeline', async () => {
    const m = multipart(1000);
    const x = req({ body: m.body, type: m.type });
    const res = await POST(x.r, ctx);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['permit', 'room', 'upload:1000']);
  });

  it('a body longer than its Content-Length says is cut off and refused (413)', async () => {
    const m = multipart(5000);
    const x = req({ body: m.body, type: m.type, length: '100' });
    expect((await POST(x.r, ctx)).status).toBe(413);
    expect(calls).toEqual(['permit', 'room']);
  });
});

describe('readCapped', () => {
  const stream = (chunks: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((n, i) => c.enqueue(new Uint8Array(n).fill(i)));
        c.close();
      },
    });

  it('joins a chunked body in order', async () => {
    const b = await readCapped(stream([3, 4, 5]), 100);
    expect(b?.length).toBe(12);
    expect([...(b ?? [])]).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

  it('exactly at the cap is accepted; one byte over is refused, and the stream is cancelled', async () => {
    expect((await readCapped(stream([50, 50]), 100))?.length).toBe(100);
    let cancelled = false;
    const s = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(60));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readCapped(s, 100)).toBeNull();
    expect(cancelled).toBe(true);
    expect(await readCapped(stream([101]), 100)).toBeNull();
  });

  it('an empty body is empty, not an error', async () => {
    expect((await readCapped(null, 10))?.length).toBe(0);
    expect((await readCapped(stream([]), 10))?.length).toBe(0);
  });
});
