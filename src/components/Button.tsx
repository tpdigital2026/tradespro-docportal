import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { PendingHint, Spinner } from './PendingHint';

type Common = { variant?: 'primary' | 'secondary'; children: ReactNode; className?: string };

/** `pending`: a server action is running. The button shows a spinner, is disabled and says it is busy. */
export function Button({
  variant = 'primary',
  className = '',
  children,
  ref,
  pending = false,
  disabled,
  ...rest
}: Common & { ref?: Ref<HTMLButtonElement>; pending?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button ref={ref} className={`btn btn-${variant} ${className}`.trim()} disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = 'primary',
  className = '',
  children,
}: Common & { href: string }) {
  return (
    <Link href={href} className={`btn btn-${variant} ${className}`.trim()}>
      {children}
      <PendingHint />
    </Link>
  );
}
