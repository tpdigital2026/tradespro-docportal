import type { InputHTMLAttributes, Ref } from 'react';

/** A pounds-and-pence text field. Text only: the form turns it into whole pence, never a float. */
export function MoneyField({
  id,
  label,
  hint,
  error,
  prefix = '£',
  ref,
  className,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  prefix?: string;
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'inputMode'>) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
      <div className="money">
        <span className="money-prefix" aria-hidden="true">{prefix}</span>
        <input
          id={id}
          ref={ref}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className={`input money-input${className ? ` ${className}` : ''}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      </div>
      {error ? <p className="error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}
