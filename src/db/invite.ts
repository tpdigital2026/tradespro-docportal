import type { Db } from '../security/login-guard';

export interface InviteArgs {
  email: string;
  tenantName: string;
  role: 'owner' | 'staff';
  fullName: string;
}

export interface AuthAdmin {
  createUser(a: { email: string; email_confirm: boolean }): Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>;
}

const USAGE = 'Usage: npm run invite -- <email> "<business name>" <owner|staff> "<full name>"';

export function parseInviteArgs(argv: string[]): InviteArgs {
  if (argv.length !== 4) throw new Error(USAGE);
  const [email, tenantName, role, fullName] = argv;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That does not look like an email address');
  if (role !== 'owner' && role !== 'staff') throw new Error('The role must be owner or staff');
  if (!tenantName.trim() || !fullName.trim()) throw new Error(USAGE);
  return { email: email.trim().toLowerCase(), tenantName: tenantName.trim(), role, fullName: fullName.trim() };
}

/** Registers a person against one business. Invite only, no passwords. Without a profile row, an email can never get in. */
export async function inviteUser(deps: { admin: AuthAdmin; db: Db }, a: InviteArgs): Promise<{ userId: string; tenantId: string }> {
  const t = await deps.db.query(`select id from public.tenants where name = $1`, [a.tenantName]);
  if (t.rows.length === 0) throw new Error(`No such tenant: ${a.tenantName}`);
  const dup = await deps.db.query(`select 1 from public.profiles where email = $1`, [a.email]);
  if (dup.rows.length > 0) throw new Error(`${a.email} already has a profile`);
  const created = await deps.admin.createUser({ email: a.email, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? 'The user could not be created');
  const userId = created.data.user.id;
  await deps.db.query(`insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, $3, $4, $5)`, [
    userId,
    t.rows[0].id,
    a.role,
    a.fullName,
    a.email,
  ]);
  return { userId, tenantId: t.rows[0].id };
}
