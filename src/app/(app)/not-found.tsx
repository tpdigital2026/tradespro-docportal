import type { Metadata } from 'next';
import { ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';

export const metadata: Metadata = { title: 'Page not found', description: 'That page is not here.' };

// Inside the app the rail and header are already on screen, so this is just the message and one way on.
export default function AppNotFound() {
  return (
    <div className="page">
      <PageHeader eyebrow="Page not found" title="We cannot find that page" lede="The link may be old, or it may have been deleted. Everything else you have made is still safe." />
      <EmptyState icon="search" title="Looking for something?" action={<ButtonLink href="/">Go to Home</ButtonLink>}>
        Your customers, drafts and jobs are all a tap away from Home.
      </EmptyState>
    </div>
  );
}
