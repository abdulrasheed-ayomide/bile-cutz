import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireStaff } from '../middleware/auth.js';
import { noStore, pageParams, parse } from '../middleware/common.js';
import { adminCalendar, adminGet, adminList, changeStatus, createAppointment, type Status } from '../services/appointments.js';
import { getAvailableDates, getSlotsForDate } from '../services/availability.js';
import { audit } from '../services/audit.js';

const uuid = z.string().uuid('Invalid id');
const reasonBody = z.object({ reason: z.string().trim().max(300).optional() });

export const adminAppointmentsRouter = Router();
adminAppointmentsRouter.use(noStore, requireStaff);

adminAppointmentsRouter.get('/availability', async (req, res) => {
  const q = parse(z.object({ serviceId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query);
  res.json(await getSlotsForDate({ serviceId: q.serviceId, date: q.date, mode: 'staff' }));
});

adminAppointmentsRouter.get('/availability/dates', async (req, res) => {
  const q = parse(z.object({ serviceId: uuid, month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
  res.json(await getAvailableDates({ serviceId: q.serviceId, month: q.month, mode: 'staff' }));
});

adminAppointmentsRouter.get('/appointments', async (req, res) => {
  const { page, pageSize } = pageParams(req.query);
  const str = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
  res.json(
    await adminList({
      q: str('q'), status: str('status'), date: str('date'), from: str('from'), to: str('to'),
      serviceId: str('serviceId'), source: str('source'), customerId: str('customerId'), sort: str('sort'),
      page, pageSize,
    }),
  );
});

adminAppointmentsRouter.get('/appointments/calendar', async (req, res) => {
  const q = parse(
    z.object({ from: z.string().datetime(), to: z.string().datetime(), status: z.string().optional(), serviceId: z.string().uuid().optional() }),
    req.query,
  );
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to <= from || to.getTime() - from.getTime() > 45 * 24 * 3600_000) throw badRequest('Invalid calendar range (max 45 days).');
  res.json(await adminCalendar(from, to, { status: q.status, serviceId: q.serviceId }));
});

adminAppointmentsRouter.get('/appointments/:id', async (req, res) => {
  res.json({ appointment: await adminGet(parse(uuid, req.params.id)) });
});

const manualSchema = z.object({
  serviceId: uuid,
  startAt: z.string().datetime(),
  name: z.string().trim().min(1, 'Customer name is required').max(120),
  email: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal('')),
  phone: z.string().trim().max(30).regex(/^[\d+()\-\s.]*$/).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  source: z.enum(['walk_in', 'phone', 'in_person', 'other']),
  userId: uuid.optional(),
});

adminAppointmentsRouter.post('/appointments', async (req, res) => {
  const body = parse(manualSchema, req.body);
  const staff = req.auth!.user;
  if (body.userId) {
    const u = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND role = 'customer'`, [body.userId]);
    if (!u) throw notFound('Linked customer not found.');
  }
  const { appointment } = await createAppointment({
    serviceId: body.serviceId,
    startAt: new Date(body.startAt),
    name: body.name,
    email: body.email || null,
    phone: body.phone || null,
    notes: body.notes || null,
    source: body.source,
    userId: body.userId ?? null,
    mode: 'staff',
    actor: { id: staff.id, role: staff.role === 'admin' ? 'admin' : 'staff' },
  });
  await audit({ id: staff.id, role: staff.role }, 'appointment.create_manual', 'appointment', appointment.id, { source: body.source });
  res.status(201).json({ appointment: await adminGet(appointment.id) });
});

const actions: [string, Status][] = [
  ['approve', 'approved'],
  ['reject', 'rejected'],
  ['cancel', 'cancelled'],
  ['complete', 'completed'],
];
for (const [path, to] of actions) {
  adminAppointmentsRouter.post(`/appointments/:id/${path}`, async (req, res) => {
    const id = parse(uuid, req.params.id);
    const body = parse(reasonBody, req.body ?? {});
    const staff = req.auth!.user;
    await changeStatus({ id, to, actor: { id: staff.id, role: staff.role === 'admin' ? 'admin' : 'staff' }, reason: body.reason });
    await audit({ id: staff.id, role: staff.role }, `appointment.${path}`, 'appointment', id, body.reason ? { reason: body.reason } : {});
    res.json({ appointment: await adminGet(id) });
  });
}
