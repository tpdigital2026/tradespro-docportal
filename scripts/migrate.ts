import path from 'node:path';
import { connect } from '../src/db/connect';
import { applyMigrations } from '../src/db/migrate';

async function main() {
  const client = await connect();
  try {
    const applied = await applyMigrations(client, path.join(process.cwd(), 'supabase', 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
