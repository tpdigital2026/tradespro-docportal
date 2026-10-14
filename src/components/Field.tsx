import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from 'react';

/** announce: whether a shown error is a live alert. Forms that show errors while the person types turn it off so a screen reader reads the error on focus (aria-describedby) instead of on every keystroke. */
type Base = { id: string; label: string; hint?: string; error?: string; announce?: boolean };

export function Field(
  props: Base & { multiline?: false; ref?: Ref<HTMLInputElement> } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>,
): React.JSX.Element;
export function Field(
  props: Base & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>,
): React.JSX.Element;
export function Field(all: Base & { multiline?: boolean } & Record<string, unknown>) {
  const { id, label, hint, error, announce = true, multiline, className, ...rest } = all;
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    className: `input${className ? ` ${String(className)}` : ''}`,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
      {multiline ? <textarea {...common} {...rest} /> : <input {...common} {...rest} />}
      {error ? <p className="error" id={`${id}-error`} role={announce ? 'alert' : undefined}>{error}</p> : null}
    </div>
  );
}
