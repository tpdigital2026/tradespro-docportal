import type { Db } from '../security/login-guard';

export interface InviteArgs {
  email: string;
  tenantName: string;
  role: 'owner' | 'staff';
  fullName: string;
  /** Optional: pick the business by id instead of by name. */
  tenantId?: string;
}

export interface AuthAdmin {
  createUser(a: { email: string; email_confirm: boolean }): Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>;
  deleteUser(id: string): Promise<{ error: { message: string } | null }>;
}

const USAGE = 'Usage: npm run invite -- <email> "<business name>" <owner|staff> "<full name>" [--tenant-id <uuid>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInviteArgs(rawArgv: string[]): InviteArgs {
  let argv = rawArgv;
  let tenantId: string | undefined;
  const flag = argv.indexOf('--tenant-id');
  if (flag !== -1) {
    tenantId = argv[flag + 1];
    if (!tenantId || !UUID.test(tenantId)) throw new Error('--tenant-id needs a valid uuid');
    argv = [...argv.slice(0, flag), ...argv.slice(flag + 2)];
  }
  if (argv.length !== 4) throw new Error(USAGE);
  const [email, tenantName, role, fullName] = argv;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That does not look like an email address');
  if (role !== 'owner' && role !== 'staff') throw new Error('The role must be owner or staff');
  if (!tenantName.trim() || !fullName.trim()) throw new Error(USAGE);
  const parsed: InviteArgs = { email: email.trim().toLowerCase(), tenantName: tenantName.trim(), role, fullName: fullName.trim() };
  if (tenantId) parsed.tenantId = tenantId.toLowerCase();
  return parsed;
}

/** Registers a person against one business. Invite only, no passwords. Without a profile row, an email can never get in. */
export async function inviteUser(deps: { admin: AuthAdmin; db: Db }, a: InviteArgs): Promise<{ userId: string; tenantId: string }> {
  const t = a.tenantId
    ? await deps.db.query(`select id from public.tenants where id = $1`, [a.tenantId])
    : await deps.db.query(`select id from public.tenants where lower(name) = lower($1)`, [a.tenantName]);
  if (t.rows.length === 0) throw new Error(`No such tenant: ${a.tenantId ?? a.tenantName}`);
  if (t.rows.length > 1) throw new Error(`More than one tenant matches "${a.tenantName}"; pass --tenant-id`);
  const dup = await deps.db.query(`select 1 from public.profiles where email = $1`, [a.email]);
  if (dup.rows.length > 0) throw new Error(`${a.email} already has a profile`);
  const created = await deps.admin.createUser({ email: a.email, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? 'The user could not be created');
  const userId = created.data.user.id;
  try {
    await deps.db.query(`insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, $3, $4, $5)`, [
      userId,
      t.rows[0].id,
      a.role,
      a.fullName,
      a.email,
    ]);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Without a profile the new login is useless and would block a retry, so take it away again.
    const removed = await deps.admin.deleteUser(userId).then((r) => r.error, (err) => ({ message: String(err) }));
    throw new Error(
      removed
        ? `The profile could not be created (${reason}) and the new login could not be removed (${removed.message}); delete user ${userId} by hand`
        : `The profile could not be created (${reason}); the new login was removed`,
    );
  }
  return { userId, tenantId: t.rows[0].id };
}
