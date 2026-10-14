import type { ReactNode } from 'react';

/** Two-tone headline: muted first line, white second line. Left aligned. */
export function PageHeader({
  eyebrow,
  muted,
  title,
  lede,
  action,
}: {
  eyebrow?: string;
  muted?: string;
  title: string;
  lede?: string;
  action?: ReactNode;
}) {
  return (
    <header className="pagehead">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>
          {muted ? <span className="muted">{muted}</span> : null}
          {title}
        </h1>
      </div>
      {lede ? <p className="lede">{lede}</p> : null}
      {action ? <div>{action}</div> : null}
    </header>
  );
}
