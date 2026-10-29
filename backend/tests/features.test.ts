import http from 'node:http';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, del, dateAhead, guestBook, loginAdmin, loginStaff, makeService, ORIGIN, patch, post, pool, put, queryOne, registerCustomer, request, resetDb, slotAt } from './helpers.js';
import { attachSocket } from '../src/realtime/socket.js';
import { setIo } from '../src/realtime/emitter.js';
import { runCleanup } from '../src/services/cleanup.js';

beforeEach(resetDb);

async function completedAppointment(c: Awaited<ReturnType<typeof registerCustomer>>, svcId: string) {
  const created = await post(c, '/api/public/bookings', { serviceId: svcId, startAt: slotAt(5, '14:00'), name: 'n', email: 'n@example.com' });
  const id = created.body.appointment.id;
  await pool.query(`UPDATE appointments SET status='completed', start_at = now() - interval '2 hours', end_at = now() - interval '90 minutes', blocked_until = now() - interval '90 minutes' WHERE id = $1`, [id]);
  return id as string;
}

describe('private chat (REST)', () => {
  it('keeps each customer’s conversation private and routes admin replies correctly', async () => {
    const admin = await loginAdmin();
    const a = await registerCustomer(1);
    const b = await registerCustomer(2);
    const ca = (await a.agent.get('/api/chat/conversation')).body.conversation;
    const cb = (await b.agent.get('/api/chat/conversation')).body.conversation;
    expect(ca.id).not.toBe(cb.id);
    expect((await post(a, `/api/chat/conversations/${ca.id}/messages`, { body: 'Hello from A', clientMessageId: 'a-1' })).status).toBe(201);
    expect((await post(b, `/api/chat/conversations/${cb.id}/messages`, { body: 'Hello from B', clientMessageId: 'b-1' })).status).toBe(201);

    // B cannot read or write into A's conversation
    expect((await b.agent.get(`/api/chat/conversations/${ca.id}/messages`)).status).toBe(404);
    expect((await post(b, `/api/chat/conversations/${ca.id}/messages`, { body: 'intrusion', clientMessageId: 'x' })).status).toBe(404);
    expect((await post(b, `/api/chat/conversations/${ca.id}/read`)).status).toBe(404);
    // customers cannot use the staff inbox
    expect((await b.agent.get('/api/admin/chat/conversations')).status).toBe(401);

    const inbox = await admin.agent.get('/api/admin/chat/conversations');
    expect(inbox.body.total).toBe(2);
    expect(inbox.body.items.map((i: any) => i.unreadCount)).toEqual([1, 1]);
    expect(inbox.body.items.map((i: any) => i.customer.fullName).sort()).toEqual(['Customer 1', 'Customer 2']);

    // admin replies to A only
    expect((await post(admin, `/api/admin/chat/conversations/${ca.id}/messages`, { body: 'Hi A, welcome', clientMessageId: 'r-1' })).status).toBe(201);
    const aMsgs = (await a.agent.get(`/api/chat/conversations/${ca.id}/messages`)).body.items;
    expect(aMsgs.map((m: any) => m.body)).toEqual(['Hello from A', 'Hi A, welcome']);
    expect(aMsgs[1].senderRole).toBe('staff');
    const bMsgs = (await b.agent.get(`/api/chat/conversations/${cb.id}/messages`)).body.items;
    expect(bMsgs.map((m: any) => m.body)).toEqual(['Hello from B']);

    // unread counts: A has 1 unread (admin reply); admin has 1 unread (B)
    expect((await a.agent.get('/api/chat/conversation')).body.conversation.unreadCount).toBe(1);
    await post(a, `/api/chat/conversations/${ca.id}/read`);
    expect((await a.agent.get('/api/chat/conversation')).body.conversation.unreadCount).toBe(0);
    await post(admin, `/api/admin/chat/conversations/${ca.id}/read`); // replying alone does not mark the customer's message read
    const inbox2 = await admin.agent.get('/api/admin/chat/conversations?unread=1');
    expect(inbox2.body.items.map((i: any) => i.customer.fullName)).toEqual(['Customer 2']);
    expect((await admin.agent.get('/api/admin/dashboard/summary')).body.unreadConversations).toBe(1);
  });

  it('persists messages (idempotent resend), supports paging and catch-up after a reconnect', async () => {
    const a = await registerCustomer(1);
    const conv = (await a.agent.get('/api/chat/conversation')).body.conversation;
    for (let i = 1; i <= 5; i++) await post(a, `/api/chat/conversations/${conv.id}/messages`, { body: `m${i}`, clientMessageId: `c${i}` });
    const dup = await post(a, `/api/chat/conversations/${conv.id}/messages`, { body: 'm5', clientMessageId: 'c5' });
    expect(dup.status).toBe(201);
    expect((await queryOne('SELECT count(*)::int AS n FROM messages')).n).toBe(5);
    const page1 = (await a.agent.get(`/api/chat/conversations/${conv.id}/messages?limit=3`)).body;
    expect(page1.items.map((m: any) => m.body)).toEqual(['m3', 'm4', 'm5']);
    expect(page1.hasMore).toBe(true);
    const page2 = (await a.agent.get(`/api/chat/conversations/${conv.id}/messages?limit=3&before=${page1.items[0].id}`)).body;
    expect(page2.items.map((m: any) => m.body)).toEqual(['m1', 'm2']);
    expect(page2.hasMore).toBe(false);
    const missed = (await a.agent.get(`/api/chat/conversations/${conv.id}/messages?after=${page1.items[0].id}`)).body.items;
    expect(missed.map((m: any) => m.body)).toEqual(['m4', 'm5']);
    // fresh login (simulating reload) still sees all messages
    const re = request.agent(app);
    await re.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'customer1@example.com', password: 'Sup3rSecret!' });
    expect((await re.get(`/api/chat/conversations/${conv.id}/messages?limit=100`)).body.items).toHaveLength(5);
    // validation
    expect((await post(a, `/api/chat/conversations/${conv.id}/messages`, { body: '   ' })).status).toBe(400);
    expect((await post(a, `/api/chat/conversations/${conv.id}/messages`, { body: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('creates one reusable chat notification per conversation and links to it', async () => {
    const admin = await loginAdmin();
    const a = await registerCustomer(1);
    const conv = (await a.agent.get('/api/chat/conversation')).body.conversation;
    for (const t of ['one', 'two', 'three']) await post(a, `/api/chat/conversations/${conv.id}/messages`, { body: t, clientMessageId: t });
    const notes = await admin.agent.get('/api/admin/notifications');
    expect(notes.body.items).toHaveLength(1);
    expect(notes.body.items[0]).toMatchObject({ type: 'chat_message', entityType: 'conversation', entityId: conv.id, read: false });
    await post(admin, `/api/admin/chat/conversations/${conv.id}/read`);
    expect((await admin.agent.get('/api/admin/notifications/unread-count')).body.unreadCount).toBe(0);
  });
});

describe('private chat (Socket.IO)', () => {
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    server = http.createServer(app);
    attachSocket(server);
    await new Promise<void>((r) => { server.listen(0, () => r()); });
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { setIo(null); await new Promise<void>((r) => { server.close(() => r()); }); });

  const connect = async (s: Awaited<ReturnType<typeof registerCustomer>>, path: string): Promise<Socket> => {
    const { body } = await s.agent.post(path).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf);
    const sock = ioClient(url, { auth: { ticket: body.ticket }, transports: ['websocket'], forceNew: true });
    await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
    return sock;
  };
  const once = <T>(sock: Socket, ev: string) => new Promise<T>((res) => sock.once(ev, res as any));

  it('rejects unauthenticated sockets and delivers messages only to the right people', async () => {
    await expect(new Promise((res, rej) => { const s = ioClient(url, { auth: { ticket: 'bad' }, transports: ['websocket'], forceNew: true }); s.on('connect', () => res(null)); s.on('connect_error', (e) => { s.close(); rej(e); }); })).rejects.toThrow(/unauthorized/);

    const admin = await loginAdmin();
    const a = await registerCustomer(1);
    const b = await registerCustomer(2);
    const ca = (await a.agent.get('/api/chat/conversation')).body.conversation;
    await b.agent.get('/api/chat/conversation');
    const sa = await connect(a, '/api/chat/socket-ticket');
    const sb = await connect(b, '/api/chat/socket-ticket');
    const ss = await connect(admin, '/api/admin/chat/socket-ticket');
    const received: string[] = [];
    sb.on('message:new', (p) => received.push(p.message.body));

    const forAdmin = once<any>(ss, 'message:new');
    const ack = await new Promise<any>((res) => sa.emit('message:send', { conversationId: ca.id, body: 'live hello', clientMessageId: 's1' }, res));
    expect(ack.ok).toBe(true);
    expect((await queryOne('SELECT body FROM messages WHERE id = $1', [ack.message.id])).body).toBe('live hello'); // persisted before ack
    expect((await forAdmin).message.body).toBe('live hello');

    const forA = once<any>(sa, 'message:new');
    const ack2 = await new Promise<any>((res) => ss.emit('message:send', { conversationId: ca.id, body: 'staff reply', clientMessageId: 's2' }, res));
    expect(ack2.ok).toBe(true);
    expect((await forA).message.body).toBe('staff reply');

    // B tries to inject into A's conversation over the socket
    const bad = await new Promise<any>((res) => sb.emit('message:send', { conversationId: ca.id, body: 'sneaky', clientMessageId: 's3' }, res));
    expect(bad.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([]); // B never saw A's messages
    expect((await queryOne(`SELECT count(*)::int AS n FROM messages WHERE body = 'sneaky'`)).n).toBe(0);
    [sa, sb, ss].forEach((s) => s.close());
  });

  it('pushes live notifications to the recipient only', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const a = await registerCustomer(1);
    const b = await registerCustomer(2);
    const sa = await connect(a, '/api/chat/socket-ticket');
    const sb = await connect(b, '/api/chat/socket-ticket');
    const leaked: any[] = [];
    sb.on('notification:new', (p) => leaked.push(p));
    const got = once<any>(sa, 'notification:new');
    const created = await post(a, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    await post(admin, `/api/admin/appointments/${created.body.appointment.id}/approve`);
    const n = (await got).notification;
    expect(n.entityType).toBe('appointment');
    expect(n.entityId).toBe(created.body.appointment.id);
    expect(leaked).toEqual([]);
    sa.close(); sb.close();
  });
});

describe('notifications', () => {
  it('lists, marks read, links to records and deletes without touching business data', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const apptId = created.body.appointment.id;
    await post(admin, `/api/admin/appointments/${apptId}/approve`);

    const list = await c.agent.get('/api/notifications');
    expect(list.body.items.length).toBe(2);
    expect(list.body.unreadCount).toBe(2);
    expect(list.body.items.every((n: any) => n.entityType === 'appointment' && n.entityId === apptId)).toBe(true);
    const one = list.body.items[0].id;
    expect((await post(c, `/api/notifications/${one}/read`)).body.unreadCount).toBe(1);
    expect((await post(c, '/api/notifications/read-all')).body.unreadCount).toBe(0);
    expect((await c.agent.get('/api/notifications?unread=1')).body.items).toHaveLength(0);

    // another user cannot read, mark or delete my notifications
    const other = await registerCustomer(2);
    expect((await other.agent.get('/api/notifications')).body.items).toHaveLength(0);
    expect((await post(other, '/api/notifications/delete', { ids: [one] })).body.deleted).toBe(0);
    expect((await queryOne('SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1', [c.user.id])).n).toBe(2);

    const apptsBefore = (await queryOne('SELECT count(*)::int AS n FROM appointments')).n;
    const del1 = await post(c, '/api/notifications/delete', { ids: [one] });
    expect(del1.body.deleted).toBe(1);
    expect((await post(c, '/api/notifications/delete', { olderThanDays: 0 })).body.deleted).toBe(1);
    expect((await queryOne('SELECT count(*)::int AS n FROM appointments')).n).toBe(apptsBefore);
    expect((await queryOne('SELECT status FROM appointments WHERE id = $1', [apptId])).status).toBe('approved');
    // admin sees theirs (new booking) separately
    expect((await admin.agent.get('/api/admin/notifications')).body.items[0]).toMatchObject({ type: 'booking_submitted', entityId: apptId });
    expect((await c.agent.get('/api/admin/notifications')).status).toBe(401);
  });

  it('retried actions never create duplicate notifications', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const created = await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const id = created.body.appointment.id;
    await post(admin, `/api/admin/appointments/${id}/approve`);
    await post(admin, `/api/admin/appointments/${id}/approve`); // retry (409) must not add anything
    expect((await queryOne(`SELECT count(*)::int AS n FROM notifications WHERE type = 'booking_approved'`)).n).toBe(1);
  });

  it('respects admin notification preferences and the cleanup keeps business records', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    await put(admin, '/api/admin/settings', { notifyAdminNewBooking: false });
    await guestBook(svc.id, slotAt(3, '10:00'));
    expect((await admin.agent.get('/api/admin/notifications')).body.items).toHaveLength(0);

    const c = await registerCustomer(1);
    await post(c, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '12:00'), name: 'n', email: 'n@example.com' });
    await pool.query(`UPDATE notifications SET read_at = now(), created_at = now() - interval '200 days'`);
    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,'h',now() - interval '3 days')`, [c.user.id]);
    const r = await runCleanup();
    expect(r.oldNotifications).toBeGreaterThan(0);
    expect(r.expiredResetTokens).toBe(1);
    expect((await queryOne('SELECT count(*)::int AS n FROM appointments')).n).toBe(2);
    expect((await queryOne('SELECT count(*)::int AS n FROM users')).n).toBeGreaterThan(0);
  });
});

describe('reviews', () => {
  it('only the owner of a completed appointment can review, once; pending reviews are not public', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const a = await registerCustomer(1, { fullName: 'Ade Bello' });
    const b = await registerCustomer(2);
    const created = await post(a, '/api/public/bookings', { serviceId: svc.id, startAt: slotAt(3, '10:00'), name: 'n', email: 'n@example.com' });
    const pendingId = created.body.appointment.id;
    expect((await post(a, `/api/me/appointments/${pendingId}/review`, { rating: 5, comment: 'Great' })).status).toBe(403); // not completed
    const id = await completedAppointment(a, svc.id);
    expect((await post(b, `/api/me/appointments/${id}/review`, { rating: 5, comment: 'Not mine' })).status).toBe(404);
    expect((await post(a, `/api/me/appointments/${id}/review`, { rating: 9, comment: 'x' })).status).toBe(400);
    const ok = await post(a, `/api/me/appointments/${id}/review`, { rating: 5, comment: 'Best fade in town' });
    expect(ok.status).toBe(201);
    expect(ok.body.review.status).toBe('pending');
    expect((await post(a, `/api/me/appointments/${id}/review`, { rating: 4, comment: 'again' })).status).toBe(409);
    const detail = await a.agent.get(`/api/me/appointments/${id}`);
    expect(detail.body.appointment).toMatchObject({ canReview: false, hasReview: true });

    // not public until approved; staff can't moderate, admin can
    expect((await request(app).get('/api/public/reviews')).body.items).toHaveLength(0);
    const staff = await loginStaff();
    expect((await post(staff, `/api/admin/reviews/${ok.body.review.id}/status`, { status: 'approved' })).status).toBe(403);
    expect((await post(a, `/api/admin/reviews/${ok.body.review.id}/status`, { status: 'approved' })).status).toBe(401);
    expect((await request(app).get('/api/public/reviews')).body.items).toHaveLength(0);
    expect((await admin.agent.get('/api/admin/reviews?status=pending')).body.total).toBe(1);
    expect((await admin.agent.get('/api/admin/dashboard/summary')).body.pendingReviews).toBe(1);
    expect((await post(admin, `/api/admin/reviews/${ok.body.review.id}/status`, { status: 'approved' })).status).toBe(200);
    const pub = await request(app).get('/api/public/reviews');
    expect(pub.body.items).toEqual([expect.objectContaining({ authorName: 'Ade Bello', rating: 5 })]);
    expect(pub.body.average).toBe(5);
    expect(JSON.stringify(pub.body)).not.toContain('customer1@example.com');
    for (const st of ['rejected', 'hidden']) {
      await post(admin, `/api/admin/reviews/${ok.body.review.id}/status`, { status: st });
      expect((await request(app).get('/api/public/reviews')).body.items).toHaveLength(0);
    }
    const notes = await admin.agent.get('/api/admin/notifications');
    expect(notes.body.items.find((n: any) => n.type === 'review_submitted')).toMatchObject({ entityType: 'review', entityId: ok.body.review.id });
  });
});

describe('admin management & settings', () => {
  it('requires authentication/authorization on every admin write', async () => {
    const svc = await makeService();
    const staff = await loginStaff();
    const cust = await registerCustomer(1);
    const calls: [string, string, object][] = [
      ['post', '/api/admin/services', { name: 'X', price: 1, durationMinutes: 30 }],
      ['patch', `/api/admin/services/${svc.id}`, { name: 'Y' }],
      ['delete', `/api/admin/services/${svc.id}`, {}],
      ['put', '/api/admin/settings', { businessName: 'Hacked' }],
      ['post', '/api/admin/gallery', { url: 'https://example.com/a.jpg' }],
      ['post', '/api/admin/faqs', { question: 'q', answer: 'a' }],
      ['post', '/api/admin/system/cleanup', {}],
    ];
    for (const [m, url, body] of calls) {
      const anon = await (request(app) as any)[m](url).set('Origin', ORIGIN).send(body);
      expect(anon.status, `${m} ${url} anon`).toBe(401);
      const asCustomer = await (cust.agent as any)[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', cust.csrf).send(body);
      expect(asCustomer.status, `${m} ${url} customer`).toBe(401);
      const asStaff = await (staff.agent as any)[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', staff.csrf).send(body);
      expect(asStaff.status, `${m} ${url} staff`).toBe(403);
    }
    expect((await queryOne('SELECT business_name FROM business_settings')).business_name).toBe('Bile Cutz');
    expect((await staff.agent.get('/api/admin/services')).status).toBe(200); // staff may read
  });

  it('services: create / edit / reorder / soft delete never damages history', async () => {
    const admin = await loginAdmin();
    const created = await post(admin, '/api/admin/services', { name: 'Hot Towel Shave', description: 'Classic', price: 2500, durationMinutes: 25, isActive: true, isFeatured: true });
    expect(created.status).toBe(201);
    const id = created.body.service.id;
    expect((await request(app).get('/api/public/services?featured=1')).body.items.map((s: any) => s.name)).toContain('Hot Towel Shave');
    const g = await guestBook(id, slotAt(3, '10:00'));
    expect(g.status).toBe(201);
    expect((await patch(admin, `/api/admin/services/${id}`, { price: 4000, durationMinutes: 40 })).body.service).toMatchObject({ price: 4000, durationMinutes: 40 });
    expect((await patch(admin, `/api/admin/services/${id}`, { isActive: false })).status).toBe(200);
    expect((await guestBook(id, slotAt(3, '12:00'))).status).toBe(404); // deactivated
    expect((await del(admin, `/api/admin/services/${id}`)).status).toBe(200);
    const row = await queryOne('SELECT * FROM appointments WHERE id = $1', [g.body.appointment.id]);
    expect(row).toMatchObject({ service_name: 'Hot Towel Shave', service_price: 2500, service_duration_minutes: 25 });
    expect((await admin.agent.get('/api/admin/services')).body.items.find((s: any) => s.id === id)).toBeUndefined();
    expect((await post(admin, '/api/admin/services', { name: '', price: -5, durationMinutes: 1 })).status).toBe(400);
  });

  it('settings changes take effect immediately in the booking engine, without touching existing bookings', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const g = await guestBook(svc.id, slotAt(3, '10:00'));
    const res = await put(admin, '/api/admin/settings', { maxSimultaneous: 1, slotIntervalMinutes: 60, currency: 'USD' });
    expect(res.status).toBe(200);
    expect(res.body.warnings.affectedAppointments).toBe(1);
    const slots = (await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${dateAhead(3)}`)).body.slots;
    expect(slots.slice(0, 3).map((s: any) => s.time)).toEqual(['09:00', '10:00', '11:00']);
    expect(slots.find((s: any) => s.time === '10:00').available).toBe(false); // capacity now 1
    expect((await queryOne('SELECT status, currency FROM appointments WHERE id = $1', [g.body.appointment.id]))).toMatchObject({ status: 'pending', currency: 'NGN' });
    expect((await request(app).get('/api/public/settings')).body.business.currency).toBe('USD');
    // validation
    for (const bad of [{ timezone: 'Mars/Phobos' }, { currency: 'naira' }, { maxSimultaneous: 0 }, { slotIntervalMinutes: 3 }, { contactEmail: 'nope' }]) {
      expect((await put(admin, '/api/admin/settings', bad)).status).toBe(400);
    }
  });

  it('hours, breaks and closures are editable and drive availability', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const days = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, isOpen: d !== 0, openTime: '10:00', closeTime: '16:00', breaks: [{ startTime: '12:00', endTime: '13:00', label: 'Lunch' }] }));
    expect((await put(admin, '/api/admin/settings/hours', { days })).status).toBe(200);
    const bad = days.map((d) => ({ ...d, closeTime: '09:00' }));
    expect((await put(admin, '/api/admin/settings/hours', { days: bad })).status).toBe(400);
    const date = [3, 4, 5, 6, 7, 8, 9].map(dateAhead).find((x) => new Date(`${x}T12:00:00Z`).getUTCDay() !== 0)!;
    const times = (await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${date}`)).body.slots.filter((s: any) => s.available).map((s: any) => s.time);
    expect(times[0]).toBe('10:00');
    expect(times).not.toContain('12:00');
    expect(times).not.toContain('09:30');
    expect(times.at(-1)).toBe('15:30');
    const sunday = [3, 4, 5, 6, 7, 8, 9].map(dateAhead).find((x) => new Date(`${x}T12:00:00Z`).getUTCDay() === 0)!;
    expect((await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${sunday}`)).body.slots).toEqual([]);

    const closure = await post(admin, '/api/admin/settings/closures', { startDate: date, endDate: date, kind: 'holiday', reason: 'Public holiday' });
    expect(closure.status).toBe(201);
    expect((await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${date}`)).body.slots).toEqual([]);
    expect((await request(app).get('/api/public/settings')).body.closures).toHaveLength(1);
    expect((await post(admin, '/api/admin/settings/closures', { startDate: date, endDate: '2000-01-01' })).status).toBe(400);
    expect((await del(admin, `/api/admin/settings/closures/${closure.body.closure.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/public/availability?serviceId=${svc.id}&date=${date}`)).body.slots.length).toBeGreaterThan(0);
  });

  it('customer admin views never expose password hashes and honour suspension', async () => {
    const admin = await loginAdmin();
    const c = await registerCustomer(1);
    const detail = await admin.agent.get(`/api/admin/customers/${c.user.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/argon2|password|token_hash/i);
    expect(detail.body.customer.fullName).toBe('Customer 1');
    expect((await admin.agent.get('/api/admin/customers?q=customer1')).body.total).toBe(1);
    expect((await admin.agent.get(`/api/admin/customers/${admin.user.id}`)).status).toBe(404); // admins are not listed as customers
    expect((await patch(admin, `/api/admin/customers/${c.user.id}/status`, { status: 'suspended' })).status).toBe(200);
    expect((await c.agent.get('/api/auth/me')).status).toBe(401);
    expect((await admin.agent.get('/api/admin/audit')).body.items[0].action).toBe('customer.suspended');
  });

  it('dashboard summary reports real database counts', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    await registerCustomer(1);
    const a = await guestBook(svc.id, slotAt(1, '18:00'), { email: 'a@example.com' });
    await guestBook(svc.id, slotAt(3, '10:00'), { email: 'b@example.com' });
    await post(admin, `/api/admin/appointments/${a.body.appointment?.id}/approve`).catch(() => {});
    const s = (await admin.agent.get('/api/admin/dashboard/summary')).body;
    expect(s.totalCustomers).toBe(1);
    expect(s.pendingApprovals + s.approved).toBe(2);
    expect(s.upcoming.length).toBe(2);
  });

  it('image uploads validate real file content, not the extension', async () => {
    const admin = await loginAdmin();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const ok = await admin.agent.post('/api/admin/uploads').set('Origin', ORIGIN).set('X-CSRF-Token', admin.csrf).field('kind', 'gallery').attach('file', png, 'a.png');
    expect(ok.status).toBe(201);
    expect(ok.body.url).toMatch(/\/uploads\/gallery\/[a-f0-9]{32}\.png$/);
    const fake = await admin.agent.post('/api/admin/uploads').set('Origin', ORIGIN).set('X-CSRF-Token', admin.csrf).field('kind', 'gallery').attach('file', Buffer.from('<script>alert(1)</script>'), 'evil.png');
    expect(fake.status).toBe(400);
  });

  it('WhatsApp links are encoded and only built when a phone number exists', async () => {
    const svc = await makeService();
    const admin = await loginAdmin();
    const withPhone = await post(admin, '/api/admin/appointments', { serviceId: svc.id, startAt: slotAt(1, '10:00'), name: 'Tolu & Sons', phone: '0803 123 4567', source: 'phone' });
    const wa = withPhone.body.appointment.whatsapp;
    expect(wa.confirmationLink).toMatch(/^https:\/\/wa\.me\/2348031234567\?text=/);
    expect(decodeURIComponent(wa.confirmationLink.split('text=')[1])).toContain('Tolu & Sons');
    expect(wa.confirmationLink).not.toContain(' ');
    const noPhone = await post(admin, '/api/admin/appointments', { serviceId: svc.id, startAt: slotAt(1, '12:00'), name: 'No Phone', source: 'walk_in' });
    expect(noPhone.body.appointment.whatsapp.chatLink).toBeNull();
  });
});
