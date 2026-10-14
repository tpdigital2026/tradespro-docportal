import { redirect } from 'next/navigation';
import { LoginForm } from '../login/LoginForm';
import { SignIn } from '../../components/SignIn';
import { getBrandBySlug } from '../../lib/brand';
import { getSession } from '../../lib/session';

export const metadata = {
  title: 'Sign in | TradesPro Digital',
  description: 'Sign in to TradesPro DocPortal with an emailed code.',
  robots: { index: false, follow: false },
};

// A business's own sign-in address. An unknown or reserved slug gets the same plain TradesPro sign-in
// with the same status, so the address cannot be used to find out which businesses exist.
export default async function BrandedLogin({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (await getSession()) redirect('/');
  const brand = await getBrandBySlug(slug);
  return (
    <SignIn brand={brand}>
      <LoginForm />
    </SignIn>
  );
}
