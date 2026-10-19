/**
 * Read-only check that FJC Roofing Ltd, as stored, can create, preview and finalise every document type without being
 * asked for set-up. Prints pass or fail per document type and nothing else (no wording, names or figures).
 *
 *   npx tsx --env-file=.env.local scripts/check-fjc-readiness.ts
 */
import { connect } from '../src/db/connect';
import { redactSecrets } from '../src/db/env';
import { brandWith, businessWith } from '../src/lib/documents/facts-sql';
import { readinessChecks } from '../src/lib/readiness/check';
import { todayLondon } from '../src/lib/london';

async function main() {
  const c = await connect();
  let failed = 0;
  try {
    await c.query('begin read only');
    const t = await c.query(`select id from public.tenants where name = 'FJC Roofing Ltd'`);
    if (!t.rows[0]) {
      console.log('FAIL business: FJC Roofing Ltd not found');
      process.exitCode = 1;
      return;
    }
    const tenantId = String(t.rows[0].id);
    const biz = await businessWith(c, tenantId);
    console.log(`${biz.business && !biz.problems.length ? 'PASS' : 'FAIL'} business facts`);
    console.log(`${biz.business?.wording ? 'PASS' : 'FAIL'} stored wording passes the schema`);
    if (!biz.business) return;
    const brand = await brandWith(c, tenantId, biz.slug);
    console.log(`${brand.problems.length ? 'FAIL' : 'PASS'} document colours and logo`);
    const w = biz.business.wording;
    console.log(`${w?.balance_invoice.dueLabel ? 'PASS' : 'FAIL'} balance invoice Due line (dueLabel)`);
    console.log(`${w?.deposit_invoice.terms.includes('{balance}') ? 'PASS' : 'FAIL'} deposit terms name the balance ({balance})`);
    console.log(`${w?.paymentReference ? 'PASS' : 'FAIL'} payment reference convention`);
    const sig = await c.query(`select (select count(*) from public.brand_assets where tenant_id = $1 and kind = 'signature')::int n, (select signature_consent from public.tenant_defaults where tenant_id = $1) as consent`, [tenantId]);
    console.log(`${sig.rows[0].n > 0 && sig.rows[0].consent === true ? 'PASS' : 'FAIL'} signature stored and printing on (optional: never blocks a document)`);
    for (const i of readinessChecks(biz.business, brand.problems, todayLondon())) {
      if (!i.ok) failed += 1;
      console.log(`${i.ok ? 'PASS' : 'FAIL'} ${i.name}: no set-up message`);
    }
    await c.query('rollback');
  } finally {
    await c.end();
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(redactSecrets(String(e.message ?? e)));
  process.exit(1);
});
