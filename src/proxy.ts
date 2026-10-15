import type { NextRequest } from 'next/server';
import { sessionSecret } from './lib/auth-cookies';
import { guardRequest, refreshTokenRejected } from './lib/route-guard';
import { anonClient } from './lib/supabase-server';

export async function proxy(req: NextRequest) {
  return guardRequest(req, {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    sessionSecret,
    refresh: async (refreshToken) => {
      const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error) {
        if (refreshTokenRejected(error)) return null;
        throw error;
      }
      if (!data.session) return null;
      return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
    },
  });
}

export const config = {
  // /api is always matched, whatever its path ends in. Pages skip only framework assets, static
  // files and the public metadata files (robots.txt, the web app manifest), each end-anchored so /robots.txt/x or
  // /robots.txtfoo is still guarded. guardRequest denies by default.
  matcher: [
    '/api/:path*',
    '/((?!api/|_next/static/|_next/image|favicon\\.ico$|robots\\.txt$|site\\.webmanifest$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)',
  ],
};
