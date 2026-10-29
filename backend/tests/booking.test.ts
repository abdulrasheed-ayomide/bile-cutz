import { beforeEach, describe, expect, it } from 'vitest';
import { maxConcurrency } from '../src/services/availability.js';
import { dateAhead, guestBook, loginAdmin, makeService, ORIGIN, post, pool, query, queryOne, registerCustomer, request, app, resetDb, slotAt, TZ } from './helpers.js';
import { zonedToUtc } from '../src/lib/time.js';

beforeEach(resetDb);

const H = 3600_000;
describe('maxConcurrency (capacity maths)', () => {
  it('counts peak overlap, not the number of overlapping rows', () => {
    const a = { start: 9 * H, end: 10 * H };
    const b = { start: 10 * H, end: 11 * H };
    // new booking 09:00–11:00 overlaps both rows, but never more than one at a time
    expect(maxConcurrency([a, b], 9 * H, 11 * H)).toBe(1);
    expect(maxConcurrency([a, a, b], 9 * H, 11 * H)).toBe(2);
  });
  it('treats intervals as half-open (back-to-back bookings do not collide)', () => {
    expect(maxConcurrency([{ start: 9 * H, end: 10 * H }], 10 * H, 11 * H)).toBe(0);
  });
  it('clips to the window', () => {
    expect(maxConcurrency([{ start: 0, end: 100 * H }], 5 * H, 6 * H)).toBe(1);
  });
});

