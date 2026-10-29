import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { optionalCustomer } from '../middleware/auth.js';
import { limits, noStore, parse, publicCache } from '../middleware/common.js';
import { changeStatus, createAppointment, getByGuestToken, mapAppointment } from '../services/appointments.js';
import { getAvailableDates, getSlotsForDate } from '../services/availability.js';
import { getSchedule, publicBusiness } from '../services/settings.js';
import { env } from '../config/env.js';

export function mapService(r: any) {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    price: r.price as number,
    durationMinutes: r.duration_minutes as number,
    imageUrl: (r.image_url ?? null) as string | null,
    isActive: r.is_active as boolean,
    isFeatured: r.is_featured as boolean,
    sortOrder: r.sort_order as number,
  };
}

const uuid = z.string().uuid('Invalid id');

export const publicRouter = Router();

publicRouter.get('/public/settings', publicCache(), async (_req, res) => {
  const sched = await getSchedule(undefined, { upcomingClosuresOnly: true });
  res.json({
    business: publicBusiness(sched.settings),
    openingHours: sched.days,
    closures: sched.closures,
  });
});

publicRouter.get('/public/services', publicCache(), async (req, res) => {
  const featured = req.query.featured === '1' || req.query.featured === 'true';
  const rows = await query(
    `SELECT * FROM services WHERE is_active AND deleted_at IS NULL ${featured ? 'AND is_featured' : ''} ORDER BY sort_order, created_at`,
  );
  res.json({ items: rows.map(mapService) });
});

publicRouter.get('/public/gallery', publicCache(), async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '60'), 10) || 60));
  const rows = await query(`SELECT * FROM gallery_images WHERE is_active ORDER BY sort_order, created_at LIMIT $1`, [limit]);
  res.json({
    items: rows.map((r) => ({ id: r.id, url: r.url, caption: r.caption, sortOrder: r.sort_order, isActive: r.is_active })),
  });
});

publicRouter.get('/public/reviews', publicCache(), async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '12'), 10) || 12));
  // Only admin-approved reviews are ever returned here.
  const rows = await query(
    `SELECT id, author_name, rating, comment, created_at FROM reviews WHERE status = 'approved' ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  const agg = await queryOne<{ avg: number | null; n: number }>(
    `SELECT avg(rating)::float AS avg, count(*) AS n FROM reviews WHERE status = 'approved'`,
  );
  res.json({
    items: rows.map((r) => ({ id: r.id, authorName: r.author_name, rating: r.rating, comment: r.comment, createdAt: new Date(r.created_at).toISOString() })),
    average: agg?.avg != null ? Math.round(agg.avg * 10) / 10 : null,
    count: agg?.n ?? 0,
  });
});

publicRouter.get('/public/faqs', publicCache(), async (_req, res) => {
  const rows = await query(`SELECT * FROM faqs WHERE is_active ORDER BY sort_order, question`);
  res.json({ items: rows.map((r) => ({ id: r.id, question: r.question, answer: r.answer, sortOrder: r.sort_order, isActive: r.is_active })) });
});

// Availability must always be fresh — never cached.
publicRouter.get('/public/availability/dates', noStore, async (req, res) => {
  const q = parse(z.object({ serviceId: uuid, month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
  res.json(await getAvailableDates({ serviceId: q.serviceId, month: q.month, mode: 'public' }));
});

publicRouter.get('/public/availability', noStore, async (req, res) => {
  const q = parse(z.object({ serviceId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query);
  res.json(await getSlotsForDate({ serviceId: q.serviceId, date: q.date, mode: 'public' }));
});

const bookingSchema = z.object({
  serviceId: uuid,
  startAt: z.string().datetime({ message: 'Choose a valid date and time' }),
  name: z.string().trim().min(1, 'Your name is required').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  phone: z.string().trim().max(30).regex(/^[\d+()\-\s.]*$/, 'Enter a valid phone number').optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
});

publicRouter.post('/public/bookings', limits.booking, noStore, optionalCustomer, async (req, res) => {
  const body = parse(bookingSchema, req.body);
  const user = req.auth?.user;
  const { appointment, guestToken } = await createAppointment({
    serviceId: body.serviceId,
    startAt: new Date(body.startAt),
    name: user?.full_name ?? body.name,
    email: user?.email ?? body.email,
    phone: body.phone || user?.phone || null,
    notes: body.notes || null,
    source: 'website',
    userId: user?.id ?? null,
    mode: 'public',
    actor: { id: user?.id ?? null, role: user ? 'customer' : 'guest' },
  });
  res.status(201).json({
    appointment,
    ...(guestToken ? { managementToken: guestToken, managementPath: `/booking/manage/${guestToken}` } : {}),
  });
});

// --- Guest self-service (private link) ---------------------------------------------------------

function guestBusiness(s: Awaited<ReturnType<typeof getByGuestToken>>['settings']) {
  const b = publicBusiness(s);
  return { name: b.name, phone: b.phone, whatsappLink: b.whatsappLink, address: b.address, cancellationPolicyText: b.cancellationPolicyText };
}

const tokenParam = z.string().min(20).max(100);

publicRouter.get('/guest/bookings/:token', limits.guestToken, noStore, async (req, res) => {
  const token = parse(tokenParam, req.params.token);
  const { appointment, settings } = await getByGuestToken(token);
  res.json({ appointment, business: guestBusiness(settings) });
});

publicRouter.post('/guest/bookings/:token/cancel', limits.guestToken, noStore, async (req, res) => {
  const token = parse(tokenParam, req.params.token);
  const body = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
  const found = await queryOne<{ id: string }>('SELECT id FROM appointments WHERE guest_token_hash = $1', [sha256(token)]);
  if (!found) throw notFound('Booking not found.');
  const out = await changeStatus({
    id: found.id,
    to: 'cancelled',
    actor: { id: null, role: 'guest' },
    reason: body.reason ?? 'Cancelled by customer',
    guestTokenHash: sha256(token),
  });
  const { appointment } = await getByGuestToken(token);
  void out;
  res.json({ appointment });
});

void badRequest;
void env;
void mapAppointment;
