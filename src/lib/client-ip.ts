import { UNKNOWN_IP, normaliseIp } from '../security/login-guard';

/**
 * The client address from a header only the platform can set. On Vercel that is
 * x-vercel-forwarded-for (then x-real-ip). X-Forwarded-For is never read: its leftmost entry is
 * whatever the client chose to send. With no trusted header (local dev) the shared sentinel applies.
 */
export function getClientIp(headers: Pick<Headers, 'get'>): string {
  const raw = headers.get('x-vercel-forwarded-for') ?? headers.get('x-real-ip');
  const ip = normaliseIp(raw);
  if (ip === UNKNOWN_IP) {
    // Shape only, never the value: it is attacker-controlled text.
    console.warn(`login: no usable client address (trusted header ${raw ? `present, ${raw.length} chars, unparseable` : 'absent'})`);
  }
  return ip;
}
