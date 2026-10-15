import type { Metadata } from 'next';
import { ButtonLink } from '../components/Button';
import { Oops } from '../components/Oops';

export const metadata: Metadata = { title: 'Page not found', description: 'That page is not here.' };

export default function NotFound() {
  return (
    <Oops eyebrow="Page not found" title="We cannot find that page" lede="The link may be old, or the page has moved. Everything you have made is still safe.">
      <ButtonLink href="/">Go to Home</ButtonLink>
    </Oops>
  );
}
