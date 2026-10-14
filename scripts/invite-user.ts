import { createClient } from '@supabase/supabase-js';
import { connect } from '../src/db/connect';
import { redactSecrets } from '../src/db/env';
import { inviteUser, parseInviteArgs } from '../src/db/invite';

function redactAll(message: string): string {
  let out = redactSecrets(message);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key) out = out.split(key).join('[redacted]');
  return out;
}

async function main() {
  const args = parseInviteArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local)');
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = await connect();
  try {
    const r = await inviteUser({ admin: supabase.auth.admin, db }, args);
    console.log(`Invited ${args.email} to ${args.tenantId ? 'tenant ' + args.tenantId : args.tenantName} as ${args.role} (user ${r.userId}).`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(redactAll(String(e.message ?? e)));
  process.exit(1);
});