describe('guest and registered booking', () => {
  it('guest booking is created pending with a private token that is stored hashed', async () => {
    const svc = await makeService();
    const res = await guestBook(svc.id, slotAt(3, '10:00'));
    expect(res.status).toBe(201);
    expect(res.body.appointment.status).toBe('pending');
    expect(res.body.appointment.source).toBe('website');
    expect(res.body.appointment.reference).toMatch(/^BC-\d+$/);
    expect(res.body.appointment.localTime).toBe('10:00');
    const token = res.body.managementToken as string;
    expect(token.length).toBeGreaterThan(30);
    expect(res.body.managementPath).toBe(`/booking/manage/${token}`);
    const row = await queryOne('SELECT guest_token_hash FROM appointments');
    expect(row.guest_token_hash).not.toBe(token);
    expect(row.guest_token_hash).toHaveLength(64);

    const view = await request(app).get(`/api/guest/bookings/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.appointment.reference).toBe(res.body.appointment.reference);
    expect(view.body.appointment.history[0].toStatus).toBe('pending');
  });

  it('a guest cannot see another guest booking; the reference alone is not authorization', async () => {
    const svc = await makeService();
    const a = await guestBook(svc.id, slotAt(3, '10:00'), { email: 'a@example.com' });
    const b = await guestBook(svc.id, slotAt(3, '11:00'), { email: 'b@example.com' });
    expect([400, 404]).toContain((await request(app).get(`/api/guest/bookings/${a.body.appointment.reference}`)).status);
    expect((await request(app).get(`/api/guest/bookings/${'x'.repeat(43)}`)).status).toBe(404);
    const viewB = await request(app).get(`/api/guest/bookings/${b.body.managementToken}`);
    expect(viewB.body.appointment.customer.email).toBe('b@example.com');
    expect(JSON.stringify(viewB.body)).not.toContain('a@example.com');
  });

  it('registered customer bookings attach to the account and return no guest token', async () => {
    const svc = await makeService();
    const c = await registerCustomer(1, { fullName: 'Tunde A' });
    const res = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'ignored', email: 'ignored@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.managementToken).toBeUndefined();
    expect(res.body.appointment.customer.userId).toBe(c.user.id);
    expect(res.body.appointment.customer.name).toBe('Tunde A');
    expect(res.body.appointment.customer.email).toBe('customer1@example.com');
    const list = await c.agent.get('/api/me/appointments?tab=upcoming');
    expect(list.body.total).toBe(1);
    // a stale/missing CSRF token on a logged-in booking is rejected
    const noCsrf = await c.agent.post('/api/public/bookings').set('Origin', ORIGIN).send({ serviceId: svc.id, startAt: slotAt(3, '12:00'), name: 'x', email: 'x@example.com' });
    expect(noCsrf.status).toBe(403);
  });

  it('notifies the customer and staff about a new booking, without duplicates', async () => {
    const svc = await makeService();
    await loginAdmin();
    const c = await registerCustomer(1);
    const res = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const rows = await query('SELECT recipient_user_id, type, entity_type, entity_id FROM notifications ORDER BY type');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === 'booking_submitted' && r.entity_type === 'appointment' && r.entity_id === res.body.appointment.id)).toBe(true);
    expect(new Set(rows.map((r) => r.recipient_user_id)).size).toBe(2);
  });

  it('rejects a duplicate double-submit of the same booking', async () => {
    const svc = await makeService();
    const a = await guestBook(svc.id, slotAt(3, '10:00'));
    const b = await guestBook(svc.id, slotAt(3, '10:00'));
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
  });

  it('validates the payload', async () => {
    const svc = await makeService();
    for (const bad of [{ email: 'nope' }, { name: '' }, { startAt: 'tomorrow' }, { serviceId: 'abc' }]) {
      const res = await guestBook(svc.id, slotAt(3, '10:00'), bad as any);
      expect(res.status).toBe(400);
    }
  });
});

describe('availability rules enforced on the server', () => {
  it('rejects past slots, too-soon slots and times outside the grid/hours', async () => {
    const svc = await makeService();
    expect((await guestBook(svc.id, slotAt(-1, '10:00'))).status).toBe(409);
    expect((await guestBook(svc.id, slotAt(3, '10:15'))).status).toBe(409); // not on the 30-minute grid
    expect((await guestBook(svc.id, slotAt(3, '08:00'))).status).toBe(409); // before opening
    expect((await guestBook(svc.id, slotAt(3, '19:00'))).status).toBe(409); // at closing
    expect((await guestBook(svc.id, slotAt(3, '18:30'))).status).toBe(201); // ends exactly at closing
    await pool.query(`UPDATE business_settings SET min_notice_minutes = 20000`);
    expect((await guestBook(svc.id, slotAt(1, '10:00'))).status).toBe(409);
  });

  it('honours same-day, advance limit, closures, closed weekdays and breaks', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET allow_same_day = false`);
    const today = await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${dateAhead(0)}`);
    expect(today.body.slots.every((s: any) => !s.available)).toBe(true);
    await pool.query(`UPDATE business_settings SET max_advance_days = 5`);
    expect((await guestBook(svc.id, slotAt(10, '10:00'))).status).toBe(409);
    expect((await guestBook(svc.id, slotAt(4, '10:00'))).status).toBe(201);

    await pool.query(`INSERT INTO closures (start_date, end_date, kind, reason) VALUES ($1,$1,'holiday','Holiday')`, [dateAhead(3)]);
    expect((await guestBook(svc.id, slotAt(3, '10:00'))).status).toBe(409);
    const avail = await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${dateAhead(3)}`);
    expect(avail.body.slots).toEqual([]);
    const dates = await request(app).get(`/api/public/availability/dates?serviceId=${svc.id}&month=${dateAhead(3).slice(0, 7)}`);
    expect(dates.body.dates.find((d: any) => d.date === dateAhead(3)).available).toBe(false);

    const dow = new Date(`${dateAhead(2)}T12:00:00Z`).getUTCDay();
    await pool.query(`UPDATE opening_hours SET is_open = false WHERE day_of_week = $1`, [dow]);
    expect((await guestBook(svc.id, slotAt(2, '10:00'))).status).toBe(409);

    const dow2 = new Date(`${dateAhead(4)}T12:00:00Z`).getUTCDay();
    await pool.query(`INSERT INTO break_periods (day_of_week, start_time, end_time) VALUES ($1,'13:00','14:00')`, [dow2]);
    expect((await guestBook(svc.id, slotAt(4, '13:00'), { email: 'b1@example.com' })).status).toBe(409);
    expect((await guestBook(svc.id, slotAt(4, '12:30'), { email: 'b2@example.com' })).status).toBe(201); // ends exactly when the break starts
  });

  it('service duration changes which slots are available', async () => {
    const long = await makeService({ name: 'Colour', duration: 120 });
    const date = dateAhead(3);
    const res = await request(app).get(`/api/public/availability?serviceId=${long.id}&date=${date}`);
    const times = res.body.slots.map((s: any) => s.time);
    expect(times[0]).toBe('09:00');
    expect(times.at(-1)).toBe('17:00'); // 17:00 + 2h = 19:00 close
    expect(times).not.toContain('17:30');
    expect((await guestBook(long.id, slotAt(3, '17:30'))).status).toBe(409);
    expect((await guestBook(long.id, slotAt(3, '17:00'))).status).toBe(201);
  });

  it('buffer time extends the blocked interval for capacity', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET max_simultaneous = 1, buffer_minutes = 30`);
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'a@example.com' })).status).toBe(201);
    // 30 min service + 30 min buffer -> next free slot is 11:00
    expect((await guestBook(svc.id, slotAt(3, '10:30'), { email: 'b@example.com' })).status).toBe(409);
    expect((await guestBook(svc.id, slotAt(3, '11:00'), { email: 'c@example.com' })).status).toBe(201);
  });

  it('abandoned booking forms never consume a slot', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET max_simultaneous = 1`);
    for (let i = 0; i < 5; i++) {
      const r = await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${dateAhead(3)}`);
      expect(r.body.slots.find((s: any) => s.time === '10:00').available).toBe(true);
    }
    expect((await queryOne('SELECT count(*)::int AS n FROM appointments')).n).toBe(0);
    expect((await guestBook(svc.id, slotAt(3, '10:00'))).status).toBe(201);
    const after = await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${dateAhead(3)}`);
    expect(after.body.slots.find((s: any) => s.time === '10:00').available).toBe(false);
  });

  it('inactive and soft-deleted services cannot be booked', async () => {
    const svc = await makeService({ active: false });
    expect((await guestBook(svc.id, slotAt(3, '10:00'))).status).toBe(404);
    const svc2 = await makeService({ name: 'Gone' });
    await pool.query(`UPDATE services SET deleted_at = now() WHERE id = $1`, [svc2.id]);
    expect((await guestBook(svc2.id, slotAt(3, '10:00'))).status).toBe(404);
    expect((await request(app).get('/api/public/services')).body.items).toHaveLength(0);
  });
});

