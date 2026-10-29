import { env } from '../config/env.js';
import { pool, query, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { localDateOf, localTimeOf, zonedToUtc, addDaysLocal, isValidLocalDate } from '../lib/time.js';
import { normalizePhone, waLink, waMessages } from '../lib/whatsapp.js';
import { CAPACITY_LOCK_KEY, assertSlotBookable, getServiceForBooking, type BookingMode } from './availability.js';
import { sendEmailSafe } from './email.js';
import { createNotification, notifyStaff, pushNotifications, type NotificationDto } from './notifications.js';
import { getSettings, type BusinessSettings } from './settings.js';

export type Status = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed';
export type Source = 'website' | 'walk_in' | 'phone' | 'in_person' | 'other';
export type ActorRole = 'customer' | 'guest' | 'admin' | 'staff';

export interface Actor {
  id: string | null;
  role: ActorRole;
}

const TRANSITIONS: Record<Status, Status[]> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['completed', 'cancelled'],
  rejected: [],
  cancelled: [],
  completed: [],
};

export const ACTIVE_STATUSES: Status[] = ['pending', 'approved'];

// ------------------------------------------------------------------------------------------------
// Mapping
// ------------------------------------------------------------------------------------------------

export function canCancelNow(row: { status: Status; start_at: Date }, s: BusinessSettings, now = new Date()): boolean {
  if (!ACTIVE_STATUSES.includes(row.status)) return false;
  const deadline = row.start_at.getTime() - s.cancellationDeadlineHours * 3600_000;
  return now.getTime() <= deadline && row.start_at.getTime() > now.getTime();
}

