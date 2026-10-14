import { redirect } from 'next/navigation';
import { PageHeader } from '../../components/PageHeader';
import { getSession } from '../../lib/session';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in | TradesPro DocPortal' };

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  return (
    <main id="main" className="login">
      <PageHeader eyebrow="DocPortal" muted="Welcome back." title="Sign in with an emailed code" lede="We email you a 6 digit code. No password to remember." />
      <LoginForm />
    </main>
  );
}
