'use client';

import { useLinkStatus } from 'next/link';

/**
 * Inside a <Link>: a small spinner the moment the link is pressed and the next screen is not ready yet, so a tap never
 * looks like it did nothing. Hidden from screen readers (the next page's loading status speaks instead).
 */
export function PendingHint() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={`pending-hint${pending ? ' is-pending' : ''}`} />;
}

/** The same spinner for a button whose server action is running. */
export function Spinner() {
  return <span aria-hidden="true" className="pending-hint is-pending" />;
}