describe('capacity and concurrency', () => {
  it('allows overlapping bookings up to capacity and rejects beyond it', async () => {
    const svc = await makeService();
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'a@example.com' })).status).toBe(201);
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'b@example.com' })).status).toBe(201);
    const third = await guestBook(svc.id, slotAt(3, '10:00'), { email: 'c@example.com' });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('handles partially overlapping intervals correctly (sweep, not row count)', async () => {
    const hour = await makeService({ name: 'Hour', duration: 60 });
    const two = await makeService({ name: 'Two hours', duration: 120 });
    // A 09:00–10:00, B 10:00–11:00 sequential; C 09:00–11:00 overlaps both rows but peak is 1+1 = 2 <= capacity 2
    expect((await guestBook(hour.id, slotAt(3, '09:00'), { email: 'a@example.com' })).status).toBe(201);
    expect((await guestBook(hour.id, slotAt(3, '10:00'), { email: 'b@example.com' })).status).toBe(201);
    expect((await guestBook(two.id, slotAt(3, '09:00'), { email: 'c@example.com' })).status).toBe(201);
    // now 09:00–10:00 has A and C (full) and 10:00–11:00 has B and C (full)
    expect((await guestBook(hour.id, slotAt(3, '09:30'), { email: 'd@example.com' })).status).toBe(409);
    expect((await guestBook(hour.id, slotAt(3, '11:00'), { email: 'e@example.com' })).status).toBe(201);
  });

  it('cancelled, rejected and completed bookings release capacity; pending ones hold it', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET max_simultaneous = 1`);
    const admin = await loginAdmin();
    const a = await guestBook(svc.id, slotAt(3, '10:00'), { email: 'a@example.com' });
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'b@example.com' })).status).toBe(409);
    expect((await post(admin, `/api/admin/appointments/${a.body.appointment.id}/reject`, { reason: 'Full' })).status).toBe(200);
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'b@example.com' })).status).toBe(201);
  });

  it('simultaneous requests can never exceed capacity', async () => {
    const svc = await makeService();
    const attempts = 12;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) => guestBook(svc.id, slotAt(3, '10:00'), { email: `race${i}@example.com`, name: `Racer ${i}` })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(2); // max_simultaneous = 2
    expect(rejected).toBe(attempts - 2);
    expect((await queryOne(`SELECT count(*)::int AS n FROM appointments WHERE status IN ('pending','approved')`)).n).toBe(2);
  });

  it('simultaneous requests with overlapping (not identical) start times also respect capacity', async () => {
    const hour = await makeService({ name: 'Hour', duration: 60 });
    await pool.query(`UPDATE business_settings SET max_simultaneous = 3`);
    const times = ['09:00', '09:30', '10:00', '09:00', '09:30', '10:00', '09:30', '09:00'];
    const results = await Promise.all(times.map((t, i) => guestBook(hour.id, slotAt(3, t), { email: `r${i}@example.com` })));
    // Verify the invariant directly in the database: at no instant do more than 3 active bookings overlap.
    const rows = await query(`SELECT start_at, blocked_until FROM appointments WHERE status IN ('pending','approved')`);
    const events: [number, number][] = [];
    for (const r of rows) events.push([r.start_at.getTime(), 1], [r.blocked_until.getTime(), -1]);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, peak = 0;
    for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === 201).length).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('changing max_simultaneous in settings changes booking behaviour immediately', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET max_simultaneous = 1`);
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'a@example.com' })).status).toBe(201);
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'b@example.com' })).status).toBe(409);
    await pool.query(`UPDATE business_settings SET max_simultaneous = 3`);
    expect((await guestBook(svc.id, slotAt(3, '10:00'), { email: 'b@example.com' })).status).toBe(201);
  });
});

