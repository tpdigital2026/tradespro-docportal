import type { ReactNode } from 'react';

/**
 * Page title block. Two-tone headline (muted first line, ink second line) when `muted` is given; one line otherwise.
 * Left aligned; the action sits beside the title on wider screens. `compact` is for working screens like the quote.
 * `lead` puts something (an avatar) before the title.
 */
export function PageHeader({
  eyebrow,
  muted,
  title,
  lede,
  action,
  compact = false,
  lead,
}: {
  eyebrow?: string;
  muted?: string;
  title: string;
  lede?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  lead?: ReactNode;
}) {
  return (
    <header className={`pagehead${compact ? ' is-compact' : ''}${action ? ' has-action' : ''}${lead ? ' has-lead' : ''}`}>
      {lead ? <div className="pagehead-lead">{lead}</div> : null}
      <div className="pagehead-text">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>
          {muted ? <span className="muted">{muted}</span> : null}
          {title}
        </h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {action ? <div className="pagehead-action">{action}</div> : null}
    </header>
  );
}
