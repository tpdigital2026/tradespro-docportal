import { handleRequestCode } from '../../../../lib/auth-handlers';

export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handleRequestCode(req);
}
