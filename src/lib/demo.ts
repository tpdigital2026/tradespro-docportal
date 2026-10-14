/**
 * Dev-only demo mode. True only when DEMO_MODE=1, NODE_ENV is not
 * production and VERCEL is unset. Reads the environment on every call so
 * tests can vary it.
 */
export function isDemo(): boolean {
  return (
    process.env.DEMO_MODE === '1' &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.VERCEL
  );
}
