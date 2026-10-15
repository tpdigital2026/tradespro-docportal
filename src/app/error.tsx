'use client';

import { Button } from '../components/Button';
import { Oops } from '../components/Oops';

// Shown when a page fails to load. It never shows the error itself (that could carry private details).
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <Oops eyebrow="Something went wrong" title="That did not load" lede="It is usually a blip in the connection. Try again, and if it keeps happening, let TradesPro Digital know.">
      <Button type="button" onClick={() => reset()}>Try again</Button>
    </Oops>
  );
}
