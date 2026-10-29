import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, query, queryOne } from '../src/db/pool.js';
import { provisionAdmin } from '../src/services/auth.js';
import { addDaysLocal, todayLocal, zonedToUtc } from '../src/lib/time.js';

export const app = createApp();
export const ORIGIN = 'http://localhost:5173';
export const TZ = 'Africa/Lagos';

export const PASSWORD = 'Sup3rSecret!';
export const ADMIN_PASSWORD = 'Adm1n-Passw0rd-Long';

/** Wipes all mutable data and re-applies safe defaults (all days open 09:00–19:00, capacity 2). */
export async function resetDb() {
  await pool.query(`
    TRUNCATE users, sessions, password_reset_tokens, closures, break_periods, opening_hours, business_settings,
             services, appointments, appointment_status_history, notifications, conversations, messages,
             reviews, gallery_images, faqs, audit_logs RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO business_settings (id) VALUES (1)`);
  await pool.query(
    `INSERT INTO opening_hours (day_of_week, is_open, open_time, close_time)
     SELECT d, true, '09:00', '19:00' FROM generate_series(0,6) d`,
  );
  await pool.query(`UPDATE business_settings SET max_simultaneous = 2, min_notice_minutes = 60, slot_interval_minutes = 30,
                    buffer_minutes = 0, allow_same_day = true, max_advance_days = 60, cancellation_deadline_hours = 2`);
}

export async function makeService(over: Partial<{ name: string; price: number; duration: number; active: boolean }> = {}) {
  const row = await queryOne(
    `INSERT INTO services (name, description, price, duration_minutes, is_active) VALUES ($1,'desc',$2,$3,$4) RETURNING *`,
    [over.name ?? 'Classic Haircut', over.price ?? 3000, over.duration ?? 30, over.active ?? true],
  );
  return row as { id: string; name: string; price: number; duration_minutes: number };
}

/** A UTC ISO string for `HH:mm` local time, `daysAhead` days from today in the business timezone. */
export function slotAt(daysAhead: number, time: string): string {
  return zonedToUtc(addDaysLocal(todayLocal(TZ), daysAhead), time, TZ).toISOString();
}

export function dateAhead(daysAhead: number): string {
  return addDaysLocal(todayLocal(TZ), daysAhead);
}

function cookieValue(res: request.Response, name: string): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(';')[0]!.slice(name.length + 1) : '';
}

export interface Session {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  user: any;
  /** raw session cookie value (for replay tests) */
  token: string;
}

/** Registers a customer through the real API and returns an agent holding the session cookie. */
export async function registerCustomer(n = 1, over: Record<string, string> = {}): Promise<Session> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .set('Origin', ORIGIN)
    .send({ fullName: `Customer ${n}`, email: `customer${n}@example.com`, phone: '08012345678', password: PASSWORD, confirmPassword: PASSWORD, ...over });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken, user: res.body.user, token: cookieValue(res, 'bc_session') };
}

export async function loginAdmin(email = 'owner@example.com'): Promise<Session> {
  await provisionAdmin({ email, fullName: 'Shop Owner', password: ADMIN_PASSWORD, role: 'admin' });
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/auth/login').set('Origin', ORIGIN).send({ email, password: ADMIN_PASSWORD });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken, user: res.body.user, token: cookieValue(res, 'bc_admin_session') };
}

export async function loginStaff(email = 'staff@example.com'): Promise<Session> {
  await provisionAdmin({ email, fullName: 'Staff Member', password: ADMIN_PASSWORD, role: 'staff' });
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/auth/login').set('Origin', ORIGIN).send({ email, password: ADMIN_PASSWORD });
  return { agent, csrf: res.body.csrfToken, user: res.body.user, token: cookieValue(res, 'bc_admin_session') };
}

/** Helpers that attach the CSRF header + Origin like the real browser client does. */
export const post = (s: Session, url: string, body: object = {}) => s.agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send(body);
export const patch = (s: Session, url: string, body: object = {}) => s.agent.patch(url).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send(body);
export const put = (s: Session, url: string, body: object = {}) => s.agent.put(url).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send(body);
export const del = (s: Session, url: string, body?: object) => s.agent.delete(url).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send(body ?? {});

export async function guestBook(serviceId: string, startAt: string, over: Record<string, string> = {}) {
  return request(app)
    .post('/api/public/bookings')
    .set('Origin', ORIGIN)
    .send({ serviceId, startAt, name: 'Guest Person', email: 'guest@example.com', phone: '08099998888', ...over });
}

export { pool, query, queryOne, request };
