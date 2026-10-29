import { query, pool, type Queryable } from '../db/pool.js';
import { slotUnavailable, notFound, badRequest } from '../lib/errors.js';
import {
  addDaysLocal,
  datesInMonth,
  dayOfWeekOf,
  isValidLocalDate,
  localDateOf,
  localTimeOf,
  todayLocal,
  zonedToUtc,
} from '../lib/time.js';
import { getSchedule, isClosed, type Schedule } from './settings.js';

/**
 * AVAILABILITY & CAPACITY MODEL
 * -----------------------------
 * The shop has `max_simultaneous` chairs (capacity). A booking occupies the half-open interval
 *   [start_at, blocked_until)   where blocked_until = start + service duration + buffer.
 * A new booking fits iff, at every instant inside its own interval, the number of already-active
 * (pending or approved) appointments covering that instant is < capacity. We compute the PEAK
 * concurrency of overlapping appointments with a sweep line — merely counting overlapping rows
 * would wrongly reject e.g. A 09:00-10:00 + B 10:00-11:00 versus a new 09:00-11:00 at capacity 2.
 * Adjacent intervals (one ends exactly when the next starts) never overlap.
 *
 * Concurrency control: create/confirm paths take a transaction-scoped PostgreSQL advisory lock
 * (CAPACITY_LOCK_KEY) before re-checking availability and inserting, so simultaneous requests are
 * serialized and can never exceed capacity. Pending bookings consume capacity; rejected,
 * cancelled and completed ones do not. Opening a booking form reserves nothing.
 */
export const CAPACITY_LOCK_KEY = 90210;

export type BookingMode = 'public' | 'staff';

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms, exclusive
}

export type UnavailableReason = 'closed' | 'past' | 'notice' | 'same_day' | 'too_far' | 'break' | 'capacity';

export interface Slot {
  start: Date;
  available: boolean;
  reason?: UnavailableReason;
}