describe('timezone behaviour', () => {
  it('interprets opening hours in the configured timezone', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET timezone = 'America/New_York'`);
    const date = dateAhead(3);
    const res = await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${date}`);
    expect(res.body.timezone).toBe('America/New_York');
    expect(res.body.slots[0].time).toBe('09:00');
    expect(res.body.slots[0].startAt).toBe(zonedToUtc(date, '09:00', 'America/New_York').toISOString());
    // The Lagos 09:00 instant is NOT a valid slot in New York any more
    expect((await guestBook(svc.id, zonedToUtc(date, '09:00', TZ).toISOString())).status).toBe(409);
    expect((await guestBook(svc.id, zonedToUtc(date, '09:00', 'America/New_York').toISOString())).status).toBe(201);
  });
});

describe('admin-created bookings', () => {
  it('records walk-in/phone bookings as approved using the same capacity checks', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    await pool.query(`UPDATE business_settings SET max_simultaneous = 1`);
    const res = await post(admin, '/api/admin/appointments', { serviceId: svc.id, startAt: slotAt(1, '10:00'), name: 'Walk In Guy', phone: '08011112222', source: 'walk_in' });
    expect(res.status).toBe(201);
    expect(res.body.appointment.status).toBe('approved');
    expect(res.body.appointment.source).toBe('walk_in');
    expect(res.body.appointment.whatsapp.chatLink).toContain('https://wa.me/2348011112222');
    expect(res.body.appointment.history[0].changedByRole).toBe('admin');
    const clash = await post(admin, '/api/admin/appointments', { serviceId: svc.id, startAt: slotAt(1, '10:00'), name: 'Another', source: 'phone' });
    expect(clash.status).toBe(409);
    // a website booking also sees the slot as taken
    expect((await guestBook(svc.id, slotAt(1, '10:00'))).status).toBe(409);
    // staff can book inside the public notice window / same day, but not in the past
    expect((await post(admin, '/api/admin/appointments', { serviceId: svc.id, startAt: slotAt(-1, '10:00'), name: 'Past', source: 'other' })).status).toBe(409);
  });

  it('staff availability dates endpoint works and requires staff', async () => {
    const svc = await makeService();
    const month = dateAhead(2).slice(0, 7);
    expect((await request(app).get(`/api/admin/availability/dates?serviceId=${svc.id}&month=${month}`)).status).toBe(401);
    const admin = await loginAdmin();
    const res = await admin.agent.get(`/api/admin/availability/dates?serviceId=${svc.id}&month=${month}`);
    expect(res.status).toBe(200);
    expect(res.body.dates.find((d: any) => d.date === dateAhead(2)).available).toBe(true);
  });

  it('the admin availability endpoint requires staff', async () => {
    const svc = await makeService();
    expect((await request(app).get(`/api/admin/availability?serviceId=${svc.id}&date=${dateAhead(2)}`)).status).toBe(401);
    const admin = await loginAdmin();
    expect((await admin.agent.get(`/api/admin/availability?serviceId=${svc.id}&date=${dateAhead(2)}`)).status).toBe(200);
  });
});

