import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { requireAdmin, requireCustomer, requireStaff } from '../middleware/auth.js';
import { noStore, pageParams, parse } from '../middleware/common.js';
import { audit } from '../services/audit.js';
import { createNotification, notifyStaff, pushNotifications } from '../services/notifications.js';

const uuid = z.string().uuid('Invalid id');
export const mapReview = (r: any) => ({
  id: r.id as string, appointmentId: r.appointment_id as string, authorName: r.author_name as string,
  rating: r.rating as number, comment: r.comment as string, status: r.status as string,
  createdAt: new Date(r.created_at).toISOString(), moderatedAt: r.moderated_at ? new Date(r.moderated_at).toISOString() : null,
});

/** Customer: submit a review for their OWN completed appointment (once). */
export const customerReviewsRouter = Router();
customerReviewsRouter.use(noStore, requireCustomer);
customerReviewsRouter.post('/appointments/:id/review', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().min(1, 'Please write a short comment').max(1500) }), req.body);
  const user = req.auth!.user;
  const a = await queryOne('SELECT * FROM appointments WHERE id = $1 AND user_id = $2', [id, user.id]);
  if (!a) throw notFound('Appointment not found.');
  if (a.status !== 'completed') throw forbidden('You can review an appointment once it has been completed.');
  let row;
  try {
    row = await queryOne(`INSERT INTO reviews (appointment_id, user_id, author_name, rating, comment) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, user.id, user.full_name, b.rating, b.comment]);
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('You have already reviewed this appointment.');
    throw e;
  }
  pushNotifications(await notifyStaff('review', { type: 'review_submitted', title: 'New review awaiting approval', body: `${user.full_name} left ${b.rating}★`, entityType: 'review', entityId: row.id, dedupeKey: `review:${row.id}` }));
  res.status(201).json({ review: mapReview(row) });
});
customerReviewsRouter.get('/reviews', async (req, res) => {
  const rows = await query('SELECT * FROM reviews WHERE user_id = $1 ORDER BY created_at DESC', [req.auth!.user.id]);
  res.json({ items: rows.map(mapReview) });
});

/** Admin moderation. */
export const adminReviewsRouter = Router();
adminReviewsRouter.use(noStore);
adminReviewsRouter.get('/reviews', requireStaff, async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const st = typeof req.query.status === 'string' && ['pending', 'approved', 'rejected', 'hidden'].includes(req.query.status) ? req.query.status : null;
  const total = (await queryOne<{ n: number }>('SELECT count(*) AS n FROM reviews WHERE ($1::text IS NULL OR status = $1)', [st]))!.n;
  const rows = await query('SELECT * FROM reviews WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3', [st, pageSize, offset]);
  res.json({ items: rows.map(mapReview), total, page, pageSize });
});
adminReviewsRouter.get('/reviews/:id', requireStaff, async (req, res) => {
  const r = await queryOne('SELECT * FROM reviews WHERE id = $1', [parse(uuid, req.params.id)]);
  if (!r) throw notFound('Review not found.');
  res.json({ review: mapReview(r) });
});
adminReviewsRouter.post('/reviews/:id/status', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'hidden']) }), req.body);
  const r = await queryOne(`UPDATE reviews SET status = $2, moderated_by = $3, moderated_at = now() WHERE id = $1 RETURNING *`, [id, status, req.auth!.user.id]);
  if (!r) throw notFound('Review not found.');
  await audit({ id: req.auth!.user.id, role: 'admin' }, `review.${status}`, 'review', id);
  if (status === 'approved') {
    const n = await createNotification({ recipientUserId: r.user_id, type: 'review_approved', title: 'Your review is now published', body: 'Thank you for your feedback!', entityType: 'review', entityId: id, dedupeKey: `review:${id}:approved` });
    if (n) pushNotifications([{ userId: r.user_id, notification: n }]);
  }
  res.json({ review: mapReview(r) });
});
