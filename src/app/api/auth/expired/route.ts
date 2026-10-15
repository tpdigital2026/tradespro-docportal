import { handleExpired } from '../../../../lib/auth-handlers';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return handleExpired(req);
}
