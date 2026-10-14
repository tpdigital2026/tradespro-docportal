import { redirect } from 'next/navigation';
import { SignIn } from '../../components/SignIn';
import { TRADESPRO_BRAND } from '../../lib/brand';
import { getSession } from '../../lib/session';
import { LoginForm } from './LoginForm';

export const metadata = {
  title: 'Sign in | TradesPro Digital',
  description: 'Sign in to TradesPro DocPortal with an emailed code.',
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  return (
    <SignIn brand={TRADESPRO_BRAND}>
      <LoginForm />
    </SignIn>
  );
}
