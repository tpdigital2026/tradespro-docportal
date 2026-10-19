'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Confirmation } from '../../../../lib/documents/confirmation';

interface PageState {
  url: string | null;
  token: string | null;
  failed: boolean;
}

/**
 * Preview, read, tick, finalise. In that order:
 *  1. every page is shown full width; a page is fetched from the server only when it scrolls into view (or is opened
 *     full size), and the server hands back a read token with it;
 *  2. the tick box and the Finalise button stay unavailable, with the reason said out loud, until every page is read;
 *  3. the owner ticks the confirmation;
 *  4. Finalise sends the version, its content key and the read tokens; the server checks everything again.
 * Disabled controls use aria-disabled with a described-by reason, so they stay focusable and explain themselves.
 */
export function Preview({
  documentId,
  versionId,
  contentKey,
  pageCount,
  confirmation,
  corrections,
  uncertain,
  showNotes,
  editHref,
}: {
  documentId: string;
  versionId: string;
  contentKey: string;
  pageCount: number;
  confirmation: Confirmation;
  corrections: string[];
  uncertain: string[];
  showNotes: boolean;
  editHref: string | null;
}) {
  const router = useRouter();
  const ids = { reason: useId(), tick: useId(), progress: useId(), error: useId() };
  const [pages, setPages] = useState<PageState[]>(() => Array.from({ length: pageCount }, () => ({ url: null, token: null, failed: false })));
  const [ticked, setTicked] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; missing: string[]; reload: boolean } | null>(null);
  const [nudge, setNudge] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const requested = useRef<Set<number>>(new Set());
  const figures = useRef<(HTMLElement | null)[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const tickRef = useRef<HTMLInputElement>(null);

  const read = pages.filter((p) => p.token !== null).length;
  const allRead = read === pageCount;
  const canFinalise = allRead && ticked && !sending;

  const load = useCallback(
    async (i: number) => {
      if (requested.current.has(i)) return;
      requested.current.add(i);
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/pages/${i + 1}?key=${contentKey}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error('page');
        const token = res.headers.get('X-Read-Token');
        const url = URL.createObjectURL(await res.blob());
        setPages((ps) => ps.map((p, j) => (j === i ? { url, token, failed: false } : p)));
      } catch {
        requested.current.delete(i);
        setPages((ps) => ps.map((p, j) => (j === i ? { ...p, failed: true } : p)));
      }
    },
    [documentId, contentKey],
  );

  // A page counts once it has come into view (at least a third of it on screen).
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      pages.forEach((_, i) => void load(i));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.page);
          void load(i);
          io.unobserve(e.target);
        }
      },
      { threshold: 0.3 },
    );
    figures.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
    // Observe once; load() remembers what it has asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const urls = useRef<string[]>([]);
  useEffect(() => {
    urls.current = pages.flatMap((p) => (p.url ? [p.url] : []));
  }, [pages]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const openPage = (i: number) => {
    void load(i);
    setOpen(i);
    dialog.current?.showModal();
  };

  const reason = !allRead
    ? `Read all ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} to continue. ${read} of ${pageCount} read so far.`
    : !ticked
      ? 'Tick the box above to confirm you have checked it.'
      : '';

  const onTick = () => {
    if (!allRead) {
      setNudge(`Read all ${pageCount} pages first. ${read} of ${pageCount} read so far.`);
      return;
    }
    setTicked((t) => !t);
    setNudge('');
  };

  const finalise = async () => {
    if (!canFinalise) {
      setNudge(reason);
      (allRead ? tickRef.current : figures.current[pages.findIndex((p) => p.token === null)])?.focus?.();
      if (!allRead) figures.current[pages.findIndex((p) => p.token === null)]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/finalise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ versionId, key: contentKey, tokens: pages.map((p) => p.token).filter(Boolean), confirmed: true, confirmationVersion: confirmation.version }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; message?: string; missing?: string[] } | null;
      if (res.ok && data?.ok) {
        router.push(`/documents/${encodeURIComponent(documentId)}?finalised=1`);
        router.refresh();
        return;
      }
      setError({ message: data?.message ?? 'We could not finalise that just now. Nothing was changed. Please try again.', missing: data?.missing ?? [], reload: data?.code === 'changed' || data?.code === 'unread' });
    } catch {
      setError({ message: 'We could not reach the server. Nothing was changed. Check your connection and try again.', missing: [], reload: false });
    }
    setSending(false);
  };

  return (
    <div className="pv">
      <div className="pv-pages">
        <p className="pv-progress" id={ids.progress} role="status" aria-live="polite">
          <span className="pv-progress-bar" aria-hidden="true">
            {/* The bar is scaled, not resized: only a transform animates (app.css .pv-progress-bar span). */}
            <span style={{ '--pv-read': String(pageCount > 0 ? Math.min(1, Math.max(0, read / pageCount)) : 0) } as CSSProperties} />
          </span>
          <span>{allRead ? `All ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} read` : `${read} of ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} read`}</span>
        </p>
        <ol className="pv-list">
          {pages.map((p, i) => (
            <li key={i}>
              <figure
                className={`pv-page${p.token ? ' is-read' : ''}`}
                data-page={i}
                ref={(el) => {
                  figures.current[i] = el;
                }}
                tabIndex={-1}
                aria-labelledby={`pv-cap-${i}`}
              >
                <button type="button" className="pv-open" onClick={() => openPage(i)} aria-label={`Open page ${i + 1} of ${pageCount} full size`}>
                  {p.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.url} alt={`Page ${i + 1} of ${pageCount}`} width={794} height={1123} />
                  ) : (
                    <span className="pv-wait">{p.failed ? 'This page did not load. Tap to try again.' : `Page ${i + 1} is loading`}</span>
                  )}
                </button>
                <figcaption id={`pv-cap-${i}`} className="pv-cap">
                  <span>Page {i + 1} of {pageCount}</span>
                  {p.token ? <span className="pv-tick">Read</span> : null}
                </figcaption>
              </figure>
            </li>
          ))}
        </ol>
      </div>

      <aside className="pv-side" aria-label="Confirm and finalise">
        <div className="pv-panel">
          {showNotes ? (
            <div className="pv-notes">
              <h2 className="fgroup-h">Please check</h2>
              {uncertain.length ? (
                <ul>{uncertain.map((u) => <li key={u}>{u}</li>)}</ul>
              ) : (
                <p className="hint">Nothing was flagged when the wording was made.</p>
              )}
              <h2 className="fgroup-h">What was changed</h2>
              {corrections.length ? (
                <ul>{corrections.map((c) => <li key={c}>{c}</li>)}</ul>
              ) : (
                <p className="hint">No changes were made to your words.</p>
              )}
            </div>
          ) : null}

          <div className={`pv-confirm${allRead ? '' : ' is-locked'}`}>
            <input
              ref={tickRef}
              type="checkbox"
              id={ids.tick}
              className="pv-check"
              checked={ticked}
              aria-disabled={!allRead}
              aria-describedby={allRead ? undefined : ids.reason}
              onChange={onTick}
            />
            <label htmlFor={ids.tick}>{confirmation.text}</label>
          </div>

          <button type="button" className="btn btn-primary pv-go" aria-disabled={!canFinalise} aria-describedby={canFinalise ? undefined : ids.reason} onClick={finalise}>
            {sending ? 'Finalising, this takes a few seconds' : 'Finalise'}
          </button>
          <p className="pv-reason" id={ids.reason}>{sending ? 'Making the PDF. Please keep this page open.' : reason}</p>
          <p className="sr-status" role="status" aria-live="assertive">{nudge}</p>

          {error ? (
            <div className="pv-error" role="alert" id={ids.error}>
              <p>{error.message}</p>
              {error.missing.length ? <ul>{error.missing.map((m) => <li key={m}>{m}</li>)}</ul> : null}
              {error.reload ? (
                <button type="button" className="linklike" onClick={() => window.location.reload()}>Load the latest version and read it again</button>
              ) : null}
            </div>
          ) : null}

          {editHref ? (
            <p className="hint pv-edit">
              <a href={editHref}>Spotted a mistake? Go back and edit it</a>
              <span>You will read it again afterwards.</span>
            </p>
          ) : null}
        </div>
      </aside>

      <dialog
        ref={dialog}
        className="pv-dialog"
        aria-label={open !== null ? `Page ${open + 1} of ${pageCount}` : 'Page'}
        onClose={() => setOpen(null)}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="pv-dialog-bar">
          <span>{open !== null ? `Page ${open + 1} of ${pageCount}` : ''}</span>
          <button type="button" className="btn btn-secondary" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        {open !== null && pages[open]?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pages[open].url as string} alt={`Page ${open + 1} of ${pageCount}, full size`} width={1588} height={2246} />
        ) : (
          <p className="pv-wait">Loading the page</p>
        )}
      </dialog>
    </div>
  );
}
