'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { TenantBrand } from '../lib/brand-core';
import { PoweredBy } from './PoweredBy';

const icons = {
  home: <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />,
  customers: <path d="M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9M15.5 4.2a3.5 3.5 0 010 6.6" />,
  doc: <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5M12 12v5M9.5 14.5h5" />,
  out: <path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9" />,
};

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

function Brand({ brand }: { brand: TenantBrand }) {
  const logo = brand.logoDark;
  return (
    <div className="brand">
      <Image src={logo.url} width={logo.width} height={logo.height} alt={`${brand.name} logo`} className="brand-logo" priority />
      <p className="brand-name"><small>DocPortal</small>{brand.name}</p>
    </div>
  );
}

const items = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/customers', label: 'Customers', icon: 'customers' },
  { href: '/documents/new', label: 'New document', icon: 'doc' },
] as const;

function isCurrent(path: string, href: string) {
  return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
}

function Nav({ path }: { path: string }) {
  return (
    <ul className="navlist">
      {items.map((i) => (
        <li key={i.href}>
          <Link href={i.href} className="navlink" aria-current={isCurrent(path, i.href) ? 'page' : undefined}>
            <Icon name={i.icon} />
            <span>{i.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function LogOut() {
  return (
    <form method="post" action="/api/auth/logout">
      <button type="submit" className="navlink">
        <Icon name="out" />
        <span>Log out</span>
      </button>
    </form>
  );
}

export function Shell({
  brand,
  userName,
  children,
}: {
  brand: TenantBrand;
  userName: string;
  children: ReactNode;
}) {
  const path = usePathname();
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>

      <aside className="rail">
        <div>
          <Brand brand={brand} />
          <nav aria-label="Main">
            <Nav path={path} />
          </nav>
        </div>
        <div className="rail-foot">
          {brand.isOwnBrand ? null : <PoweredBy variant="rail" />}
          <p>{userName}</p>
          <LogOut />
        </div>
      </aside>

      <div>
        <div className="topbar">
          <Brand brand={brand} />
          {brand.isOwnBrand ? null : (
            <p className="topbar-powered">
              <span>Powered by</span>
              <Image src="/tradespro-logo.png" width={704} height={355} alt="TradesPro Digital" />
            </p>
          )}
        </div>
        <main id="main" tabIndex={-1} className="main">
          {children}
        </main>
      </div>

      <nav className="bottomnav" aria-label="Main">
        <ul className="navlist">
          {items.map((i) => (
            <li key={i.href}>
              <Link href={i.href} className="navlink" aria-current={isCurrent(path, i.href) ? 'page' : undefined}>
                <Icon name={i.icon} />
                <span>{i.label === 'New document' ? 'New' : i.label}</span>
              </Link>
            </li>
          ))}
          <li><LogOut /></li>
        </ul>
      </nav>
    </div>
  );
}
