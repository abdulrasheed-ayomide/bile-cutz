import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ORIGIN, PASSWORD, app, loginAdmin, post, query, queryOne, registerCustomer, request, resetDb, makeService, slotAt, guestBook } from './helpers.js';
import { sha256 } from '../src/lib/crypto.js';

const outboxDir = path.resolve(process.cwd(), '.dev-outbox');
function emails() {
  if (!fs.existsSync(outboxDir)) return [];
  return fs.readdirSync(outboxDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8')));
}
function clearOutbox() {
  fs.rmSync(outboxDir, { recursive: true, force: true });
}

beforeEach(async () => {
  await resetDb();
  clearOutbox();
});

describe('customer registration & login', () => {
  it('registers with valid input and shows the real customer name', async () => {
    const s = await registerCustomer(1, { fullName: 'Ade Bello' });
    expect(s.user.fullName).toBe('Ade Bello');
    expect(s.user.role).toBe('customer');
    const me = await s.agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.fullName).toBe('Ade Bello');
    expect(me.body.user.email).toBe('customer1@example.com');
    expect(JSON.stringify(me.body)).not.toMatch(/admin/i);
    expect(JSON.stringify(me.body)).not.toMatch(/password/i);
  });

  it('rejects duplicate emails regardless of case', async () => {
    await registerCustomer(1);
    const res = await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({
      fullName: 'Other', email: 'CUSTOMER1@Example.com', password: PASSWORD, confirmPassword: PASSWORD,
    });
    expect(res.status).toBe(409);
  });

  it('validates input (mismatch, weak password, bad email)', async () => {
    const base = { fullName: 'X', email: 'x@example.com', password: PASSWORD, confirmPassword: PASSWORD };
    for (const bad of [{ confirmPassword: 'nope' }, { password: 'short1', confirmPassword: 'short1' }, { password: 'allletters', confirmPassword: 'allletters' }, { email: 'not-an-email' }]) {
      const res = await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({ ...base, ...bad });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('stores passwords as argon2id hashes, never plaintext', async () => {
    await registerCustomer(1);
    const row = await queryOne('SELECT password_hash FROM users WHERE email = $1', ['customer1@example.com']);
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
  });

  it('cannot self-assign a role or become admin via email or request body', async () => {
    const res = await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({
      fullName: 'Sneaky', email: 'admin@bilecutz.com', password: PASSWORD, confirmPassword: PASSWORD, role: 'admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('customer');
    const row = await queryOne('SELECT role FROM users WHERE email = $1', ['admin@bilecutz.com']);
    expect(row.role).toBe('customer');
  });

  it('login returns the correct identity and logout ends the session', async () => {
    await registerCustomer(2, { fullName: 'Chidi Okafor' });
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'CUSTOMER2@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('Chidi Okafor');
    expect(res.body.user.role).toBe('customer');
    const out = await agent.post('/api/auth/logout').set('Origin', ORIGIN).set('X-CSRF-Token', res.body.csrfToken);
    expect(out.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('gives a generic error for wrong password and unknown email', async () => {
    await registerCustomer(1);
    const a = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'customer1@example.com', password: 'wrong-Pass1' });
    const b = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'nobody@example.com', password: 'wrong-Pass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('blocks state-changing requests without the CSRF token and from foreign origins', async () => {
    const s = await registerCustomer(1);
    const noCsrf = await s.agent.post('/api/auth/logout').set('Origin', ORIGIN);
    // logout is allowed without csrf (it only ends the session); profile update must be protected:
    expect(noCsrf.status).toBe(200);
    const s2 = await registerCustomer(2);
    const bad = await s2.agent.patch('/api/me/profile').set('Origin', ORIGIN).send({ fullName: 'Hacked' });
    expect(bad.status).toBe(403);
    const foreign = await s2.agent.patch('/api/me/profile').set('Origin', 'https://evil.example').set('X-CSRF-Token', s2.csrf).send({ fullName: 'Hacked' });
    expect(foreign.status).toBe(403);
    const ok = await s2.agent.patch('/api/me/profile').set('Origin', ORIGIN).set('X-CSRF-Token', s2.csrf).send({ fullName: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.fullName).toBe('Renamed');
  });
});

describe('admin authentication is separate', () => {
  it('admin logs in at /api/admin/auth/login only; customers cannot', async () => {
    const admin = await loginAdmin();
    expect(admin.user.role).toBe('admin');
    // admin credentials do not work on the customer endpoint
    const viaCustomer = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'owner@example.com', password: ADMIN_PASSWORD });
    expect(viaCustomer.status).toBe(401);
    // customer credentials do not work on the admin endpoint
    await registerCustomer(1);
    const viaAdmin = await request(app).post('/api/admin/auth/login').set('Origin', ORIGIN).send({ email: 'customer1@example.com', password: PASSWORD });
    expect(viaAdmin.status).toBe(401);
  });

  it('customer sessions cannot reach admin APIs, even if the cookie is replayed under the admin name', async () => {
    const c = await registerCustomer(1);
    expect((await c.agent.get('/api/admin/appointments')).status).toBe(401);
    expect((await c.agent.get('/api/admin/dashboard/summary')).status).toBe(401);
    expect(c.token).toBeTruthy();
    const replay = await request(app).get('/api/admin/appointments').set('Cookie', `bc_admin_session=${c.token}`);
    expect(replay.status).toBe(401);
  });

  it('admin session does not authenticate the customer area', async () => {
    const a = await loginAdmin();
    expect((await a.agent.get('/api/auth/me')).status).toBe(401);
    expect((await a.agent.get('/api/me/appointments')).status).toBe(401);
    expect((await a.agent.get('/api/admin/auth/me')).body.user.role).toBe('admin');
  });

  it('an admin cannot be created through any HTTP route', async () => {
    const res = await request(app).post('/api/admin/auth/register').set('Origin', ORIGIN).send({ email: 'x@example.com', password: ADMIN_PASSWORD });
    expect([401, 404]).toContain(res.status);
  });

  it('the admin provisioning command refuses to hijack an existing customer account', async () => {
    await registerCustomer(1);
    const { provisionAdmin } = await import('../src/services/auth.js');
    await expect(provisionAdmin({ email: 'customer1@example.com', fullName: 'X', password: ADMIN_PASSWORD })).rejects.toThrow(/customer account/);
  });

  it('suspended customers are signed out and cannot log in', async () => {
    const c = await registerCustomer(1);
    await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [c.user.id]);
    expect((await c.agent.get('/api/auth/me')).status).toBe(401);
    const res = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'customer1@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('password recovery', () => {
  it('issues a single-use, hashed, expiring token and does not reveal account existence', async () => {
    await registerCustomer(1);
    const unknown = await request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send({ email: 'ghost@example.com' });
    expect(unknown.status).toBe(202);
    expect(emails()).toHaveLength(0);

    const known = await request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send({ email: 'customer1@example.com' });
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    const mail = emails()[0];
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    const stored = await queryOne('SELECT * FROM password_reset_tokens');
    expect(stored.token_hash).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const newPw = 'Brand-New-Pass9';
    const done = await request(app).post('/api/auth/reset-password').set('Origin', ORIGIN).send({ token, password: newPw, confirmPassword: newPw });
    expect(done.status).toBe(200);
    // cannot be reused
    const again = await request(app).post('/api/auth/reset-password').set('Origin', ORIGIN).send({ token, password: 'Another-Pass99', confirmPassword: 'Another-Pass99' });
    expect(again.status).toBe(400);
    // new password works, old does not
    expect((await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'customer1@example.com', password: newPw })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'customer1@example.com', password: PASSWORD })).status).toBe(401);
  });

  it('rejects expired tokens and revokes sessions on reset', async () => {
    const c = await registerCustomer(1);
    await request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send({ email: 'customer1@example.com' });
    const token = /token=([\w-]+)/.exec(emails()[0].text)![1]!;
    await query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`);
    const res = await request(app).post('/api/auth/reset-password').set('Origin', ORIGIN).send({ token, password: 'Brand-New-Pass9', confirmPassword: 'Brand-New-Pass9' });
    expect(res.status).toBe(400);

    await request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send({ email: 'customer1@example.com' });
    const token2 = /token=([\w-]+)/.exec(emails()[1].text)![1]!;
    expect((await request(app).post('/api/auth/reset-password').set('Origin', ORIGIN).send({ token: token2, password: 'Brand-New-Pass9', confirmPassword: 'Brand-New-Pass9' })).status).toBe(200);
    expect((await c.agent.get('/api/auth/me')).status).toBe(401); // old session revoked
  });

  it('customer reset links cannot reset an admin password (and vice versa)', async () => {
    await loginAdmin();
    await request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send({ email: 'owner@example.com' });
    expect(emails()).toHaveLength(0); // admin accounts get no customer-scope link
    await request(app).post('/api/admin/auth/forgot-password').set('Origin', ORIGIN).send({ email: 'owner@example.com' });
    const token = /token=([\w-]+)/.exec(emails()[0].text)![1]!;
    expect(emails()[0].text).toContain('/admin/reset-password');
    const wrongScope = await request(app).post('/api/auth/reset-password').set('Origin', ORIGIN).send({ token, password: 'Brand-New-Pass9', confirmPassword: 'Brand-New-Pass9' });
    expect(wrongScope.status).toBe(400);
  });

  it('changing the password requires the current password and keeps this session', async () => {
    const c = await registerCustomer(1);
    const bad = await post(c, '/api/me/password', { currentPassword: 'wrong', newPassword: 'Fresh-Pass-77', confirmPassword: 'Fresh-Pass-77' });
    expect(bad.status).toBe(400);
    const ok = await post(c, '/api/me/password', { currentPassword: PASSWORD, newPassword: 'Fresh-Pass-77', confirmPassword: 'Fresh-Pass-77' });
    expect(ok.status).toBe(200);
    expect((await c.agent.get('/api/auth/me')).status).toBe(200);
  });
});

describe('guest booking tokens are not credentials for accounts', () => {
  it('a guest token never works as a session', async () => {
    const svc = await makeService();
    const res = await guestBook(svc.id, slotAt(3, '10:00'));
    const token = res.body.managementToken as string;
    const r = await request(app).get('/api/auth/me').set('Cookie', `bc_session=${token}`);
    expect(r.status).toBe(401);
  });
});
