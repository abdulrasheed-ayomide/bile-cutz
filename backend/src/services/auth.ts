import argon2 from 'argon2';
import { env } from '../config/env.js';
import { query, queryOne, withTransaction, pool, type Queryable } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, conflict, forbidden, unauthenticated } from '../lib/errors.js';
import { sendEmail } from './email.js';
import { getSettings } from './settings.js';

export type Scope = 'customer' | 'admin';
export type Role = 'customer' | 'admin' | 'staff';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  phone: string | null;
  role: Role;
  status: 'active' | 'suspended';
  created_at: Date;
}

export function toUserDto(u: UserRow) {
  return {
    id: u.id,
    fullName: u.full_name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    createdAt: new Date(u.created_at).toISOString(),
  };
}
export type UserDto = ReturnType<typeof toUserDto>;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

// --- passwords ---------------------------------------------------------------------------------

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// A real argon2id hash of a random string, used to equalise timing when the account does not exist.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomToken(12)));

// --- sessions ----------------------------------------------------------------------------------

export const COOKIE_NAMES: Record<Scope, string> = { customer: 'bc_session', admin: 'bc_admin_session' };

export interface AuthContext {
  user: UserRow;
  sessionId: string;
  csrfToken: string;
  scope: Scope;
}

export async function createSession(userId: string, scope: Scope, userAgent?: string, db: Queryable = pool) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const ttlMs = env.SESSION_TTL_DAYS * 24 * 3600_000;
  const expiresAt = new Date(Date.now() + (scope === 'admin' ? Math.min(ttlMs, 24 * 3600_000 * 3) : ttlMs));
  await query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, scope, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sha256(token), csrfToken, scope, expiresAt, userAgent?.slice(0, 300) ?? null],
    db,
  );
  return { token, csrfToken, expiresAt };
}

export async function loadSession(token: string, scope: Scope): Promise<AuthContext | null> {
  const row = await queryOne(
    `SELECT s.id AS session_id, s.csrf_token, s.scope, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.scope = $2 AND s.expires_at > now()`,
    [sha256(token), scope],
  );
  if (!row || row.status !== 'active') return null;
  // Session scope and role must agree: a customer account can never hold an admin-scope session.
  const roleOk = scope === 'admin' ? row.role === 'admin' || row.role === 'staff' : row.role === 'customer';
  if (!roleOk) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => {});
  }
  return { user: row as UserRow, sessionId: row.session_id, csrfToken: row.csrf_token, scope };
}

export async function destroySession(token: string) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string, db: Queryable = pool) {
  await query('DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)', [userId, exceptSessionId ?? null], db);
}

// --- registration / login ----------------------------------------------------------------------

export async function registerCustomer(input: { fullName: string; email: string; phone?: string | null; password: string }) {
  const email = normalizeEmail(input.email);
  const hash = await hashPassword(input.password);
  try {
    const rows = await query<UserRow>(
      // role is hard-coded: registration can never create an admin, whatever the email address is.
      `INSERT INTO users (email, password_hash, full_name, phone, role) VALUES ($1,$2,$3,$4,'customer') RETURNING *`,
      [email, hash, input.fullName.trim(), input.phone?.trim() || null],
    );
    return rows[0]!;
  } catch (err: any) {
    if (err?.code === '23505') throw conflict('An account with this email already exists. Try signing in instead.');
    throw err;
  }
}

const INVALID = () => new AppError('UNAUTHENTICATED', 'Incorrect email or password.');

/** Verifies credentials for exactly one scope. Wrong scope == wrong credentials (no role leak). */
export async function authenticate(emailRaw: string, password: string, scope: Scope): Promise<UserRow> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE lower(email) = $1', [normalizeEmail(emailRaw)]);
  const hash = user?.password_hash ?? (await getDummyHash());
  const ok = await verifyPassword(hash, password);
  const roleOk = !!user && (scope === 'admin' ? user.role === 'admin' || user.role === 'staff' : user.role === 'customer');
  if (!user || !ok || !roleOk) throw INVALID();
  if (user.status !== 'active') throw forbidden('This account has been suspended. Please contact the shop.');
  return user;
}