describe('status workflow, history and snapshots', () => {
  it('approve → complete, with history, notifications and enforced transitions', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;

    const ok = await post(admin, `/api/admin/appointments/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.appointment.status).toBe('approved');
    expect((await post(admin, `/api/admin/appointments/${id}/approve`)).status).toBe(409); // already approved
    expect((await post(admin, `/api/admin/appointments/${id}/reject`)).status).toBe(409); // approved -> rejected not allowed
    expect((await post(admin, `/api/admin/appointments/${id}/complete`)).status).toBe(409); // start time not reached
    await pool.query(`UPDATE appointments SET start_at = now() - interval '2 hours', end_at = now() - interval '90 minutes', blocked_until = now() - interval '90 minutes' WHERE id = $1`, [id]);
    expect((await post(admin, `/api/admin/appointments/${id}/complete`)).status).toBe(200);

    const detail = await admin.agent.get(`/api/admin/appointments/${id}`);
    expect(detail.body.appointment.history.map((h: any) => h.toStatus)).toEqual(['pending', 'approved', 'completed']);
    expect(detail.body.appointment.history[1].changedByName).toBe('Shop Owner');
    const types = (await query('SELECT type FROM notifications WHERE recipient_user_id = $1', [c.user.id])).map((r) => r.type).sort();
    expect(types).toEqual(['booking_approved', 'booking_completed', 'booking_submitted']);
  });

  it('rejection stores the reason and notifies the customer', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const res = await post(admin, `/api/admin/appointments/${created.body.appointment.id}/reject`, { reason: 'Barber unavailable' });
    expect(res.body.appointment.status).toBe('rejected');
    expect(res.body.appointment.statusReason).toBe('Barber unavailable');
    const n = await queryOne(`SELECT * FROM notifications WHERE recipient_user_id = $1 AND type = 'booking_rejected'`, [c.user.id]);
    expect(n.body).toContain('Barber unavailable');
    expect(n.entity_id).toBe(created.body.appointment.id);
  });

  it('keeps the original service name, price and duration after the service is edited or deactivated', async () => {
    const svc = await makeService({ name: 'Original Cut', price: 3000, duration: 30 });
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    await pool.query(`UPDATE services SET name = 'Renamed', price = 9999, duration_minutes = 90, is_active = false WHERE id = $1`, [svc.id]);
    const res = await c.agent.get(`/api/me/appointments/${created.body.appointment.id}`);
    expect(res.body.appointment.service).toMatchObject({ name: 'Original Cut', price: 3000, durationMinutes: 30 });
    await pool.query(`DELETE FROM services WHERE id = $1`, [svc.id]); // even a hard delete keeps history
    const after = await c.agent.get(`/api/me/appointments/${created.body.appointment.id}`);
    expect(after.status).toBe(200);
    expect(after.body.appointment.service).toMatchObject({ id: null, name: 'Original Cut', price: 3000 });
  });
});

describe('cancellation policy', () => {
  it('customer can cancel before the deadline, history records actor, staff are notified', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;
    const detail = await c.agent.get(`/api/me/appointments/${id}`);
    expect(detail.body.appointment.canCancel).toBe(true);
    const res = await post(c, `/api/me/appointments/${id}/cancel`, { reason: 'Plans changed' });
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('cancelled');
    expect(res.body.appointment.cancelledByRole).toBe('customer');
    expect(res.body.appointment.cancelledAt).toBeTruthy();
    const row = await queryOne('SELECT cancelled_by FROM appointments WHERE id = $1', [id]);
    expect(row.cancelled_by).toBe(c.user.id);
    // not deleted; history preserved
    expect((await admin.agent.get(`/api/admin/appointments/${id}`)).body.appointment.history.map((h: any) => h.toStatus)).toEqual(['pending', 'cancelled']);
    const staffNotes = await query(`SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = 'booking_cancelled'`, [admin.user.id]);
    expect(staffNotes).toHaveLength(1);
    // cannot cancel twice
    expect((await post(c, `/api/me/appointments/${id}/cancel`)).status).toBe(409);
  });

  it('blocks cancellation inside the deadline window (customers and guests)', async () => {
    const svc = await makeService();
    await pool.query(`UPDATE business_settings SET cancellation_deadline_hours = 100, min_notice_minutes = 0`);
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;
    expect((await c.agent.get(`/api/me/appointments/${id}`)).body.appointment.canCancel).toBe(false);
    expect((await post(c, `/api/me/appointments/${id}/cancel`)).status).toBe(403);
    const g = await guestBook(svc.id, slotAt(3, '12:00'), { email: 'g@example.com' });
    const res = await request(app).post(`/api/guest/bookings/${g.body.managementToken}/cancel`).set('Origin', ORIGIN).send({});
    expect(res.status).toBe(403);
    await pool.query(`UPDATE business_settings SET cancellation_deadline_hours = 2`);
    const ok = await request(app).post(`/api/guest/bookings/${g.body.managementToken}/cancel`).set('Origin', ORIGIN).send({ reason: 'sorry' });
    expect(ok.status).toBe(200);
    expect(ok.body.appointment.status).toBe('cancelled');
    expect(ok.body.appointment.cancelledByRole).toBe('guest');
  });

  it('customers cannot approve, complete or otherwise change status through any customer route', async () => {
    const svc = await makeService();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;
    expect((await post(c, `/api/admin/appointments/${id}/approve`)).status).toBe(401);
    expect((await post(c, `/api/me/appointments/${id}/approve`)).status).toBe(404);
    expect((await post(c, `/api/me/appointments/${id}/complete`)).status).toBe(404);
    expect((await queryOne('SELECT status FROM appointments WHERE id = $1', [id])).status).toBe('pending');
  });
});

describe('privacy between customers', () => {
  it('a customer cannot read, cancel or print another customer’s booking', async () => {
    const svc = await makeService();
    const a = await registerCustomer(1);
    const b = await registerCustomer(2);
    const admin = await loginAdmin();
    const created = await post(a, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;
    await post(admin, `/api/admin/appointments/${id}/approve`);
    expect((await b.agent.get(`/api/me/appointments/${id}`)).status).toBe(404);
    expect((await b.agent.get(`/api/me/appointments/${id}/confirmation`)).status).toBe(404);
    expect((await post(b, `/api/me/appointments/${id}/cancel`)).status).toBe(404);
    expect((await b.agent.get('/api/me/appointments')).body.total).toBe(0);
    expect((await queryOne('SELECT status FROM appointments WHERE id = $1', [id])).status).toBe('approved');
    expect((await b.agent.get('/api/me/appointments/not-a-uuid')).status).toBe(400);
  });

  it('printable confirmation is only available for approved bookings', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;
    expect((await c.agent.get(`/api/me/appointments/${id}/confirmation`)).status).toBe(403);
    await post(admin, `/api/admin/appointments/${id}/approve`);
    const ok = await c.agent.get(`/api/me/appointments/${id}/confirmation`);
    expect(ok.status).toBe(200);
    expect(ok.body.appointment.reference).toBe(created.body.appointment.reference);
    expect(ok.body.business.name).toBe('Bile Cutz');
    expect(ok.body.business.address).toBeTruthy();
  });

  it('claiming a guest booking needs its private token and cannot be stolen', async () => {
    const svc = await makeService();
    const g = await guestBook(svc.id, slotAt(3, '10:00'));
    const token = g.body.managementToken;
    const a = await registerCustomer(1);
    const b = await registerCustomer(2);
    expect((await post(a, '/api/me/claim-booking', { token: g.body.appointment.reference.padEnd(30, 'x') })).status).toBe(404);
    const ok = await post(a, '/api/me/claim-booking', { token });
    expect(ok.status).toBe(200);
    expect(ok.body.appointment.customer.userId).toBe(a.user.id);
    expect((await a.agent.get('/api/me/appointments')).body.total).toBe(1);
    expect((await post(b, '/api/me/claim-booking', { token })).status).toBe(409);
    expect((await b.agent.get('/api/me/appointments')).body.total).toBe(0);
  });

  it('admin lists support filters and search', async () => {
    const s1 = await makeService({ name: 'Cut' });
    const s2 = await makeService({ name: 'Beard' });
    const admin = await loginAdmin();
    await guestBook(s1.id, slotAt(3, '10:00'), { name: 'Alice Smith', email: 'alice@example.com' });
    const b = await guestBook(s2.id, slotAt(4, '10:00'), { name: 'Bob Jones', email: 'bob@example.com' });
    await post(admin, `/api/admin/appointments/${b.body.appointment.id}/approve`);
    const all = await admin.agent.get('/api/admin/appointments');
    expect(all.body.total).toBe(2);
    expect((await admin.agent.get('/api/admin/appointments?q=alice')).body.total).toBe(1);
    expect((await admin.agent.get('/api/admin/appointments?q=%25')).body.total).toBe(0); // wildcard is escaped
    expect((await admin.agent.get('/api/admin/appointments?status=approved')).body.items[0].customer.name).toBe('Bob Jones');
    expect((await admin.agent.get(`/api/admin/appointments?serviceId=${s1.id}`)).body.total).toBe(1);
    expect((await admin.agent.get(`/api/admin/appointments?date=${dateAhead(3)}`)).body.total).toBe(1);
    expect((await admin.agent.get('/api/admin/appointments?source=walk_in')).body.total).toBe(0);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 10 * 86400_000).toISOString();
    expect((await admin.agent.get(`/api/admin/appointments/calendar?from=${from}&to=${to}`)).body.items).toHaveLength(2);
  });
});
