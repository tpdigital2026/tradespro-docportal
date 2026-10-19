'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { TenantBrand } from '../lib/brand-core';
import { initials } from '../lib/initials';
import { MoreMenu } from './MoreMenu';
import { PoweredBy } from './PoweredBy';

const icons = {
  home: <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />,
  customers: <path d="M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9M15.5 4.2a3.5 3.5 0 010 6.6" />,
  doc: <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5M12 12v5M9.5 14.5h5" />,
  docs: <path d="M8 7V5a2 2 0 012-2h6l4 4v10a2 2 0 01-2 2h-2M4 9a2 2 0 012-2h6l4 4v8a2 2 0 01-2 2H6a2 2 0 01-2-2V9zM12 7v4h4" />,
  out: <path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9" />,
  settings: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />,
  pipeline: <path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v5h-4z" />,
  money: <path d="M4 7h16v10H4zM12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM7 10v4M17 10v4" />,
  calendar: <path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" />,
  shield: <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3zM9 12l2 2 4-4" />,
};

type IconName = keyof typeof icons;

function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

/** Rail: logo centred with clear space, then the DocPortal label and business name aligned with the nav. */
function RailBrand({ brand }: { brand: TenantBrand }) {
  const logo = brand.logoDark;
  return (
    <div className="rail-brand">
      <div className="rail-logo">
        <Image src={logo.url} width={logo.width} height={logo.height} alt={`${brand.name} logo`} className="brand-logo" priority />
      </div>
      <p className="rail-org"><small>DocPortal</small>{brand.name}</p>
    </div>
  );
}

/** Phone and tablet header: logo, then the name with its own space, never touching the logo. */
function TopBrand({ brand }: { brand: TenantBrand }) {
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
  { href: '/documents', label: 'Documents', icon: 'docs' },
  { href: '/documents/new', label: 'New document', icon: 'doc' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
] as const;

/** The business tabs: in the rail, and behind More on a phone. */
export const businessItems = [
  { href: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { href: '/money', label: 'Money', icon: 'money' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar' },
  { href: '/guarantees', label: 'Guarantees', icon: 'shield' },
] as const;

export function isCurrent(path: string, href: string) {
  if (href === '/') return path === '/';
  // Documents covers the library, each document and each job, but not the "new document" screens.
  if (href === '/documents') return path === href || (path.startsWith('/documents/') && !path.startsWith('/documents/new'));
  return path === href || path.startsWith(`${href}/`);
}

function Nav({ path }: { path: string }) {
  return (
    <ul className="navlist">
      {/* Settings goes last in the rail, after the business tabs. */}
      {[...items.filter((i) => i.href !== '/settings'), ...businessItems, ...items.filter((i) => i.href === '/settings')].map((i) => (
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
          <RailBrand brand={brand} />
          <nav aria-label="Main">
            <Nav path={path} />
          </nav>
        </div>
        <div className="rail-foot">
          <div className="rail-user">
            <span className="rail-avatar" aria-hidden="true">{initials(userName)}</span>
            <span className="rail-user-name">{userName}</span>
          </div>
          <LogOut />
          {brand.isOwnBrand ? null : <PoweredBy variant="rail" />}
        </div>
      </aside>

      <div>
        <div className="topbar">
          <TopBrand brand={brand} />
          {/* Phones keep five tabs at the bottom; Settings sits up here instead of squeezing a sixth in. */}
          <Link href="/settings" className="topbar-settings" aria-current={isCurrent(path, '/settings') ? 'page' : undefined}>
            <Icon name="settings" />
            <span className="sr-only">Settings</span>
          </Link>
        </div>
        <main id="main" tabIndex={-1} className="main">
          {children}
        </main>
        {brand.isOwnBrand ? null : (
          <footer className="main-foot">
            <PoweredBy variant="light" />
          </footer>
        )}
      </div>

      <nav className="bottomnav" aria-label="Main">
        <ul className="navlist">
          {items.filter((i) => i.href !== '/settings').map((i) => (
            <li key={i.href}>
              <Link href={i.href} className="navlink" aria-current={isCurrent(path, i.href) ? 'page' : undefined}>
                <Icon name={i.icon} />
                <span>{i.label === 'New document' ? 'New' : i.label}</span>
              </Link>
            </li>
          ))}
          <li><MoreMenu path={path} entries={businessItems.map((i) => ({ href: i.href, label: i.label, icon: <Icon name={i.icon} />, current: isCurrent(path, i.href) }))} logOut={<LogOut />} /></li>
        </ul>
      </nav>
    </div>
  );
}
