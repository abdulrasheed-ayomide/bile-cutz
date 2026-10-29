import { Router } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidTimezone, todayLocal } from '../lib/time.js';
import { normalizePhone, waLink, waMessages } from '../lib/whatsapp.js';
import { requireAdmin, requireStaff } from '../middleware/auth.js';
import { noStore, pageParams, parse } from '../middleware/common.js';
import { mapAppointment } from '../services/appointments.js';
import { audit } from '../services/audit.js';
import { databaseUsage, runCleanup } from '../services/cleanup.js';
import { revokeUserSessions, toUserDto } from '../services/auth.js';
import { getSchedule, getSettings } from '../services/settings.js';

const uuid = z.string().uuid('Invalid id');
const actor = (req: any) => ({ id: req.auth.user.id as string, role: req.auth.user.role as string });
export const adminManageRouter = Router();
adminManageRouter.use(noStore);

// ---- dashboard -----------------------------------------------------------------------------
adminManageRouter.get('/dashboard/summary', requireStaff, async (_req, res) => {
  const s = await getSettings();
  const today = todayLocal(s.timezone);
  const r = await queryOne(
    `SELECT
       (SELECT count(*) FROM appointments WHERE (start_at AT TIME ZONE $1)::date = $2::date AND status IN ('pending','approved','completed')) AS today,
       (SELECT count(*) FROM appointments WHERE status = 'pending') AS pending,
       (SELECT count(*) FROM appointments WHERE status = 'approved') AS approved,
       (SELECT count(*) FROM appointments WHERE status = 'completed') AS completed,
       (SELECT count(*) FROM appointments WHERE status = 'cancelled') AS cancelled,
       (SELECT count(*) FROM users WHERE role = 'customer') AS customers,
       (SELECT count(*) FROM reviews WHERE status = 'pending') AS reviews,
       (SELECT count(DISTINCT m.conversation_id) FROM messages m WHERE m.read_at IS NULL AND m.sender_role = 'customer') AS unread`,
    [s.timezone, today],
  );
  const up = await query(
    `SELECT a.*, NULL::uuid AS review_id FROM appointments a WHERE a.status IN ('pending','approved') AND a.end_at > now() ORDER BY a.start_at LIMIT 8`,
  );
  res.json({
    todayAppointments: r.today, pendingApprovals: r.pending, approved: r.approved, completed: r.completed, cancelled: r.cancelled,
    totalCustomers: r.customers, pendingReviews: r.reviews, unreadConversations: r.unread,
    upcoming: up.map((x) => mapAppointment(x, s, { staffView: true })),
  });
});

// ---- customers -----------------------------------------------------------------------------
adminManageRouter.get('/customers', requireStaff, async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const params: unknown[] = [];
  const where = [`u.role = 'customer'`];
  if (typeof req.query.status === 'string' && ['active', 'suspended'].includes(req.query.status)) { params.push(req.query.status); where.push(`u.status = $${params.length}`); }
  if (typeof req.query.q === 'string' && req.query.q.trim()) {
    params.push(`%${req.query.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  const w = where.join(' AND ');
  const total = (await queryOne<{ n: number }>(`SELECT count(*) AS n FROM users u WHERE ${w}`, params))!.n;
  const rows = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at,
            (SELECT count(*) FROM appointments a WHERE a.user_id = u.id) AS appointment_count,
            (SELECT max(start_at) FROM appointments a WHERE a.user_id = u.id) AS last_at
       FROM users u WHERE ${w} ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );
  res.json({
    items: rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, phone: r.phone, status: r.status, createdAt: new Date(r.created_at).toISOString(), appointmentCount: r.appointment_count, lastAppointmentAt: r.last_at ? new Date(r.last_at).toISOString() : null })),
    total, page, pageSize,
  });
});
adminManageRouter.get('/customers/:id', requireStaff, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const u = await queryOne(`SELECT * FROM users WHERE id = $1 AND role = 'customer'`, [id]);
  if (!u) throw notFound('Customer not found.');
  const s = await getSettings();
  const stats = await queryOne(`SELECT count(*) AS total, count(*) FILTER (WHERE status='pending') AS pending, count(*) FILTER (WHERE status='approved') AS approved,
      count(*) FILTER (WHERE status='completed') AS completed, count(*) FILTER (WHERE status='cancelled') AS cancelled, count(*) FILTER (WHERE status='rejected') AS rejected
      FROM appointments WHERE user_id = $1`, [id]);
  const appts = await query(`SELECT a.*, NULL::uuid AS review_id FROM appointments a WHERE a.user_id = $1 ORDER BY a.start_at DESC LIMIT 50`, [id]);
  const conv = await queryOne<{ id: string }>('SELECT id FROM conversations WHERE customer_id = $1', [id]);
  const digits = normalizePhone(u.phone, s.defaultCountryCode);
  // toUserDto never includes password_hash.
  res.json({
    customer: toUserDto(u), stats, appointments: appts.map((x) => mapAppointment(x, s, { staffView: true })),
    conversationId: conv?.id ?? null, whatsappLink: waLink(digits, waMessages.chat({ customerName: u.full_name, businessName: s.businessName })),
  });
});
adminManageRouter.patch('/customers/:id/status', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
  const u = await queryOne(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND role = 'customer' RETURNING *`, [id, status]);
  if (!u) throw notFound('Customer not found.');
  if (status === 'suspended') await revokeUserSessions(id);
  await audit(actor(req), `customer.${status}`, 'user', id);
  res.json({ customer: toUserDto(u) });
});

