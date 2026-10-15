import { NOTE_LABEL, type CopySection, type ScopeFormValues } from '../../lib/scope/model';

/** What the customer will read, as plain reading text (not a PDF mock-up). */
export function ScopePreview({ scope, sections, caption }: { scope: ScopeFormValues; sections: CopySection[]; caption: string }) {
  const cards = scope.specCards.filter((c) => c.value.trim() !== '' || c.label.trim() !== '');
  const note = scope.note.trim();
  return (
    <aside className="sc-preview" aria-label="What the customer will read">
      <p className="eyebrow">What the customer will read</p>
      <p className="sc-preview-cap">{caption}</p>
      <h3 className="sc-pv-title">{scope.coverTitle.trim() || 'Your quotation'}</h3>
      {scope.coverSub.trim() ? <p className="sc-pv-sub">{scope.coverSub.trim()}</p> : null}
      {scope.intro.trim() ? <p className="sc-pv-intro">{scope.intro.trim()}</p> : null}
      {cards.length > 0 ? (
        <dl className="sc-pv-cards">
          {cards.map((c, i) => (
            <div key={i}>
              <dt>{c.label.trim() || ' '}</dt>
              <dd>{c.value.trim() || ' '}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sections.length === 0 ? (
        <p className="sc-pv-empty">Your steps will show here as you add them.</p>
      ) : (
        sections.map((s, i) => (
          <section key={i} className="sc-pv-sec">
            <h4>{s.heading}</h4>
            <ul>
              {s.steps.map((b, j) => (
                <li key={j}>{b}</li>
              ))}
            </ul>
          </section>
        ))
      )}
      {note ? (
        <div className="sc-pv-note">
          <p className="eyebrow">{NOTE_LABEL}</p>
          <p>{note}</p>
        </div>
      ) : null}
    </aside>
  );
}
