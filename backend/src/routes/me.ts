import { Router } from 'express';
import { z } from 'zod';
import { requireCustomer } from '../middleware/auth.js';
import { noStore, pageParams, parse } from '../middleware/common.js';
import { forbidden } from '../lib/errors.js';
import { changeStatus, claimGuestBooking, getForUser, listForUser } from '../services/appointments.js';
import { getSettings, publicBusiness } from '../services/settings.js';

const uuid = z.string().uuid('Invalid id');

/** Customer area: only ever reads/writes rows owned by the signed-in customer. */
export const meRouter = Router();
meRouter.use(noStore, requireCustomer);

meRouter.get('/appointments', async (req, res) => {
  const tab = parse(z.enum(['upcoming', 'past', 'all']).default('all'), req.query.tab ?? 'all');
  const { page, pageSize } = pageParams(req.query);
  res.json(await listForUser(req.auth!.user.id, tab, page, pageSize));
});

meRouter.get('/appointments/:id', async (req, res) => {
  const id = parse(uuid, req.params.id);
  res.json({ appointment: await getForUser(id, req.auth!.user.id) });
});

meRouter.post('/appointments/:id/cancel', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
  const user = req.auth!.user;
  await changeStatus({ id, to: 'cancelled', actor: { id: user.id, role: 'customer' }, reason: body.reason ?? 'Cancelled by customer', ownerUserId: user.id });
  res.json({ appointment: await getForUser(id, user.id) });
});

meRouter.get('/appointments/:id/confirmation', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const appointment = await getForUser(id, req.auth!.user.id);
  // The printable confirmation exists only for approved bookings.
  if (appointment.status !== 'approved') throw forbidden('A confirmation is only available once your booking has been approved.');
  const b = publicBusiness(await getSettings());
  res.json({
    appointment,
    business: { name: b.name, phone: b.phone, whatsappLink: b.whatsappLink, email: b.email, address: b.address, bookingPolicyText: b.bookingPolicyText, cancellationPolicyText: b.cancellationPolicyText },
  });
});

meRouter.post('/claim-booking', async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20).max(100) }), req.body);
  res.json({ appointment: await claimGuestBooking(req.auth!.user.id, body.token) });
});
