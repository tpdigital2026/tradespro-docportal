'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import type { SettingsResult } from '../../app/(app)/settings/actions';

export interface Guarded {
  busy: boolean;
  /** True while the fresh-code step is showing. */
  stepUp: boolean;
  message: string;
  error: string;
  errors: Record<string, string>;
  /** Runs a change. When the server asks for a fresh code, the same change runs again once the code is accepted. */
  run(action: () => Promise<SettingsResult>): Promise<boolean>;
  retry(): Promise<void>;
  cancel(): void;
  clear(): void;
}

const FAILED = 'That could not be saved. Nothing was changed. Please try again.';

export function useGuarded(onDone?: () => void): Guarded {
  const router = useRouter();
  const pending = useRef<(() => Promise<SettingsResult>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const go = useCallback(
    async (action: () => Promise<SettingsResult>): Promise<boolean> => {
      setBusy(true);
      setError('');
      setMessage('');
      setErrors({});
      const r = await action().catch((): SettingsResult => ({ status: 'error', message: FAILED }));
      setBusy(false);
      if (r.status === 'step-up') {
        pending.current = action;
        setStepUp(true);
        return false;
      }
      setStepUp(false);
      pending.current = null;
      if (r.status === 'invalid') {
        setErrors(r.errors);
        return false;
      }
      if (r.status === 'error') {
        setError(r.message);
        return false;
      }
      setMessage(r.message);
      onDone?.();
      router.refresh();
      return true;
    },
    [onDone, router],
  );

  return {
    busy,
    stepUp,
    message,
    error,
    errors,
    run: go,
    retry: async () => {
      if (pending.current) await go(pending.current);
    },
    cancel: () => {
      pending.current = null;
      setStepUp(false);
    },
    clear: () => {
      setMessage('');
      setError('');
      setErrors({});
    },
  };
}
