import { STAGES, STAGE_LABELS, stageIndex, type Stage } from '../lib/job-stage';

/** A short rail of six ticks plus the stage name in words, so colour is never the only signal. */
export function StageChips({ stage }: { stage: Stage }) {
  const at = stageIndex(stage);
  return (
    <div className="stage">
      <ol className="stage-rail" aria-hidden="true">
        {STAGES.map((s, i) => (
          <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : undefined} />
        ))}
      </ol>
      <p className="stage-label">
        <span>{STAGE_LABELS[stage]}</span>
        <span className="stage-count">Step {at + 1} of {STAGES.length}</span>
      </p>
    </div>
  );
}
