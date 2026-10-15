'use client';

import { useActionState } from 'react';
import { reviseSurveyAction, type SurveyReviseState } from '../new/survey-actions';

/** Correcting an issued survey report: says plainly what will happen before it does. */
export function SurveyReviseForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<SurveyReviseState, FormData>(reviseSurveyAction, null);
  return (
    <form action={action} className="doc-revise">
      <input type="hidden" name="id" value={id} />
      <p className="hint">A correction is a new version. The report you finalised stays as it is. Every finding and your opinion must be approved again, and you read and tick the new version before it is final.</p>
      <button type="submit" className="btn btn-secondary" disabled={pending}>{pending ? 'Opening the report' : 'Correct this report'}</button>
      {state ? <p className="form-error" role="alert">{state.message}</p> : null}
    </form>
  );
}
