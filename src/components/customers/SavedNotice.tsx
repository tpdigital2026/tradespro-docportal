'use client';

import { useEffect, useRef, useState } from 'react';
import { SAVED_TEXT, type SavedKind } from '../../lib/customer-flash';

/**
 * The confirmation after a save. The region is always on the page and the words arrive after it has mounted, so
 * screen readers say them. The notice sits beside the form and is brought into view, because the form is far
 * down the page and the person would otherwise see nothing happen. Reloading does not show it again.
 */
export function SavedNotice({ kind, bringIntoView = true }: { kind: SavedKind | null; bringIntoView?: boolean }) {
  const [shown, setShown] = useState<SavedKind | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!kind) return;
    setShown(kind);
    if (bringIntoView) box.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
    const url = new URL(window.location.href);
    if (url.searchParams.has('saved')) {
      url.searchParams.delete('saved');
      window.history.replaceState(window.history.state, '', url);
    }
  }, [kind, bringIntoView]);

  return (
    <div ref={box} role="status" aria-live="polite" className={shown ? 'cust-saved' : undefined}>
      {shown ? (
        <>
          <svg className="cust-saved-tick" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
          <span>{SAVED_TEXT[shown]}</span>
        </>
      ) : null}
    </div>
  );
}
