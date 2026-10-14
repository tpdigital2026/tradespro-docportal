import Image from 'next/image';
import { TRADESPRO_BRAND } from '../lib/brand-core';

/** "Powered by TradesPro Digital" with the real wordmark. The rail is navy, the sign-in page is white, so the light variant sits the wordmark in a navy badge. */
export function PoweredBy({ variant }: { variant: 'rail' | 'light' }) {
  const logo = TRADESPRO_BRAND.logoDark;
  const img = <Image src={logo.url} width={logo.width} height={logo.height} alt="TradesPro Digital" />;
  if (variant === 'rail') {
    return (
      <div className="powered-rail">
        <span>Powered by</span>
        {img}
      </div>
    );
  }
  return (
    <p className="powered">
      <span>Powered by</span>
      <span className="powered-logo">{img}</span>
    </p>
  );
}
