import type { ReactNode } from 'react';

/**
 * Page title block: the title left (28px), one action right, an optional short line under it. `muted` puts a quieter
 * first word before the title on the same line. The action sits beside the title at every width. `compact` is for working screens like the quote.
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
          {muted ? <><span className="muted">{muted}</span>{' '}</> : null}
          {title}
        </h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {action ? <div className="pagehead-action">{action}</div> : null}
    </header>
  );
}