/** Peak number of simultaneously active intervals within [from, to). Pure function. */
export function maxConcurrency(intervals: Interval[], from: number, to: number): number {
  const events: [number, number][] = [];
  for (const iv of intervals) {
    const s = Math.max(iv.start, from);
    const e = Math.min(iv.end, to);
    if (e <= s) continue;
    events.push([s, 1], [e, -1]);
  }
  // At identical timestamps process ends (-1) before starts (+1): intervals are half-open.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

interface DayWindow {
  open: Date;
  close: Date;
  breaks: { start: Date; end: Date }[];
}

export function dayWindow(date: string, schedule: Schedule): DayWindow | null {
  if (isClosed(date, schedule.closures)) return null;
  const day = schedule.days[dayOfWeekOf(date)];
  if (!day || !day.isOpen) return null;
  const tz = schedule.settings.timezone;
  return {
    open: zonedToUtc(date, day.openTime, tz),
    close: zonedToUtc(date, day.closeTime, tz),
    breaks: day.breaks.map((b) => ({ start: zonedToUtc(date, b.startTime, tz), end: zonedToUtc(date, b.endTime, tz) })),
  };
}

/** Pure slot computation for one local date. */
export function computeSlots(args: {
  date: string;
  durationMinutes: number;
  schedule: Schedule;
  mode: BookingMode;
  now: Date;
  existing: Interval[];
}): Slot[] {
  const { date, durationMinutes, schedule, mode, now, existing } = args;
  const s = schedule.settings;
  const win = dayWindow(date, schedule);
  if (!win) return [];
  const stepMs = s.slotIntervalMinutes * 60_000;
  const durMs = durationMinutes * 60_000;
  const holdMs = durMs + s.bufferMinutes * 60_000;
  const today = todayLocal(s.timezone, now);
  const slots: Slot[] = [];

  for (let t = win.open.getTime(); t + durMs <= win.close.getTime(); t += stepMs) {
    const start = new Date(t);
    const end = t + durMs;
    let reason: UnavailableReason | undefined;

    if (mode === 'public') {
      if (t <= now.getTime()) reason = 'past';
      else if (!s.allowSameDay && date === today) reason = 'same_day';
      else if (t < now.getTime() + s.minNoticeMinutes * 60_000) reason = 'notice';
      else if (date > addDaysLocal(today, s.maxAdvanceDays)) reason = 'too_far';
    } else if (t < now.getTime() - stepMs) {
      reason = 'past'; // staff may record walk-ins that started up to one slot ago
    }
    if (!reason && win.breaks.some((b) => t < b.end.getTime() && end > b.start.getTime())) reason = 'break';
    if (!reason && maxConcurrency(existing, t, t + holdMs) >= s.maxSimultaneous) reason = 'capacity';

    slots.push(reason ? { start, available: false, reason } : { start, available: true });
  }
  return slots;
}

export async function loadActiveIntervals(db: Queryable, from: Date, to: Date): Promise<Interval[]> {
  const rows = await query<{ start_at: Date; blocked_until: Date }>(
    `SELECT start_at, blocked_until FROM appointments
      WHERE status IN ('pending','approved') AND start_at < $2 AND blocked_until > $1`,
    [from, to],
    db,
  );
  return rows.map((r) => ({ start: r.start_at.getTime(), end: r.blocked_until.getTime() }));
}

export async function getServiceForBooking(db: Queryable, serviceId: string) {
  const rows = await query(
    `SELECT id, name, price, duration_minutes FROM services WHERE id = $1 AND is_active AND deleted_at IS NULL`,
    [serviceId],
    db,
  );
  if (!rows[0]) throw notFound('That service is not available for booking.');
  return rows[0] as { id: string; name: string; price: number; duration_minutes: number };
}

export async function getSlotsForDate(args: {
  serviceId: string;
  date: string;
  mode: BookingMode;
  db?: Queryable;
  now?: Date;
}) {
  const { serviceId, date, mode, db = pool, now = new Date() } = args;
  if (!isValidLocalDate(date)) throw badRequest('Invalid date. Use YYYY-MM-DD.');
  const [service, schedule] = await Promise.all([getServiceForBooking(db, serviceId), getSchedule(db)]);
  const win = dayWindow(date, schedule);
  if (!win) return { date, timezone: schedule.settings.timezone, slots: [] as { startAt: string; time: string; available: boolean }[] };
  const existing = await loadActiveIntervals(
    db,
    new Date(win.open.getTime() - 24 * 3600_000),
    new Date(win.close.getTime() + schedule.settings.bufferMinutes * 60_000),
  );
  const slots = computeSlots({ date, durationMinutes: service.duration_minutes, schedule, mode, now, existing });
  return {
    date,
    timezone: schedule.settings.timezone,
    slots: slots.map((s) => ({
      startAt: s.start.toISOString(),
      time: localTimeOf(s.start, schedule.settings.timezone),
      available: s.available,
    })),
  };
}

export async function getAvailableDates(args: {
  serviceId: string;
  month: string;
  mode: BookingMode;
  db?: Queryable;
  now?: Date;
}) {
  const { serviceId, month, mode, db = pool, now = new Date() } = args;
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Invalid month. Use YYYY-MM.');
  const [service, schedule] = await Promise.all([getServiceForBooking(db, serviceId), getSchedule(db)]);
  const dates = datesInMonth(month);
  if (!dates.length) throw badRequest('Invalid month.');
  const from = zonedToUtc(dates[0]!, '00:00', schedule.settings.timezone);
  const to = zonedToUtc(addDaysLocal(dates[dates.length - 1]!, 1), '00:00', schedule.settings.timezone);
  const existing = await loadActiveIntervals(db, new Date(from.getTime() - 24 * 3600_000), new Date(to.getTime() + 24 * 3600_000));
  return {
    month,
    timezone: schedule.settings.timezone,
    dates: dates.map((date) => ({
      date,
      available: computeSlots({ date, durationMinutes: service.duration_minutes, schedule, mode, now, existing }).some((s) => s.available),
    })),
  };
}

/**
 * Re-validates, on the server and under the capacity lock, that `start` is a bookable slot.
 * MUST be called inside a transaction that already holds the advisory lock.
 */
export async function assertSlotBookable(args: {
  client: Queryable;
  start: Date;
  durationMinutes: number;
  mode: BookingMode;
  now?: Date;
}): Promise<{ schedule: Schedule; end: Date; blockedUntil: Date }> {
  const { client, start, durationMinutes, mode, now = new Date() } = args;
  const schedule = await getSchedule(client);
  const tz = schedule.settings.timezone;
  const date = localDateOf(start, tz);
  const win = dayWindow(date, schedule);
  if (!win) throw slotUnavailable('The shop is closed on that date.');
  const existing = await loadActiveIntervals(
    client,
    new Date(win.open.getTime() - 24 * 3600_000),
    new Date(win.close.getTime() + schedule.settings.bufferMinutes * 60_000),
  );
  const slot = computeSlots({ date, durationMinutes, schedule, mode, now, existing }).find(
    (s) => s.start.getTime() === start.getTime(),
  );
  if (!slot) throw slotUnavailable('That is not a valid appointment time.');
  if (!slot.available) {
    const msg: Record<UnavailableReason, string> = {
      closed: 'The shop is closed then.',
      past: 'That time has already passed.',
      notice: 'That time is too soon. Please choose a later slot.',
      same_day: 'Same-day bookings are not available.',
      too_far: 'That date is too far in advance.',
      break: 'That time falls during a break.',
      capacity: 'That time is fully booked. Please choose another slot.',
    };
    throw slotUnavailable(msg[slot.reason!]);
  }
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { schedule, end, blockedUntil: new Date(end.getTime() + schedule.settings.bufferMinutes * 60_000) };
}
