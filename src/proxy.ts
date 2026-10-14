import type { NextRequest } from 'next/server';
import { sessionSecret } from './lib/auth-cookies';
import { guardRequest } from './lib/route-guard';
import { anonClient } from './lib/supabase-server';

export async function proxy(req: NextRequest) {
  return guardRequest(req, {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    sessionSecret,
    refresh: async (refreshToken) => {
      const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error) {
        // 4xx from Supabase means the refresh token itself was rejected; anything else is an outage.
        const status = (error as { status?: number }).status;
        if (typeof status === 'number' && status >= 400 && status < 500) return null;
        throw error;
      }
      if (!data.session) return null;
      return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
    },
  });
}

export const config = {
  // /api is always matched, whatever its path ends in. Pages skip only framework assets and static
  // files. guardRequest denies by default.
  matcher: [
    '/api/:path*',
    '/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)',
  ],
};
