import { cookies } from 'next/headers';
import { handleLogout } from '../../../../lib/auth-handlers';
import { accessCookieName, refreshCookieName } from '../../../../lib/auth-cookies';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  return handleLogout(req, { access: jar.get(accessCookieName())?.value, refresh: jar.get(refreshCookieName())?.value });
}
