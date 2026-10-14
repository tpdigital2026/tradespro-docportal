import { connect } from '../src/db/connect';
import { redactSecrets } from '../src/db/env';
import { seedFjc } from '../src/db/seed-fjc';

async function main() {
  const client = await connect();
  try {
    await client.query('begin');
    const r = await seedFjc(client);
    await client.query('commit');
    console.log(r.created ? 'Seeded FJC Roofing Ltd.' : 'FJC Roofing Ltd already exists.');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(redactSecrets(String(e.message ?? e)));
  process.exit(1);
});
