'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import '../styles/business.css';

export interface MoreEntry {
  href: string;
  label: string;
  icon: ReactNode;
  current: boolean;
}

/**
 * The last slot of the phone and tablet bottom bar: More opens a small panel with Pipeline, Money, Calendar,
 * Guarantees and Log out. A disclosure (button with aria-expanded), not a modal: Escape or a tap outside closes it,
 * and it closes itself when the page changes. Shows as current when one of its pages is open.
 */
export function MoreMenu({ path, entries, logOut }: { path: string; entries: MoreEntry[]; logOut: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const current = entries.some((e) => e.current);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div className="more" ref={root}>
      <button
        ref={button}
        type="button"
        className={`navlink more-btn${current ? ' is-current' : ''}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        <span>More{current ? <span className="sr-only">, current page is in here</span> : null}</span>
      </button>
      <div id={id} className="more-panel" hidden={!open}>
        <ul className="more-list">
          {entries.map((e) => (
            <li key={e.href}>
              <Link href={e.href} className="more-link" aria-current={e.current ? 'page' : undefined} onClick={() => setOpen(false)}>
                {e.icon}
                <span>{e.label}</span>
              </Link>
            </li>
          ))}
          <li className="more-out">{logOut}</li>
        </ul>
      </div>
    </div>
  );
}
