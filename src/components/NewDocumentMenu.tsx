'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { newDocumentHref, type DocType } from '../lib/job-stage';

type Item = { type: DocType; name: string; soon?: true };
const GROUPS: { label: string; items: Item[] }[] = [
  { label: 'Start a job', items: [{ type: 'quotation', name: 'Quotation' }, { type: 'survey', name: 'Survey report' }] },
  {
    label: 'Get paid',
    items: [
      { type: 'deposit-invoice', name: 'Deposit invoice' },
      { type: 'balance-invoice', name: 'Balance invoice' },
      { type: 'invoice-full', name: 'Full invoice' },
      { type: 'invoice-stage', name: 'Stage invoice' },
      { type: 'receipt', name: 'Receipt' },
    ],
  },
  { label: 'Finish up', items: [{ type: 'guarantee', name: 'Guarantee certificate', soon: true }] },
];

/**
 * The one primary action on a page header: "New document" opens a menu of the document types, grouped. A dropdown on
 * wider screens, a bottom sheet on phones (CSS). Menu button pattern: Enter, Space or Arrow Down opens on the first
 * item, Arrow Up on the last; arrows, Home and End move; Escape closes and returns focus to the button; Tab or a tap
 * outside closes. Every item is a plain link, so the targets are in the server HTML.
 */
export function NewDocumentMenu({ label = 'New document' }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const startAt = useRef<'first' | 'last'>('first');

  const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    const list = items();
    (startAt.current === 'last' ? list[list.length - 1] : list[0])?.focus();
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      startAt.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(list.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="newdoc" ref={root}>
      <button
        ref={button}
        type="button"
        className="btn btn-primary newdoc-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          startAt.current = 'first';
          setOpen((o) => !o);
        }}
        onKeyDown={onButtonKey}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        {label}
      </button>
      <div className="newdoc-backdrop" hidden={!open} aria-hidden="true" />
      <div id={id} ref={panel} className="newdoc-menu" role="menu" aria-label={label} hidden={!open} onKeyDown={onMenuKey}>
        {GROUPS.map((g, gi) => (
          <div key={g.label} role="group" aria-labelledby={`${id}-g${gi}`} className="newdoc-group">
            <div role="presentation" id={`${id}-g${gi}`} className="newdoc-label">{g.label}</div>
            {g.items.map((i) => (
              <Link key={i.type} href={newDocumentHref(i.type)} role="menuitem" tabIndex={-1} className="newdoc-item" onClick={() => setOpen(false)}>
                <span>{i.name}</span>
                {i.soon ? <span className="newdoc-soon">Coming soon</span> : null}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
