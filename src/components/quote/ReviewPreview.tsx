'use client';

import { useEffect, useRef, useState } from 'react';
import { previewDraftPageAction } from '../../app/(app)/documents/new/preview-actions';
import type { DraftPreview, PreviewFixStep } from '../../lib/documents/draft-preview';
import '../../styles/review-preview.css';

/** Wait for the owner to stop changing things before drawing again. */
const SETTLE_MS = 1200;

type View =
  | { kind: 'waiting' }
  | { kind: 'unsaved' }
  | { kind: 'loading'; last: Extract<DraftPreview, { state: 'ready' }> | null }
  | { kind: 'shown'; preview: DraftPreview };

/**
 * Page 1 of the real quote, drawn from the saved draft, at the centre of the Review step. Redrawn after every change
 * (once the owner pauses), with the old page left in place and a calm note while the new one is drawn. If something
 * the document needs is missing, the list of what and where to fix it shows instead of a failure.
 */
export function ReviewPreview({
  watch,
  getDocumentId,
  onFix,
  memory,
}: {
  /** Anything that changes when the quote changes (the form values). */
  watch: unknown;
  /** Saves the draft if it needs saving, then gives the document id (null when it cannot be saved yet). */
  getDocumentId: () => Promise<string | null>;
  onFix: (step: PreviewFixStep) => void;
  /** The last page drawn, kept by the form, so coming back to Review shows it while the new one is drawn. */
  memory?: { current: Extract<DraftPreview, { state: 'ready' }> | null };
}) {
  const [view, setView] = useState<View>(() => (memory?.current ? { kind: 'loading', last: memory.current } : { kind: 'waiting' }));
  const [imgState, setImgState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const first = useRef(true);
  const getId = useRef(getDocumentId);
  getId.current = getDocumentId;

  useEffect(() => {
    const mine = ++seq.current;
    const delay = first.current ? 50 : SETTLE_MS;
    first.current = false;
    const t = setTimeout(async () => {
      setView((v) => ({ kind: 'loading', last: v.kind === 'shown' && v.preview.state === 'ready' ? v.preview : v.kind === 'loading' ? v.last : null }));
      const id = await getId.current().catch(() => null);
      if (mine !== seq.current) return;
      if (!id) {
        setView({ kind: 'unsaved' });
        return;
      }
      const res: DraftPreview = await previewDraftPageAction(id).catch(() => ({ state: 'error' as const, message: 'We could not reach the server to draw the preview. Check your signal.', diag: 'PV-NETWORK' }));
      if (mine !== seq.current) return;
      if (res.state === 'ready' && memory) memory.current = res;
      setView({ kind: 'shown', preview: res });
    }, delay);
    return () => clearTimeout(t);
  }, [watch, attempt]);

  const ready = view.kind === 'shown' && view.preview.state === 'ready' ? view.preview : view.kind === 'loading' ? view.last : null;
  const url = ready?.imageUrl;
  useEffect(() => setImgState('loading'), [url]);
  const updating = view.kind === 'loading' || (view.kind === 'waiting');
  const retry = () => setAttempt((a) => a + 1);

  const problem = view.kind === 'shown' && (view.preview.state === 'error' || view.preview.state === 'busy') ? view.preview : null;
  const missing = view.kind === 'shown' && view.preview.state === 'missing' ? view.preview : null;

  return (
    <section className="rv-doc" aria-labelledby="rv-doc-h">
      <div className="rv-doc-head">
        <h3 id="rv-doc-h" className="rv-doc-title">Your quote</h3>
        <p className="rv-doc-status" aria-live="polite">
          {updating && ready ? 'Updating the preview...' : updating ? 'Drawing page 1 of your quote...' : ready && imgState === 'ok' ? `Page 1 of ${ready.pageCount}, exactly as your customer will see it.` : ''}
        </p>
      </div>

      {missing ? (
        <div className="rv-missing">
          <p className="rv-missing-h">Before we can draw your quote</p>
          <ul>
            {missing.missing.map((m) => {
              const f = m.fix;
              return (
                <li key={m.text}>
                  <span>{m.text}</span>
                  {f?.kind === 'step' ? (
                    <button type="button" className="linklike" onClick={() => onFix(f.step)}>{f.label}</button>
                  ) : f?.kind === 'link' ? (
                    <a className="flash-link rv-missing-link" href={f.href}>{f.label}</a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : view.kind === 'unsaved' ? (
        <p className="hint rv-note">The preview appears once the draft is saved. Choose a customer and a quote number first.</p>
      ) : problem && !ready ? (
        <div className="rv-error" role="alert">
          <p>{problem.message}</p>
          <button type="button" className="btn btn-secondary" onClick={retry}>Try again</button>
          <p className="qt-finish-ref">Reference: {problem.diag}</p>
        </div>
      ) : (
        <>
          <a
            className={`rv-page${updating ? ' is-updating' : ''}`}
            href={ready?.previewHref ?? undefined}
            aria-label={ready ? `Page 1 of your quote. Open all ${ready.pageCount} pages full size` : 'Page 1 of your quote is being drawn'}
            aria-busy={!ready || imgState !== 'ok' || undefined}
          >
            {ready && imgState !== 'failed' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={ready.imageUrl}
                src={ready.imageUrl}
                alt=""
                width={794}
                height={1123}
                decoding="async"
                onLoad={() => setImgState('ok')}
                onError={() => setImgState('failed')}
                className={imgState === 'ok' ? 'is-in' : undefined}
              />
            ) : null}
            {!ready || imgState === 'loading' ? <span className="rv-skel" aria-hidden="true"><span /><span /><span /><span /></span> : null}
          </a>
          {problem && ready ? (
            <p className="rv-inline-err" role="alert">
              {problem.message} <button type="button" className="linklike" onClick={retry}>Try again</button> <span className="qt-finish-code">Reference: {problem.diag}</span>
            </p>
          ) : null}
          {ready && imgState === 'failed' ? (
            <p className="rv-inline-err" role="alert">
              The page did not load. <button type="button" className="linklike" onClick={retry}>Try again</button> <span className="qt-finish-code">Reference: PV-IMAGE</span>
            </p>
          ) : null}
          {ready ? (
            <a className="btn btn-secondary rv-all" href={ready.previewHref}>
              See all {ready.pageCount} {ready.pageCount === 1 ? 'page' : 'pages'}
            </a>
          ) : null}
        </>
      )}
    </section>
  );
}
