import { notFound } from 'next/navigation';
import { SignIn } from '../../../components/SignIn';
import { DEMO_BRAND, TRADESPRO_BRAND } from '../../../lib/brand-core';
import { isDemo } from '../../../lib/demo';
import { LOCKED_TEXT, LoginForm, type PreviewState } from '../../login/LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in preview' };

const STATES: Record<string, PreviewState> = {
  email: { step: 'email' },
  code: { step: 'code' },
  error: { step: 'code', error: 'That code did not work. Check it and try again, or ask for a new one.' },
  locked: { step: 'code', locked: true, error: LOCKED_TEXT },
};

// Demo mode only (never in production or on Vercel): shows every sign-in state without signing out.
export default async function LoginPreview({ searchParams }: { searchParams: Promise<{ state?: string; brand?: string }> }) {
  if (!isDemo()) notFound();
  const { state, brand } = await searchParams;
  return (
    <SignIn brand={brand === 'fjc' ? DEMO_BRAND : TRADESPRO_BRAND}>
      <LoginForm key={state} preview={STATES[state ?? 'email'] ?? STATES.email} />
    </SignIn>
  );
}
