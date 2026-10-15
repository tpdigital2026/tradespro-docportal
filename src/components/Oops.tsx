import Image from 'next/image';
import type { ReactNode } from 'react';
import { TRADESPRO_BRAND } from '../lib/brand-core';

/** The shell for "not found" and "something went wrong": navy band with the TradesPro mark, one message, one way on. */
export function Oops({ eyebrow, title, lede, children }: { eyebrow: string; title: string; lede: string; children: ReactNode }) {
  const logo = TRADESPRO_BRAND.logoDark;
  return (
    <div className="oops">
      <header className="oops-bar">
        <Image src={logo.url} width={logo.width} height={logo.height} alt="TradesPro Digital" className="oops-logo" priority />
      </header>
      <main id="main" className="oops-main">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="oops-lede">{lede}</p>
        <div className="oops-actions">{children}</div>
      </main>
    </div>
  );
}
