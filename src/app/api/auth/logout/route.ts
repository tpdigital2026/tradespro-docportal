import { cookies } from 'next/headers';
import { handleLogout } from '../../../../lib/auth-handlers';
import { accessCookieName } from '../../../../lib/auth-cookies';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  return handleLogout(req, jar.get(accessCookieName())?.value);
}
