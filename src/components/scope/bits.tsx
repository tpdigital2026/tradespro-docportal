'use client';

import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/** A character counter that appears only near the limit, so it is quiet until it matters. */
export function Counter({ id, length, max }: { id: string; length: number; max: number }) {
  const left = max - length;
  if (length < max * 0.8) return null;
  return (
    <span id={id} className={`sc-count${left <= 0 ? ' is-full' : ''}`} role={left <= 20 ? 'status' : undefined}>
      {length} of {max}
    </span>
  );
}

/** A textarea that grows with what is typed, never below two lines. */
export function AutoTextarea({ value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} {...rest} />;
}
