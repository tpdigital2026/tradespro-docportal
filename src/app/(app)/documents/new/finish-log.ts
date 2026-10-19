import 'server-only';

/**
 * One safe log line for a refused or upgraded "Preview the document" or "Save and come back later": the
 * diagnostic code and the job id with its hyphens removed. Never any of the quote (no names, addresses, wording or
 * money), so it can sit in the hosting logs.
 */
export function logFinish(code: string, jobId: string | null): void {
  const job = jobId ? jobId.replace(/[^0-9a-z-]/gi, '').replace(/-/g, '').slice(0, 40) : '-';
  console.warn(`[quote-finish] code=${code.replace(/[^A-Z0-9-]/g, '')} job=${job}`);
}
