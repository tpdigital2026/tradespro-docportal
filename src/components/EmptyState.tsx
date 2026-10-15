import type { ReactNode } from 'react';

const icons = {
  jobs: 'M4 8h16v11a1 1 0 01-1 1H5a1 1 0 01-1-1V8zM9 8V5a1 1 0 011-1h4a1 1 0 011 1v3M4 13h16',
  drafts: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  docs: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5M9 13h6M9 17h4',
  people: 'M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9M15.5 4.2a3.5 3.5 0 010 6.6',
  search: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20',
} as const;

/** A friendly, designed "nothing here yet": an icon, a short title, one helpful line and, when it helps, one action. */
export function EmptyState({ icon, title, children, action, compact = false }: { icon: keyof typeof icons; title: string; children: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state${compact ? ' is-compact' : ''}`}>
      <span className="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d={icons[icon]} />
        </svg>
      </span>
      <div className="empty-body">
        <p className="empty-title">{title}</p>
        <p className="empty-text">{children}</p>
        {action ? <div className="empty-action">{action}</div> : null}
      </div>
    </div>
  );
}
