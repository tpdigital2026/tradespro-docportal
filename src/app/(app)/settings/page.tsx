import type { Metadata } from 'next';
import { PageHeader } from '../../../components/PageHeader';
import { BankAccounts } from '../../../components/settings/BankAccounts';
import { RetentionSettings, SessionSettings } from '../../../components/settings/PolicySettings';
import { SignatureSettings } from '../../../components/settings/SignatureSettings';
import { getSettings, type BusinessDetails } from '../../../lib/data/settings';
import { isDemo } from '../../../lib/demo';
import { requireSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings', description: 'Bank accounts, your signature, how long customer data is kept and when people are signed out.' };

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value ? undefined : 'is-missing'}>{value || 'Not on record'}</dd>
    </div>
  );
}

function Business({ b }: { b: BusinessDetails }) {
  const address = [...b.addressLines, b.postcode].filter(Boolean).join(', ');
  return (
    <>
      <dl className="set-dl">
        <Detail label="Business name" value={b.name} />
        <Detail label="Address" value={address} />
        <Detail label="Phone" value={b.phone} />
        <Detail label="Email" value={b.email} />
        <Detail label="Website" value={b.website} />
        <Detail label="Company number" value={b.companyNumber} />
        <Detail label="VAT number" value={b.vatNumber} />
      </dl>
      <p className="set-note">These print on every document. To change these, contact TradesPro Digital.</p>
    </>
  );
}

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
            ? 'Where customers pay you, your signature, how long customer data is kept and when people are signed out. Most changes ask for a fresh code from your email first.'
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

        <aside className="set-side" aria-labelledby="biz-h">
          <h2 id="biz-h" className="section-title">Business details</h2>
          <Business b={settings.business} />
        </aside>
      </div>
    </div>
  );
}
