import { readFileSync } from 'node:fs';
import { connect } from '../src/db/connect';
import { redactSecrets } from '../src/db/env';
import { seedFjc } from '../src/db/seed-fjc';
import { seedSignature } from '../src/db/seed-signature';

/**
 * Seeds FJC Roofing Ltd (idempotent; never overwrites the owner's edits). With SIGNATURE_FILE set to a local picture
 * (never committed), also stores it as the business's signature and switches printing on, unless one is already there.
 *
 *   SIGNATURE_FILE=/path/to/signature.png npx tsx --env-file=.env.local scripts/seed-fjc.ts
 */
async function main() {
  const client = await connect();
  try {
    await client.query('begin');
    const r = await seedFjc(client);
    const filled = r.filled ?? [];
    let signature = 'not asked';
    const file = process.env.SIGNATURE_FILE?.trim();
    if (file) {
      const { getStorage } = await import('../src/lib/storage');
      const { reencodeSignature } = await import('../src/lib/render-service');
      signature = await seedSignature(client, getStorage(), r.tenantId, readFileSync(file), (b, i) => reencodeSignature(b, i));
    }
    await client.query('commit');
    console.log(r.created ? 'Seeded FJC Roofing Ltd.' : 'FJC Roofing Ltd already exists.');
    console.log(`Wording keys filled: ${filled.length ? filled.join(', ') : 'none'}. Signature: ${signature}.`);
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(redactSecrets(String(e.message ?? e)));
    process.exit(1);
  });
