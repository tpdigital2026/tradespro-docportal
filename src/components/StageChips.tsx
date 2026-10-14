import type { JobProgress } from '../lib/job-stage';

/**
 * A rail of ticks, one per step (4 to 22), plus the current step in words and "Step n of m", so colour is never
 * the only signal. The ticks are decorative; the words carry the meaning.
 */
export function StageChips({ progress }: { progress: JobProgress }) {
  const { steps, currentIndex } = progress;
  const dense = steps.length > 12;
  return (
    <div className="stage">
      <ol className={`stage-rail${dense ? ' is-dense' : ''}`} aria-hidden="true">
        {steps.map((s, i) => (
          <li key={s.key} className={i < currentIndex ? 'is-done' : i === currentIndex ? 'is-now' : undefined} />
        ))}
      </ol>
      <p className="stage-label">
        <span>{steps[currentIndex].label}</span>
        <span className="stage-count">Step {currentIndex + 1} of {steps.length}</span>
      </p>
    </div>
  );
}
