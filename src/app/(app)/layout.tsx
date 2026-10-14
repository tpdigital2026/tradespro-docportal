import type { ReactNode } from 'react';
import { Shell } from '../../components/Shell';
import { isDemo } from '../../lib/demo';
import { demoSession } from '../../lib/demo-data';

// Task 2 replaces this gate with real session checks.
export default function AppLayout({ children }: { children: ReactNode }) {
  if (!isDemo()) {
    return (
      <div className="notice">
        <h1>Sign-in is not available yet</h1>
        <p>Please check back soon.</p>
      </div>
    );
  }
  return (
    <Shell businessName={demoSession.businessName} userName={demoSession.fullName}>
      {children}
    </Shell>
  );
}
