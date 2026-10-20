import { PageHeader } from './PageHeader';

/**
 * What a tab shows the moment it is tapped, while its data loads (each tab's loading.tsx). The real title when the tab
 * knows it, then grey rows where the content will be. Screen readers hear one short "Loading" status.
 */
export function PageSkeleton({ title, muted, rows = 6 }: { title?: string; muted?: string; rows?: number }) {
  return (
    <div className="ws" aria-busy="true">
      {title ? <PageHeader muted={muted} title={title} /> : <span className="skel skel-title" aria-hidden="true" />}
      <p className="sr-only" role="status">Loading</p>
      <div className="skel-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="skel skel-row" />
        ))}
      </div>
    </div>
  );
}
