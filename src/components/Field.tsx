import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from 'react';

type Base = { id: string; label: string; hint?: string; error?: string };

export function Field(
  props: Base & { multiline?: false; ref?: Ref<HTMLInputElement> } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>,
): React.JSX.Element;
export function Field(
  props: Base & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>,
): React.JSX.Element;
export function Field(all: Base & { multiline?: boolean } & Record<string, unknown>) {
  const { id, label, hint, error, multiline, className, ...rest } = all;
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
      {error ? <p className="error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}
