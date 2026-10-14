/**
 * CSRF defence for state-changing requests: the Origin header must be present and match this
 * site. Browsers always send Origin on cross-site POSTs, so a missing one is refused.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(req.url).host);
  } catch {
    /* ignore */
  }
  const h = req.headers.get('host');
  if (h) hosts.add(h);
  return hosts.has(host);
}

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
