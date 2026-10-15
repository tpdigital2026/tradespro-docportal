/** Words that are routes or infrastructure and can never be a business's sign-in address. */
export const RESERVED_SLUGS: readonly string[] = ['login', 'api', 'admin', 'customers', 'documents', 'dev', '_next', 's', 'static', 'public', 'favicon', 'robots', 'sitemap', 'settings'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isValidSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s) && !s.includes('--') && !RESERVED_SLUGS.includes(s);
}
