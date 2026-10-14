/**
 * A neutral, wordless illustration of a document page for the sign-in panel: no business name, no contact
 * details, no figures. Colours come from tokens through classes in app.css.
 */
export function SamplePage() {
  const rows = [0, 1, 2, 3];
  return (
    <svg className="sheet" viewBox="0 0 420 594" role="img" aria-label="Illustration of a document page" xmlns="http://www.w3.org/2000/svg">
      <rect className="sheet-paper" width="420" height="594" />
      <rect className="sheet-head" width="420" height="230" />
      <rect className="sheet-bar" x="36" y="36" width="72" height="24" rx="4" opacity="0.9" />
      <rect className="sheet-bar" x="36" y="120" width="250" height="22" rx="4" />
      <rect className="sheet-bar" x="36" y="154" width="190" height="22" rx="4" />
      <rect className="sheet-accent" x="36" y="190" width="56" height="5" />
      {rows.map((i) => (
        <g key={i}>
          <rect className="sheet-bar-strong" x="36" y={262 + i * 34} width="64" height="8" rx="2" opacity="0.5" />
          <rect className="sheet-bar" x="130" y={260 + i * 34} width={i % 2 ? 190 : 230} height="12" rx="3" />
        </g>
      ))}
      <rect className="sheet-bar" x="36" y="420" width="348" height="9" rx="3" />
      <rect className="sheet-bar" x="36" y="440" width="320" height="9" rx="3" />
      <rect className="sheet-bar" x="36" y="460" width="200" height="9" rx="3" />
      <rect className="sheet-foot" y="552" width="420" height="42" />
    </svg>
  );
}
