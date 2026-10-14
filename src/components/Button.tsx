import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Common = { variant?: 'primary' | 'secondary'; children: ReactNode; className?: string };

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${variant} ${className}`.trim()} {...rest}>
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
    </Link>
  );
}