// ---- settings ------------------------------------------------------------------------------
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const settingsSchema = z.object({
  businessName: z.string().trim().min(1).max(120), tagline: z.string().trim().max(200), description: z.string().trim().max(2000), aboutText: z.string().trim().max(5000),
  logoUrl: z.string().url().max(500).nullable(), heroImageUrl: z.string().url().max(500).nullable(),
  contactPhone: z.string().trim().max(40), whatsappNumber: z.string().trim().max(40), contactEmail: z.string().trim().email().max(254), address: z.string().trim().max(500),
  defaultCountryCode: z.string().regex(/^[0-9]{1,4}$/), currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter code such as NGN'),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone (use e.g. Africa/Lagos)'),
  slotIntervalMinutes: z.number().int().min(5).max(240), defaultServiceMinutes: z.number().int().min(5).max(480), bufferMinutes: z.number().int().min(0).max(120),
  maxSimultaneous: z.number().int().min(1).max(100), allowSameDay: z.boolean(), minNoticeMinutes: z.number().int().min(0).max(20160), maxAdvanceDays: z.number().int().min(1).max(365),
  cancellationDeadlineHours: z.number().int().min(0).max(720), bookingPolicyText: z.string().trim().max(3000), cancellationPolicyText: z.string().trim().max(3000),
  notifyAdminNewBooking: z.boolean(), notifyAdminChat: z.boolean(), notifyAdminReview: z.boolean(), notifyAdminCancellation: z.boolean(), notificationRetentionDays: z.number().int().min(7).max(3650),
}).partial();
const COLS: Record<string, string> = {
  businessName: 'business_name', tagline: 'tagline', description: 'description', aboutText: 'about_text', logoUrl: 'logo_url', heroImageUrl: 'hero_image_url',
  contactPhone: 'contact_phone', whatsappNumber: 'whatsapp_number', contactEmail: 'contact_email', address: 'address', defaultCountryCode: 'default_country_code',
  currency: 'currency', timezone: 'timezone', slotIntervalMinutes: 'slot_interval_minutes', defaultServiceMinutes: 'default_service_minutes', bufferMinutes: 'buffer_minutes',
  maxSimultaneous: 'max_simultaneous', allowSameDay: 'allow_same_day', minNoticeMinutes: 'min_notice_minutes', maxAdvanceDays: 'max_advance_days',
  cancellationDeadlineHours: 'cancellation_deadline_hours', bookingPolicyText: 'booking_policy_text', cancellationPolicyText: 'cancellation_policy_text',
  notifyAdminNewBooking: 'notify_admin_new_booking', notifyAdminChat: 'notify_admin_chat', notifyAdminReview: 'notify_admin_review',
  notifyAdminCancellation: 'notify_admin_cancellation', notificationRetentionDays: 'notification_retention_days',
};

/** Existing future bookings are NEVER altered by schedule/capacity changes; we only report how many may be affected. */
async function affectedAppointments() {
  return (await queryOne<{ n: number }>(`SELECT count(*) AS n FROM appointments WHERE status IN ('pending','approved') AND start_at > now()`))!.n;
}

