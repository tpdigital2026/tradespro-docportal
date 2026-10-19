'use client';

import { useEffect, useRef, useState } from 'react';
import { AutoTextarea, Counter } from '../scope/bits';
import { DownIcon, MicIcon, TrashIcon, UpIcon } from '../scope/icons';
import { PHOTO_ACCEPT } from '../../lib/survey/shrink';
import { isFindingApproved, photoLabel, SURVEY_LIMITS, tidyLine, tidyPara, type Finding } from '../../lib/survey/model';

export interface FindingUi {
  uploading: number;
  drafting: boolean;
  approving: boolean;
  notice: string | null;
  error: string | null;
}

export interface Dictation {
  supported: boolean;
  active: string | null;
  start: (id: string, base: string, apply: (text: string) => void, max: number) => void;
  stop: () => void;
}

interface Props {
  finding: Finding;
  index: number;
  count: number;
  ui: FindingUi;
  photos: ReadonlyMap<string, { width: number; height: number }>;
  aiOn: boolean;
  dictation: Dictation;
  canUpload: boolean;
  onChange: (p: Partial<Finding>) => void;
  onAddPhotos: (files: File[]) => void;
  onRemovePhoto: (photoId: string) => void;
  onMovePhoto: (photoId: string, dir: -1 | 1) => void;
  onDraft: () => void;
  onApprove: () => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

const CameraIcon = () => (
  <svg className="sc-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
const GalleryIcon = () => (
  <svg className="sc-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 16l5-5 4 4 3-3 6 6" />
    <circle cx="16" cy="9" r="1.5" />
  </svg>
);
const LeftIcon = () => (
  <svg className="sc-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M14 6l-6 6 6 6" />
  </svg>
);
const RightIcon = () => (
  <svg className="sc-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M10 6l6 6-6 6" />
  </svg>
);

export function FindingCard({ finding: f, index, count, ui, photos, aiOn, dictation, canUpload, onChange, onAddPhotos, onRemovePhoto, onMovePhoto, onDraft, onApprove, onMove, onDelete }: Props) {
  const n = index + 1;
  const id = f.id;
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const approved = isFindingApproved(f);
  const drafted = f.engine !== null || tidyLine(f.title) !== '' || tidyPara(f.observation) !== '';
  const room = SURVEY_LIMITS.photosPerFinding - f.photoIds.length - ui.uploading;
  const missing = [
    f.photoIds.length === 0 ? 'a photo' : null,
    !tidyLine(f.title) ? 'a title' : null,
    !tidyPara(f.observation) ? 'the observation' : null,
    !tidyPara(f.assessment) ? 'your assessment' : null,
  ].filter((x): x is string => x !== null);
  const status = approved ? 'Approved' : drafted ? 'Not approved yet' : 'To do';
  const pick = (input: HTMLInputElement | null) => {
    const files = [...(input?.files ?? [])].slice(0, Math.max(0, room));
    if (input) input.value = '';
    if (files.length) onAddPhotos(files);
  };
  const listening = dictation.active === `${id}-line`;
  // An approved finding folds down to a short summary, so a long report stays easy to scan. "Change" opens it.
  const [open, setOpen] = useState(!approved);
  const was = useRef(approved);
  useEffect(() => {
    if (approved && !was.current) setOpen(false);
    if (!approved) setOpen(true);
    was.current = approved;
  }, [approved]);

  if (approved && !open) {
    return (
      <article className="sv-card is-approved is-folded" aria-labelledby={`${id}-h`}>
        <header className="sv-card-head">
          <h3 id={`${id}-h`} className="sv-card-title">
            <span className="sv-card-n">Finding {n}</span>
            <span className="sv-card-sub">{tidyLine(f.title)}</span>
          </h3>
          <span className="status-chip is-paid">Approved</span>
          <div className="sv-card-tools">
            <button type="button" className="sc-icon-btn" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move finding ${n} up`}><UpIcon /></button>
            <button type="button" className="sc-icon-btn" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move finding ${n} down`}><DownIcon /></button>
          </div>
        </header>
        <div className="sv-fold">
          <ul className="sv-fold-photos" aria-label={`${f.photoIds.length} ${f.photoIds.length === 1 ? 'photo' : 'photos'}`}>
            {f.photoIds.map((pid, k) => {
              const dim = photos.get(pid);
              return (
                <li key={pid}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/surveys/photos/${pid}`} alt={photoLabel(n, k + 1)} width={dim?.width || 400} height={dim?.height || 300} loading="lazy" decoding="async" />
                </li>
              );
            })}
          </ul>
          <p className="sv-fold-text">{tidyPara(f.observation)}</p>
        </div>
        <div className="sv-fold-foot">
          <p className="sv-approved">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            Approved{f.approvedAt ? ` at ${timeFmt.format(new Date(f.approvedAt))}` : ''}
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} aria-expanded="false">Change finding {n}</button>
        </div>
      </article>
    );
  }

  return (
    <article className={`sv-card${approved ? ' is-approved' : ''}`} aria-labelledby={`${id}-h`}>
      <header className="sv-card-head">
        <h3 id={`${id}-h`} className="sv-card-title">
          <span className="sv-card-n">Finding {n}</span>
          {tidyLine(f.title) ? <span className="sv-card-sub">{tidyLine(f.title)}</span> : null}
        </h3>
        <span className={`status-chip ${approved ? 'is-paid' : drafted ? 'is-part' : 'is-draft'}`}>{status}</span>
        <div className="sv-card-tools">
          <button type="button" className="sc-icon-btn" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move finding ${n} up`}><UpIcon /></button>
          <button type="button" className="sc-icon-btn" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move finding ${n} down`}><DownIcon /></button>
          <button type="button" className="sc-icon-btn is-danger" onClick={onDelete} aria-label={`Delete finding ${n}`}><TrashIcon /></button>
        </div>
      </header>

      <section className="sv-photos-edit" aria-label={`Photos for finding ${n}`}>
        <div className="sv-photo-row">
          {f.photoIds.map((pid, k) => {
            const dim = photos.get(pid);
            return (
              <figure key={pid} className="sv-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/surveys/photos/${pid}`} alt={`${photoLabel(n, k + 1)} for finding ${n}`} width={dim?.width || 400} height={dim?.height || 300} loading="lazy" decoding="async" />
                <figcaption>{photoLabel(n, k + 1)}</figcaption>
                <div className="sv-thumb-tools">
                  {f.photoIds.length > 1 ? (
                    <>
                      <button type="button" className="sv-thumb-btn" onClick={() => onMovePhoto(pid, -1)} disabled={k === 0} aria-label={`Move ${photoLabel(n, k + 1)} earlier`}><LeftIcon /></button>
                      <button type="button" className="sv-thumb-btn" onClick={() => onMovePhoto(pid, 1)} disabled={k === f.photoIds.length - 1} aria-label={`Move ${photoLabel(n, k + 1)} later`}><RightIcon /></button>
                    </>
                  ) : null}
                  <button type="button" className="sv-thumb-btn is-danger" onClick={() => onRemovePhoto(pid)} aria-label={`Remove ${photoLabel(n, k + 1)}`}><TrashIcon /></button>
                </div>
              </figure>
            );
          })}
          {Array.from({ length: ui.uploading }, (_, k) => (
            <div key={`up-${k}`} className="sv-thumb is-loading" role="status">
              <span>Adding photo</span>
            </div>
          ))}
          {room > 0 ? (
            <div className="sv-add-photo">
              <button type="button" className="btn btn-secondary sv-photo-btn" onClick={() => camera.current?.click()} disabled={!canUpload}>
                <CameraIcon /> Take a photo
              </button>
              <button type="button" className="btn btn-secondary sv-photo-btn" onClick={() => gallery.current?.click()} disabled={!canUpload}>
                <GalleryIcon /> Choose photos
              </button>
              <input ref={camera} type="file" accept={PHOTO_ACCEPT} capture="environment" hidden onChange={(e) => pick(e.currentTarget)} />
              <input ref={gallery} type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={(e) => pick(e.currentTarget)} />
            </div>
          ) : null}
        </div>
        <p className="hint">
          {f.photoIds.length === 0 ? `One to ${SURVEY_LIMITS.photosPerFinding} photos. They are numbered for you, Photo ${n}.1 and on.` : room > 0 ? `${f.photoIds.length} of ${SURVEY_LIMITS.photosPerFinding} photos.` : `${SURVEY_LIMITS.photosPerFinding} of ${SURVEY_LIMITS.photosPerFinding} photos, the most for one finding.`}
          {!canUpload ? ' Save the details first to add photos.' : ''}
        </p>
      </section>

      <div className="field">
        <label htmlFor={`${id}-line`}>What did you find?</label>
        <p className="hint" id={`${id}-line-hint`}>One line, in your own words. {dictation.supported ? 'Tap the microphone to speak it.' : 'You can use the microphone on your keyboard.'}</p>
        <div className="sv-line">
          <input
            id={`${id}-line`}
            className="input"
            value={f.ownerLine}
            maxLength={SURVEY_LIMITS.ownerLine}
            aria-describedby={`${id}-line-hint`}
            autoComplete="off"
            enterKeyHint="done"
            placeholder="For example: fascias overhang the gutter, water getting behind"
            onChange={(e) => onChange({ ownerLine: e.target.value })}
          />
          {dictation.supported ? (
            <button
              type="button"
              className={`sc-icon-btn sv-mic${listening ? ' is-on' : ''}`}
              aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : `Speak what you found for finding ${n}`}
              onClick={() => (listening ? dictation.stop() : dictation.start(`${id}-line`, f.ownerLine, (t) => onChange({ ownerLine: t }), SURVEY_LIMITS.ownerLine))}
            >
              <MicIcon />
            </button>
          ) : null}
        </div>
      </div>

