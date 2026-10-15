import { redirect } from 'next/navigation';
import { LoginForm } from '../login/LoginForm';
import { SignIn } from '../../components/SignIn';
import { getBrandBySlug } from '../../lib/brand';
import { getSession } from '../../lib/session';
import { signInMetadata } from '../../lib/site';

// The same lookup as the page: a real business shows its name, anything else the plain sign-in's metadata.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return signInMetadata(await getBrandBySlug(slug));
}

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