export function fmtLocal(d: Date, tz: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d)} at ${localTimeOf(d, tz)}`;
}

export interface MapOptions {
  history?: any[];
  customerView?: boolean; // adds canCancel / canReview
  staffView?: boolean; // adds whatsapp links
}

export function mapAppointment(r: any, s: BusinessSettings, opts: MapOptions = {}) {
  const tz = s.timezone;
  const base: any = {
    id: r.id,
    reference: r.reference,
    status: r.status as Status,
    source: r.source as Source,
    customer: { userId: r.user_id ?? null, name: r.customer_name, email: r.customer_email ?? null, phone: r.customer_phone ?? null },
    service: { id: r.service_id ?? null, name: r.service_name, price: r.service_price, durationMinutes: r.service_duration_minutes },
    currency: r.currency,
    startAt: new Date(r.start_at).toISOString(),
    endAt: new Date(r.end_at).toISOString(),
    localDate: localDateOf(r.start_at, tz),
    localTime: localTimeOf(r.start_at, tz),
    localEndTime: localTimeOf(r.end_at, tz),
    notes: r.notes ?? null,
    statusReason: r.status_reason ?? null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    cancelledByRole: r.cancelled_by_role ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
  if (opts.history) {
    base.history = opts.history.map((h) => ({
      fromStatus: h.from_status ?? null,
      toStatus: h.to_status,
      changedByRole: h.changed_by_role,
      changedByName: h.changed_by_name ?? null,
      reason: h.reason ?? null,
      createdAt: new Date(h.created_at).toISOString(),
    }));
  }
  if (opts.customerView) {
    base.canCancel = canCancelNow({ status: r.status, start_at: new Date(r.start_at) }, s);
    base.canReview = r.status === 'completed' && !!r.user_id && !r.review_id;
    base.hasReview = !!r.review_id;
  }
  if (opts.staffView) {
    const digits = normalizePhone(r.customer_phone, s.defaultCountryCode);
    const info = {
      reference: r.reference,
      customerName: r.customer_name,
      serviceName: r.service_name,
      localDate: base.localDate,
      localTime: base.localTime,
      businessName: s.businessName,
    };
    base.whatsapp = {
      chatLink: waLink(digits, waMessages.chat({ customerName: r.customer_name, businessName: s.businessName })),
      confirmationLink: waLink(digits, waMessages.confirmation(info)),
      cancellationLink: waLink(digits, waMessages.cancellation(info)),
      reminderLink: waLink(digits, waMessages.reminder(info)),
    };
  }
  return base;
}

const SELECT_APPT = `SELECT a.*, rv.id AS review_id FROM appointments a LEFT JOIN reviews rv ON rv.appointment_id = a.id`;

async function loadHistory(id: string, db: Queryable = pool) {
  return query(
    `SELECT h.*, u.full_name AS changed_by_name FROM appointment_status_history h
       LEFT JOIN users u ON u.id = h.changed_by WHERE h.appointment_id = $1 ORDER BY h.created_at, h.id`,
    [id],
    db,
  );
}

// ------------------------------------------------------------------------------------------------
// Creation
// ------------------------------------------------------------------------------------------------

export interface CreateInput {
  serviceId: string;
  startAt: Date;
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  source: Source;
  userId?: string | null;
  mode: BookingMode;
  /** public bookings start `pending`; staff-entered bookings are recorded as `approved`. */
  actor: Actor;
  now?: Date;
}

export async function createAppointment(input: CreateInput) {
  const { mode, actor } = input;
  const status: Status = mode === 'staff' ? 'approved' : 'pending';
  const guestToken = !input.userId && mode === 'public' ? randomToken(32) : null;
  const pushes: { userId: string; notification: NotificationDto }[] = [];

  const result = await withTransaction(async (c) => {
    // Serialize every capacity-affecting write. Held until COMMIT/ROLLBACK.
    await c.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK_KEY]);

    const service = await getServiceForBooking(c, input.serviceId);
    const { schedule, end, blockedUntil } = await assertSlotBookable({
      client: c,
      start: input.startAt,
      durationMinutes: service.duration_minutes,
      mode,
      now: input.now,
    });
    const s = schedule.settings;

    if (input.email) {
      const dup = await queryOne(
        `SELECT 1 FROM appointments WHERE lower(customer_email) = lower($1) AND start_at = $2 AND service_id = $3
            AND status IN ('pending','approved')`,
        [input.email, input.startAt, service.id],
        c,
      );
      if (dup) throw conflict('You already have a booking for this service at this time.');
    }

    const ref = await queryOne<{ n: number }>(`SELECT nextval('appointment_ref_seq') AS n`, [], c);
    const row = await queryOne(
      `INSERT INTO appointments
         (reference, user_id, guest_token_hash, customer_name, customer_email, customer_phone, notes,
          service_id, service_name, service_price, service_duration_minutes, currency,
          start_at, end_at, blocked_until, status, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        `BC-${ref!.n}`,
        input.userId ?? null,
        guestToken ? sha256(guestToken) : null,
        input.name.trim(),
        input.email ? input.email.trim().toLowerCase() : null,
        input.phone?.trim() || null,
        input.notes?.trim() || null,
        service.id,
        service.name,
        service.price,
        service.duration_minutes,
        s.currency,
        input.startAt,
        end,
        blockedUntil,
        status,
        input.source,
        actor.id,
      ],
      c,
    );
    await query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
       VALUES ($1, NULL, $2, $3, $4, $5)`,
      [row.id, status, actor.id, actor.role, mode === 'staff' ? `Recorded by staff (${input.source})` : null],
      c,
    );

    const when = fmtLocal(input.startAt, s.timezone);
    if (row.user_id) {
      const n = await createNotification(
        mode === 'staff'
          ? { recipientUserId: row.user_id, type: 'booking_approved', title: 'Appointment booked for you', body: `${service.name} on ${when} (${row.reference}).`, entityType: 'appointment', entityId: row.id, dedupeKey: `appt:${row.id}:approved` }
          : { recipientUserId: row.user_id, type: 'booking_submitted', title: 'Booking request received', body: `${service.name} on ${when}. We will confirm shortly (${row.reference}).`, entityType: 'appointment', entityId: row.id, dedupeKey: `appt:${row.id}:submitted` },
        c,
      );
      if (n) pushes.push({ userId: row.user_id, notification: n });
    }
    if (mode === 'public') {
      pushes.push(
        ...(await notifyStaff(
          'newBooking',
          { type: 'booking_submitted', title: 'New booking request', body: `${row.customer_name} — ${service.name} on ${when} (${row.reference}).`, entityType: 'appointment', entityId: row.id, dedupeKey: `appt:${row.id}:submitted` },
          c,
        )),
      );
    }
    return { row, settings: s };
  });

  pushNotifications(pushes);

  // Email the guest their private management link (best-effort, never fails the booking).
  if (guestToken && result.row.customer_email) {
    const link = `${env.FRONTEND_URL.replace(/\/$/, '')}/booking/manage/${guestToken}`;
    sendEmailSafe({
      to: result.row.customer_email,
      subject: `${result.settings.businessName}: booking request ${result.row.reference}`,
      text: `Hello ${result.row.customer_name},\n\nWe received your request for ${result.row.service_name} on ${fmtLocal(input.startAt, result.settings.timezone)}. The shop will confirm it soon.\n\nView or cancel your booking with this private link (do not share it):\n${link}\n\nPayment is made at the shop.`,
    });
  }

  return {
    appointment: mapAppointment(result.row, result.settings, { customerView: true }),
    guestToken,
  };
}

// ------------------------------------------------------------------------------------------------
// Status changes
// ------------------------------------------------------------------------------------------------

export interface ChangeStatusInput {
  id: string;
  to: Status;
  actor: Actor;
  reason?: string | null;
  /** When set, the appointment must belong to this user (customer actions). */
  ownerUserId?: string;
  /** When set, the appointment must match this guest token hash (guest actions). */
  guestTokenHash?: string;
  now?: Date;
}

export async function changeStatus(input: ChangeStatusInput) {
  const { id, to, actor } = input;
  const now = input.now ?? new Date();
  const pushes: { userId: string; notification: NotificationDto }[] = [];

  const out = await withTransaction(async (c) => {
    const row = await queryOne(`SELECT * FROM appointments WHERE id = $1 FOR UPDATE`, [id], c);
    // Ownership failures look exactly like "not found" so ids cannot be probed.
    if (!row) throw notFound('Appointment not found.');
    if (input.ownerUserId && row.user_id !== input.ownerUserId) throw notFound('Appointment not found.');
    if (input.guestTokenHash && row.guest_token_hash !== input.guestTokenHash) throw notFound('Appointment not found.');

    const s = await getSettings(c);
    const isStaff = actor.role === 'admin' || actor.role === 'staff';

    if (!isStaff && to !== 'cancelled') throw forbidden('You can only cancel your own appointment.');
    if (!TRANSITIONS[row.status as Status].includes(to)) {
      throw new AppError('CONFLICT', `This appointment is ${row.status} and cannot be changed to ${to}.`);
    }
    if (!isStaff && !canCancelNow({ status: row.status, start_at: row.start_at }, s, now)) {
      throw forbidden(`Appointments can only be cancelled at least ${s.cancellationDeadlineHours} hour(s) before the start time. Please contact the shop.`);
    }
    if (to === 'completed' && row.start_at.getTime() > now.getTime()) {
      throw new AppError('CONFLICT', 'An appointment can only be completed once its start time has passed.');
    }

    const cancelling = to === 'cancelled';
    const updated = await queryOne(
      `UPDATE appointments SET status = $2, status_reason = COALESCE($3, status_reason), updated_at = now(),
              cancelled_at = CASE WHEN $4 THEN now() ELSE cancelled_at END,
              cancelled_by = CASE WHEN $4 THEN $5::uuid ELSE cancelled_by END,
              cancelled_by_role = CASE WHEN $4 THEN $6 ELSE cancelled_by_role END
        WHERE id = $1 RETURNING *`,
      [id, to, input.reason?.trim() || null, cancelling, actor.id, actor.role],
      c,
    );
    await query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, row.status, to, actor.id, actor.role, input.reason?.trim() || null],
      c,
    );

    const when = fmtLocal(row.start_at, s.timezone);
    const reasonText = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : '';
    if (row.user_id) {
      const copy: Record<string, { type: string; title: string; body: string } | undefined> = {
        approved: { type: 'booking_approved', title: 'Appointment approved', body: `${row.service_name} on ${when} is confirmed (${row.reference}).` },
        rejected: { type: 'booking_rejected', title: 'Appointment not accepted', body: `Your request for ${row.service_name} on ${when} could not be accepted.${reasonText}` },
        cancelled: { type: 'booking_cancelled', title: 'Appointment cancelled', body: `${row.service_name} on ${when} (${row.reference}) was cancelled.${reasonText}` },
        completed: { type: 'booking_completed', title: 'Thanks for visiting', body: `Your ${row.service_name} appointment is complete. You can now leave a review.` },
      };
      const c1 = copy[to];
      if (c1) {
        const n = await createNotification(
          { recipientUserId: row.user_id, ...c1, entityType: 'appointment', entityId: id, dedupeKey: `appt:${id}:${to}` },
          c,
        );
        if (n) pushes.push({ userId: row.user_id, notification: n });
      }
    }
    if (cancelling && !isStaff) {
      pushes.push(
        ...(await notifyStaff(
          'cancellation',
          { type: 'booking_cancelled', title: 'Customer cancelled a booking', body: `${row.customer_name} cancelled ${row.service_name} on ${when} (${row.reference}).`, entityType: 'appointment', entityId: id, dedupeKey: `appt:${id}:cancelled` },
          c,
        )),
      );
    }
    return { row: updated, settings: s };
  });

  pushNotifications(pushes);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------------------------------------

export async function getForUser(id: string, userId: string) {
  const row = await queryOne(`${SELECT_APPT} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  if (!row) throw notFound('Appointment not found.');
  const s = await getSettings();
  return mapAppointment(row, s, { customerView: true, history: await loadHistory(id) });
}