export async function updateProfile(userId: string, input: { fullName: string; phone?: string | null }) {
  const rows = await query<UserRow>(
    `UPDATE users SET full_name = $2, phone = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [userId, input.fullName.trim(), input.phone?.trim() || null],
  );
  return rows[0]!;
}

export async function changePassword(user: UserRow, sessionId: string, currentPassword: string, newPassword: string) {
  if (!(await verifyPassword(user.password_hash, currentPassword))) throw new AppError('VALIDATION_ERROR', 'Your current password is incorrect.');
  const hash = await hashPassword(newPassword);
  await withTransaction(async (c) => {
    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, hash], c);
    await revokeUserSessions(user.id, sessionId, c);
  });
}

// --- password recovery -------------------------------------------------------------------------

const RESET_TTL_MS = 60 * 60_000;

/**
 * Always resolves without revealing whether the account exists. Only accounts that match `scope`
 * receive a link (customers via /reset-password, staff via /admin/reset-password).
 */
export async function requestPasswordReset(emailRaw: string, scope: Scope): Promise<void> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE lower(email) = $1', [normalizeEmail(emailRaw)]);
  if (!user || user.status !== 'active') return;
  const roleOk = scope === 'admin' ? user.role === 'admin' || user.role === 'staff' : user.role === 'customer';
  if (!roleOk) return;
  const token = randomToken(32);
  await query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [
    user.id,
    sha256(token),
    new Date(Date.now() + RESET_TTL_MS),
  ]);
  const settings = await getSettings();
  const base = env.FRONTEND_URL.replace(/\/$/, '');
  const link = `${base}${scope === 'admin' ? '/admin' : ''}/reset-password?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: `Reset your ${settings.businessName} password`,
    text: `Hello ${user.full_name},\n\nUse the link below to choose a new password. It expires in 1 hour and can only be used once.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
    html: `<p>Hello ${escapeHtml(user.full_name)},</p><p>Use the link below to choose a new password. It expires in 1 hour and can only be used once.</p><p><a href="${link}">Reset my password</a></p><p>If you did not ask for this, you can ignore this email.</p>`,
  });
}

export async function resetPassword(token: string, newPassword: string, scope: Scope): Promise<void> {
  const hash = await hashPassword(newPassword);
  await withTransaction(async (c) => {
    // Atomic consume: only one concurrent request can flip used_at.
    const row = await queryOne<{ user_id: string }>(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(token)],
      c,
    );
    const invalid = new AppError('VALIDATION_ERROR', 'This reset link is invalid or has expired. Please request a new one.');
    if (!row) throw invalid;
    const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [row.user_id], c);
    const roleOk = user && (scope === 'admin' ? user.role === 'admin' || user.role === 'staff' : user.role === 'customer');
    if (!user || !roleOk) throw invalid;
    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, hash], c);
    await query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id], c);
    await revokeUserSessions(user.id, undefined, c);
  });
}

// --- admin provisioning ------------------------------------------------------------------------

/** Used only by the `admin:create` CLI. There is deliberately no HTTP route for this. */
export async function provisionAdmin(input: { email: string; fullName: string; password: string; role?: 'admin' | 'staff' }) {
  const email = normalizeEmail(input.email);
  const hash = await hashPassword(input.password);
  // Re-running the command for an existing admin/staff account resets its password. It will NOT
  // silently promote an existing customer account — use a different email for the admin login.
  const rows = await query<UserRow>(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT ((lower(email))) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name, updated_at = now()
       WHERE users.role IN ('admin','staff')
     RETURNING *`,
    [email, hash, input.fullName.trim(), input.role ?? 'admin'],
  );
  if (!rows[0]) throw new Error('That email belongs to a customer account. Use a different email for the admin login.');
  return rows[0];
}

export { unauthenticated };

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
