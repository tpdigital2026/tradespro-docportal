import { withServiceConnection } from '../../../../lib/data/customer-admin';
import { demoSettings, saveSignatureWith, signaturePathWith } from '../../../../lib/data/settings';
import { isDemo } from '../../../../lib/demo';
import { getSession } from '../../../../lib/session';
import { handleSignatureGet, handleSignaturePost, type SignatureDeps } from '../../../../lib/signature-handlers';
import { requireFreshStepUpForRequest } from '../../../../lib/step-up-check';
import { getStorage } from '../../../../lib/storage';
import { logRenderFailure } from '../../../../pdf/diagnostics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const deps: SignatureDeps = {
  session: getSession,
  requireStepUp: requireFreshStepUpForRequest,
  load: async (tenantId) => {
    if (isDemo()) return demoSettings().signature?.png ?? null;
    const path = await withServiceConnection((db) => signaturePathWith(db, tenantId));
    return path ? getStorage().get(path) : null;
  },
  reencode: async (bytes, image) => {
    try {
      return await (await import('../../../../lib/render-service')).reencodeSignature(bytes, image);
    } catch (e) {
      logRenderFailure('signature', e);
      throw e;
    }
  },
  save: async (s, image) => {
    if (isDemo()) {
      demoSettings().signature = image;
      return;
    }
    await withServiceConnection((db) => saveSignatureWith(db, getStorage(), { tenantId: s.tenantId, userId: s.userId }, image));
  },
};

export function GET() {
  return handleSignatureGet(deps);
}

export function POST(req: Request) {
  return handleSignaturePost(req, deps);
}