export async function getByGuestToken(token: string) {
  const row = await queryOne(`${SELECT_APPT} WHERE a.guest_token_hash = $1`, [sha256(token)]);
  if (!row) throw notFound('Booking not found.');
  const s = await getSettings();
  return { appointment: mapAppointment(row, s, { customerView: true, history: await loadHistory(row.id) }), settings: s };
}

export async function listForUser(userId: string, tab: 'upcoming' | 'past' | 'all', page: number, pageSize: number) {
  const s = await getSettings();
  const cond =
    tab === 'upcoming'
      ? `AND a.status IN ('pending','approved') AND a.end_at > now()`
      : tab === 'past'
        ? `AND NOT (a.status IN ('pending','approved') AND a.end_at > now())`
        : '';
  const order = tab === 'upcoming' ? 'a.start_at ASC' : 'a.start_at DESC';
  const total = (await queryOne<{ n: number }>(`SELECT count(*) AS n FROM appointments a WHERE a.user_id = $1 ${cond}`, [userId]))!.n;
  const rows = await query(`${SELECT_APPT} WHERE a.user_id = $1 ${cond} ORDER BY ${order} LIMIT $2 OFFSET $3`, [userId, pageSize, (page - 1) * pageSize]);
  return { items: rows.map((r) => mapAppointment(r, s, { customerView: true })), total, page, pageSize };
}

