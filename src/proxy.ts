import type { NextRequest } from 'next/server';
import { guardRequest } from './lib/route-guard';
import { anonClient } from './lib/supabase-server';

export async function proxy(req: NextRequest) {
  return guardRequest(req, {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    refresh: async (refreshToken) => {
      const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session) return null;
      return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
    },
  });
}

export const config = {
  // Everything except framework assets and static files; guardRequest denies by default.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)'],
};
