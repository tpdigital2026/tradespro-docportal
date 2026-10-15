import { redirect } from 'next/navigation';
import { SignIn } from '../../components/SignIn';
import { TRADESPRO_BRAND } from '../../lib/brand';
import { getSession } from '../../lib/session';
import { signInMetadata } from '../../lib/site';
import { LoginForm } from './LoginForm';

export const metadata = signInMetadata(TRADESPRO_BRAND);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  if (await getSession()) redirect('/');
  const { notice } = await searchParams;
  return (
    <SignIn brand={TRADESPRO_BRAND}>
      <LoginForm signedOut={notice === 'signed-out'} />
    </SignIn>
  );
}