export async function claimGuestBooking(userId: string, token: string) {
  const hash = sha256(token);
  const claimed = await queryOne(
    `UPDATE appointments SET user_id = $1, claimed_at = now(), updated_at = now()
      WHERE guest_token_hash = $2 AND user_id IS NULL RETURNING id`,
    [userId, hash],
  );
  if (!claimed) {
    const existing = await queryOne('SELECT user_id FROM appointments WHERE guest_token_hash = $1', [hash]);
    if (!existing) throw notFound('Booking not found. Check that you copied the full private link.');
    if (existing.user_id === userId) return getForUser((await queryOne('SELECT id FROM appointments WHERE guest_token_hash = $1', [hash]))!.id, userId);
    throw conflict('This booking is already linked to an account.');
  }
  return getForUser(claimed.id, userId);
}

// --- admin queries -------------------------------------------------------------------------------

export interface AdminListFilters {
  q?: string;
  status?: string;
  date?: string;
  from?: string;
  to?: string;
  serviceId?: string;
  source?: string;
  customerId?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

const SORTS: Record<string, string> = {
  start_desc: 'a.start_at DESC',
  start_asc: 'a.start_at ASC',
  created_desc: 'a.created_at DESC',
};

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'completed'];
const SOURCES = ['website', 'walk_in', 'phone', 'in_person', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildFilters(f: Partial<AdminListFilters>, tz: string) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('$$', `$${params.length}`));
  };
  if (f.status && STATUSES.includes(f.status)) add('a.status = $$', f.status);
  if (f.source && SOURCES.includes(f.source)) add('a.source = $$', f.source);
  if (f.serviceId && UUID.test(f.serviceId)) add('a.service_id = $$', f.serviceId);
  if (f.customerId && UUID.test(f.customerId)) add('a.user_id = $$', f.customerId);
  if (f.date && isValidLocalDate(f.date)) {
    add('a.start_at >= $$', zonedToUtc(f.date, '00:00', tz));
    add('a.start_at < $$', zonedToUtc(addDaysLocal(f.date, 1), '00:00', tz));
  } else {
    if (f.from && isValidLocalDate(f.from)) add('a.start_at >= $$', zonedToUtc(f.from, '00:00', tz));
    if (f.to && isValidLocalDate(f.to)) add('a.start_at < $$', zonedToUtc(addDaysLocal(f.to, 1), '00:00', tz));
  }
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like);
    const p = `$${params.length}`;
    where.push(`(a.reference ILIKE ${p} OR a.customer_name ILIKE ${p} OR a.customer_email ILIKE ${p} OR a.customer_phone ILIKE ${p})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function adminList(f: AdminListFilters) {
  const s = await getSettings();
  const { sql, params } = buildFilters(f, s.timezone);
  const total = (await queryOne<{ n: number }>(`SELECT count(*) AS n FROM appointments a ${sql}`, params))!.n;
  const order = SORTS[f.sort ?? ''] ?? SORTS.start_desc;
  const rows = await query(
    `${SELECT_APPT} ${sql} ORDER BY ${order}, a.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.pageSize, (f.page - 1) * f.pageSize],
  );
  return { items: rows.map((r) => mapAppointment(r, s, { staffView: true })), total, page: f.page, pageSize: f.pageSize };
}

export async function adminCalendar(from: Date, to: Date, filters: { status?: string; serviceId?: string }) {
  const s = await getSettings();
  const { sql, params } = buildFilters({ status: filters.status, serviceId: filters.serviceId }, s.timezone);
  const rangeSql = `a.start_at < $${params.length + 1} AND a.end_at > $${params.length + 2}`;
  const rows = await query(
    `${SELECT_APPT} ${sql ? `${sql} AND` : 'WHERE'} ${rangeSql} ORDER BY a.start_at LIMIT 1000`,
    [...params, to, from],
  );
  return { items: rows.map((r) => mapAppointment(r, s, { staffView: true })) };
}

export async function adminGet(id: string) {
  if (!UUID.test(id)) throw notFound('Appointment not found.');
  const row = await queryOne(`${SELECT_APPT} WHERE a.id = $1`, [id]);
  if (!row) throw notFound('Appointment not found.');
  const s = await getSettings();
  return mapAppointment(row, s, { staffView: true, history: await loadHistory(id) });
}
