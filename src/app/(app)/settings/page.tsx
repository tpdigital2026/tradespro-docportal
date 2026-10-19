import type { Metadata } from 'next';
import { PageHeader } from '../../../components/PageHeader';
import { BankAccounts } from '../../../components/settings/BankAccounts';
import { BusinessDetailsSettings } from '../../../components/settings/BusinessDetailsSettings';
import { PaymentWordingSettings } from '../../../components/settings/PaymentWordingSettings';
import { RetentionSettings, SessionSettings } from '../../../components/settings/PolicySettings';
import { SignatureSettings } from '../../../components/settings/SignatureSettings';
import { getSettings } from '../../../lib/data/settings';
import { isDemo } from '../../../lib/demo';
import { requireSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings', description: 'Business details, bank accounts, the payment wording on invoices, your signature, how long customer data is kept and when people are signed out.' };

export default async function SettingsPage() {
  const session = await requireSession();
  const settings = await getSettings();
  const isOwner = session.role === 'owner';
  const demo = isDemo();
  const common = { isOwner, email: session.email, demo };
  return (
    <div className="ws">
      <PageHeader
        title="Settings"
        lede={
          isOwner
            ? 'Your business details, where customers pay you, your signature, how long customer data is kept and when people are signed out. Most changes ask for a fresh code from your email first.'
            : 'How your business is set up. Only the owner can change these settings.'
        }
      />
      <div className="set-layout">
        <div className="set-main">
          <section className="set-sec" id="bank" aria-labelledby="bank-h">
            <div className="sec-head">
              <h2 id="bank-h" className="section-title">Bank accounts</h2>
              <p className="section-sub">Where your customers pay. Invoices use the default account unless you pick another on the quote.</p>
            </div>
            <BankAccounts accounts={settings.bankAccounts} {...common} />
          </section>

          <section className="set-sec" id="wording" aria-labelledby="wording-h">
            <div className="sec-head">
              <h2 id="wording-h" className="section-title">Payment wording</h2>
              <p className="section-sub">What your invoices say about when and how to pay. You write it; nothing here is filled in for you.</p>
            </div>
            <PaymentWordingSettings wording={settings.paymentWording} {...common} />
          </section>

          <section className="set-sec" id="signature" aria-labelledby="sig-h">
            <div className="sec-head">
              <h2 id="sig-h" className="section-title">Your signature</h2>
              <p className="section-sub">Optional. Off until you switch it on, and you can switch it off at any time.</p>
            </div>
            <SignatureSettings consent={settings.signature.consent} hasImage={settings.signature.hasImage} ownerName={settings.business.ownerName} ownerTitle={settings.business.ownerTitle} {...common} />
          </section>

          <section className="set-sec" id="retention" aria-labelledby="ret-h">
            <div className="sec-head">
              <h2 id="ret-h" className="section-title">Customer data</h2>
              <p className="section-sub">Customer details are only kept while you are working with them.</p>
            </div>
            <RetentionSettings days={settings.retentionDays} {...common} />
          </section>

          <section className="set-sec" id="sessions" aria-labelledby="sess-h">
            <div className="sec-head">
              <h2 id="sess-h" className="section-title">Signing out</h2>
              <p className="section-sub">Keeps your documents and your customers&rsquo; details safe if a phone or laptop goes missing.</p>
            </div>
            <SessionSettings idleMinutes={settings.session.idleMinutes} maxDays={settings.session.maxDays} {...common} />
          </section>
        </div>

        <aside className="set-side" id="business" aria-labelledby="biz-h">
          <h2 id="biz-h" className="section-title">Business details</h2>
          <BusinessDetailsSettings business={settings.business} {...common} />
        </aside>
      </div>
    </div>
  );
}
