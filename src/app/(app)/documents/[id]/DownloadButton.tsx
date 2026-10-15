'use client';

import { useEffect, useState } from 'react';

/**
 * Download always works (a plain link with Content-Disposition: attachment). Where the phone can share files, a
 * second button hands the PDF to the share sheet (email, WhatsApp and so on); anywhere else it is not shown.
 */
export function DownloadButton({ href, filename, title }: { href: string; filename: string; title: string }) {
  const [canShare, setCanShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    try {
      const probe = new File([new Uint8Array([37])], 'x.pdf', { type: 'application/pdf' });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      const touch = window.matchMedia('(pointer: coarse)').matches;
      setCanShare(touch && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [probe] }));
    } catch {
      setCanShare(false);
    }
  }, []);

  const share = async () => {
    setProblem(null);
    setBusy(true);
    try {
      const res = await fetch(href, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('fetch');
      const file = new File([await res.blob()], filename, { type: 'application/pdf' });
      await navigator.share({ files: [file], title });
    } catch (e) {
      // Closing the share sheet is not a problem; anything else falls back to the plain download.
      if ((e as { name?: string }).name !== 'AbortError') {
        setProblem('Sharing did not work on this phone, so the PDF is downloading instead.');
        window.location.href = href;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dl-actions">
      <a className="btn btn-primary" href={href} download={filename}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" /></svg>
        Download PDF
      </a>
      {canShare ? (
        <button type="button" className="btn btn-secondary" onClick={share} disabled={busy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" /></svg>
          {busy ? 'Getting it ready' : 'Share'}
        </button>
      ) : null}
      {problem ? <p className="hint" role="status">{problem}</p> : null}
    </div>
  );
}
