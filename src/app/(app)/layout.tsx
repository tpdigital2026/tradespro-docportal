import type { ReactNode } from 'react';
import { Shell } from '../../components/Shell';
import { brandStyle, getTenantBrand } from '../../lib/brand';
import { requireSession } from '../../lib/session';

// Convenience only: layouts are not a security boundary (they do not re-run on client navigation),
// so every page under (app) calls requireSession() itself.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const brand = await getTenantBrand(session.tenantId);
  // The business accent is applied as validated CSS variable overrides on this root only.
  return (
    <div className="brandroot" style={brandStyle(brand)}>
      <Shell brand={brand} userName={session.fullName}>
        {children}
      </Shell>
    </div>
  );
}
