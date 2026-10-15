'use client';

import { useId, useMemo, useState } from 'react';
import { useDictation } from '../../../../components/scope/useDictation';
import { draftCoveringEmailParts, asCopyText, type CoveringEmailFacts } from '../../../../lib/covering-email';
import { SEND_REMINDER } from '../../../../lib/documents/confirmation';

const NOTES_MAX = 1000;

/**
 * The covering email: a draft made only from what is on the document, a box for the owner's own extra detail (typed,
 * or dictated with the keyboard microphone or the mic button where the browser has speech recognition), Redraft and
 * Copy. Nothing is ever sent from here.
 */
export function EmailPanel({ facts }: { facts: CoveringEmailFacts }) {
  const ids = { notes: useId(), body: useId(), status: useId(), subject: useId() };
  const [notes, setNotes] = useState('');
  const [drafted, setDrafted] = useState(() => draftCoveringEmailParts({ facts }));
  const [body, setBody] = useState(drafted.body);
  const [status, setStatus] = useState('');
  const dict = useDictation();
  const listening = dict.active === 'email-notes';
  const changed = useMemo(() => body !== drafted.body, [body, drafted.body]);

  const redraft = () => {
    const next = draftCoveringEmailParts({ facts, ownerNotes: notes });
    setDrafted(next);
    setBody(next.body);
    setStatus(notes.trim() ? 'Redrafted with your extra detail.' : 'Redrafted.');
  };

  const copy = async () => {
    const text = asCopyText({ subject: drafted.subject, body });
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied. Paste it into your email and attach the PDF.');
    } catch {
      const el = document.getElementById(ids.body) as HTMLTextAreaElement | null;
      el?.select();
      setStatus('Select the text above and copy it with your phone or keyboard.');
    }
  };

  return (
    <section className="email-panel" aria-labelledby="email-h">
      <div className="sec-head">
        <h2 id="email-h" className="section-title">Covering email</h2>
        <p className="section-sub">Copy this into your own email, attach the PDF and send it yourself. Nothing is sent from here.</p>
      </div>

      <div className="field">
        <label htmlFor={ids.notes}>Anything to add?</label>
        <p className="hint" id={`${ids.notes}-h`}>Optional. For example when you can start, or a thank you. Type it, or use the microphone.</p>
        <div className="email-notes">
          <textarea
            id={ids.notes}
            className="input"
            value={notes}
            maxLength={NOTES_MAX}
            rows={3}
            aria-describedby={`${ids.notes}-h`}
            onChange={(e) => setNotes(e.target.value)}
          />
          {dict.supported ? (
            <button
              type="button"
              className={`btn btn-secondary mic-btn${listening ? ' is-on' : ''}`}
              aria-pressed={listening}
              onClick={() => (listening ? dict.stop() : dict.start('email-notes', notes, setNotes, NOTES_MAX))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3" /></svg>
              {listening ? 'Stop' : 'Speak'}
            </button>
          ) : null}
        </div>
        {dict.problem ? <p className="hint" role="status">{dict.problem}</p> : null}
        <div>
          <button type="button" className="btn btn-secondary" onClick={redraft}>Redraft</button>
        </div>
      </div>

      <div className="email-draft">
        <p className="email-subject" id={ids.subject}><span>Subject</span> {drafted.subject}</p>
        <label htmlFor={ids.body} className="sr-only">Email text</label>
        <textarea id={ids.body} className="input email-body" value={body} rows={12} onChange={(e) => setBody(e.target.value)} aria-describedby={ids.subject} />
        {changed ? <p className="hint">You have edited the text. Redraft puts it back to the draft.</p> : null}
      </div>

      <div className="email-actions">
        <button type="button" className="btn btn-secondary" onClick={copy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 9h10v12H9zM5 15V3h10" /></svg>
          Copy email
        </button>
        <p className="send-reminder">{SEND_REMINDER}</p>
        <p className="sr-status" role="status" aria-live="polite" id={ids.status}>{status}</p>
      </div>
    </section>
  );
}