      <div className="sv-draft-row">
        <button type="button" className="btn btn-secondary" onClick={onDraft} disabled={ui.drafting || tidyLine(f.ownerLine) === ''}>
          {ui.drafting ? 'Drafting' : aiOn ? (drafted ? 'Draft it again' : 'Draft this finding') : drafted ? 'Use my line again' : 'Use my line'}
        </button>
        {drafted ? null : <p className="hint">{aiOn ? 'The AI writes a draft from your line and photos. It adds nothing you did not say, and you check every word.' : 'Your line goes into the observation as you wrote it. Then you add a title and your assessment.'}</p>}
      </div>
      {ui.notice ? <p className="sv-notice" role="status">{ui.notice}</p> : null}

      {drafted ? (
        <div className="sv-words">
          <div className="field">
            <label htmlFor={`${id}-title`}>Title</label>
            <input id={`${id}-title`} className="input" value={f.title} maxLength={SURVEY_LIMITS.title} placeholder="A short title for the list of findings" onChange={(e) => onChange({ title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-obs`}>Observation</label>
            <p className="hint" id={`${id}-obs-hint`}>What you saw.</p>
            <AutoTextarea id={`${id}-obs`} className="input sv-text" value={f.observation} maxLength={SURVEY_LIMITS.observation} aria-describedby={`${id}-obs-hint ${id}-obs-count`} onChange={(e) => onChange({ observation: e.target.value })} />
            <Counter id={`${id}-obs-count`} length={f.observation.length} max={SURVEY_LIMITS.observation} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-ass`}>Professional assessment</label>
            <p className="hint" id={`${id}-ass-hint`}>What it means, in your professional view.</p>
            <AutoTextarea
              id={`${id}-ass`}
              className={`input sv-text${tidyPara(f.assessment) === '' ? ' is-empty' : ''}`}
              value={f.assessment}
              maxLength={SURVEY_LIMITS.assessment}
              placeholder="Add your assessment"
              aria-describedby={`${id}-ass-hint ${id}-ass-count`}
              onChange={(e) => onChange({ assessment: e.target.value })}
            />
            <Counter id={`${id}-ass-count`} length={f.assessment.length} max={SURVEY_LIMITS.assessment} />
          </div>
          {f.uncertain.length ? (
            <div className="sv-check">
              <h4 className="sv-check-h">Please check</h4>
              <ul>{f.uncertain.map((u) => <li key={u}>{u}</li>)}</ul>
            </div>
          ) : null}
          {f.corrections.length ? (
            <div className="sv-check is-quiet">
              <h4 className="sv-check-h">What was changed</h4>
              <ul>{f.corrections.map((u) => <li key={u}>{u}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="sv-approve">
        {approved && f.approvedAt ? (
          <p className="sv-approved" role="status">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            Approved at {timeFmt.format(new Date(f.approvedAt))}. Any change to the words or photos means approving it again.
          </p>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={onApprove} disabled={ui.approving || missing.length > 0} aria-describedby={missing.length ? `${id}-needs` : undefined}>
              {ui.approving ? 'Approving' : `Approve finding ${n}`}
            </button>
            {missing.length ? <p className="hint" id={`${id}-needs`}>To approve, add {missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`}.</p> : <p className="hint">Approve it when every word is right. It goes on the report exactly as it reads here.</p>}
          </>
        )}
        {ui.error ? <p className="error" role="alert">{ui.error}</p> : null}
      </footer>
    </article>
  );
}
