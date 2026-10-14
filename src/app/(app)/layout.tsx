import type { ReactNode } from 'react';
import { Shell } from '../../components/Shell';
import { requireSession } from '../../lib/session';

// Convenience only: layouts are not a security boundary (they do not re-run on client navigation),
// so every page under (app) calls requireSession() itself.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <Shell businessName={session.businessName} userName={session.fullName}>
      {children}
    </Shell>
  );
}