adminManageRouter.get('/settings', requireStaff, async (_req, res) => {
  const sched = await getSchedule();
  res.json({ business: sched.settings, openingHours: sched.days, closures: sched.closures });
});
adminManageRouter.put('/settings', requireAdmin, async (req, res) => {
  const b = parse(settingsSchema, req.body);
  const keys = Object.keys(b) as (keyof typeof b)[];
  if (keys.length) {
    const sets = keys.map((k, i) => `${COLS[k]} = $${i + 1}`);
    await pool.query(`UPDATE business_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, keys.map((k) => b[k]));
    await audit(actor(req), 'settings.update', 'settings', '1', { fields: keys });
  }
  const risky = ['timezone', 'maxSimultaneous', 'slotIntervalMinutes', 'bufferMinutes'].some((k) => k in b);
  res.json({ business: await getSettings(), warnings: { affectedAppointments: risky ? await affectedAppointments() : 0 } });
});
adminManageRouter.put('/settings/hours', requireAdmin, async (req, res) => {
  const { days } = parse(z.object({
    days: z.array(z.object({
      dayOfWeek: z.number().int().min(0).max(6), isOpen: z.boolean(), openTime: time, closeTime: time,
      breaks: z.array(z.object({ startTime: time, endTime: time, label: z.string().trim().max(60).nullable().optional() })).max(10),
    })).length(7),
  }), req.body);
  if (new Set(days.map((d) => d.dayOfWeek)).size !== 7) throw badRequest('Provide each day of the week exactly once.');
  for (const d of days) {
    if (d.isOpen && d.closeTime <= d.openTime) throw badRequest('Closing time must be after opening time.');
    for (const br of d.breaks) if (br.endTime <= br.startTime) throw badRequest('A break must end after it starts.');
  }
  await withTransaction(async (c) => {
    await query('DELETE FROM break_periods', [], c);
    for (const d of days) {
      await query(`INSERT INTO opening_hours (day_of_week, is_open, open_time, close_time) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (day_of_week) DO UPDATE SET is_open = $2, open_time = $3, close_time = $4`, [d.dayOfWeek, d.isOpen, d.openTime, d.closeTime], c);
      for (const br of d.breaks) await query('INSERT INTO break_periods (day_of_week, start_time, end_time, label) VALUES ($1,$2,$3,$4)', [d.dayOfWeek, br.startTime, br.endTime, br.label ?? null], c);
    }
  });
  await audit(actor(req), 'settings.hours', 'settings', '1');
  res.json({ openingHours: (await getSchedule()).days, warnings: { affectedAppointments: await affectedAppointments() } });
});
adminManageRouter.post('/settings/closures', requireAdmin, async (req, res) => {
  const b = parse(z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['holiday', 'closure']).default('closure'), reason: z.string().trim().max(200).optional() })
    .refine((d) => d.endDate >= d.startDate, { path: ['endDate'], message: 'End date must not be before the start date' }), req.body);
  const r = await queryOne('INSERT INTO closures (start_date, end_date, kind, reason) VALUES ($1,$2,$3,$4) RETURNING *', [b.startDate, b.endDate, b.kind, b.reason ?? null]);
  await audit(actor(req), 'closure.create', 'closure', r.id, { startDate: b.startDate, endDate: b.endDate });
  const overlapping = (await queryOne<{ n: number }>(
    `SELECT count(*) AS n FROM appointments a, business_settings s WHERE a.status IN ('pending','approved') AND (a.start_at AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date AND a.start_at > now()`,
    [b.startDate, b.endDate]))!.n;
  res.status(201).json({ closure: { id: r.id, startDate: r.start_date, endDate: r.end_date, kind: r.kind, reason: r.reason }, warnings: { affectedAppointments: overlapping } });
});
adminManageRouter.delete('/settings/closures/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  if (!(await queryOne('DELETE FROM closures WHERE id = $1 RETURNING id', [id]))) throw notFound('Closure not found.');
  await audit(actor(req), 'closure.delete', 'closure', id);
  res.json({ ok: true });
});

// ---- system / audit ------------------------------------------------------------------------
adminManageRouter.get('/system/usage', requireAdmin, async (_req, res) => res.json(await databaseUsage()));
adminManageRouter.post('/system/cleanup', requireAdmin, async (req, res) => {
  const r = await runCleanup();
  await audit(actor(req), 'system.cleanup', 'system', undefined, r);
  res.json(r);
});
adminManageRouter.get('/audit', requireAdmin, async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 30);
  const total = (await queryOne<{ n: number }>('SELECT count(*) AS n FROM audit_logs'))!.n;
  const rows = await query(`SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.created_at DESC, l.id DESC LIMIT $1 OFFSET $2`, [pageSize, offset]);
  res.json({ items: rows.map((r) => ({ id: r.id, actorName: r.full_name ?? null, action: r.action, entityType: r.entity_type, entityId: r.entity_id, details: r.details, createdAt: new Date(r.created_at).toISOString() })), total, page, pageSize });
});
