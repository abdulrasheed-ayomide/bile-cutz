import { query, queryOne, type Queryable, pool } from '../db/pool.js';
import { hhmm } from '../lib/time.js';
import { normalizePhone, waLink } from '../lib/whatsapp.js';

export interface BusinessSettings {
  businessName: string;
  tagline: string;
  description: string;
  aboutText: string;
  logoUrl: string | null;
  heroImageUrl: string | null;
  contactPhone: string;
  whatsappNumber: string;
  contactEmail: string;
  address: string;
  defaultCountryCode: string;
  currency: string;
  timezone: string;
  slotIntervalMinutes: number;
  defaultServiceMinutes: number;
  bufferMinutes: number;
  maxSimultaneous: number;
  allowSameDay: boolean;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  cancellationDeadlineHours: number;
  bookingPolicyText: string;
  cancellationPolicyText: string;
  notifyAdminNewBooking: boolean;
  notifyAdminChat: boolean;
  notifyAdminReview: boolean;
  notifyAdminCancellation: boolean;
  notificationRetentionDays: number;
}

export interface DaySchedule {
  dayOfWeek: number;
  isOpen: boolean;
  openTime: string; // HH:mm
  closeTime: string; // HH:mm
  breaks: { id?: string; startTime: string; endTime: string; label: string | null }[];
}

export interface Closure {
  id: string;
  startDate: string;
  endDate: string;
  kind: 'holiday' | 'closure';
  reason: string | null;
}

export interface Schedule {
  settings: BusinessSettings;
  days: DaySchedule[]; // always 7 entries, index = dayOfWeek
  closures: Closure[];
}

export function mapSettings(r: any): BusinessSettings {
  return {
    businessName: r.business_name,
    tagline: r.tagline,
    description: r.description,
    aboutText: r.about_text,
    logoUrl: r.logo_url,
    heroImageUrl: r.hero_image_url,
    contactPhone: r.contact_phone,
    whatsappNumber: r.whatsapp_number,
    contactEmail: r.contact_email,
    address: r.address,
    defaultCountryCode: r.default_country_code,
    currency: r.currency,
    timezone: r.timezone,
    slotIntervalMinutes: r.slot_interval_minutes,
    defaultServiceMinutes: r.default_service_minutes,
    bufferMinutes: r.buffer_minutes,
    maxSimultaneous: r.max_simultaneous,
    allowSameDay: r.allow_same_day,
    minNoticeMinutes: r.min_notice_minutes,
    maxAdvanceDays: r.max_advance_days,
    cancellationDeadlineHours: r.cancellation_deadline_hours,
    bookingPolicyText: r.booking_policy_text,
    cancellationPolicyText: r.cancellation_policy_text,
    notifyAdminNewBooking: r.notify_admin_new_booking,
    notifyAdminChat: r.notify_admin_chat,
    notifyAdminReview: r.notify_admin_review,
    notifyAdminCancellation: r.notify_admin_cancellation,
    notificationRetentionDays: r.notification_retention_days,
  };
}

/** Reads the single settings row, creating it with defaults if the seed has not been run. */
export async function getSettings(db: Queryable = pool): Promise<BusinessSettings> {
  let row = await queryOne('SELECT * FROM business_settings WHERE id = 1', [], db);
  if (!row) {
    await query('INSERT INTO business_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING', [], db);
    row = await queryOne('SELECT * FROM business_settings WHERE id = 1', [], db);
  }
  return mapSettings(row);
}

export async function getSchedule(db: Queryable = pool, opts: { upcomingClosuresOnly?: boolean } = {}): Promise<Schedule> {
  const settings = await getSettings(db);
  const hours = await query('SELECT * FROM opening_hours ORDER BY day_of_week', [], db);
  const breaks = await query('SELECT * FROM break_periods ORDER BY day_of_week, start_time', [], db);
  const closureRows = await query(
    opts.upcomingClosuresOnly
      ? `SELECT * FROM closures WHERE end_date >= (now() AT TIME ZONE $1)::date ORDER BY start_date`
      : `SELECT * FROM closures ORDER BY start_date DESC`,
    opts.upcomingClosuresOnly ? [settings.timezone] : [],
    db,
  );
  const days: DaySchedule[] = [];
  for (let d = 0; d < 7; d++) {
    const h = hours.find((x) => x.day_of_week === d);
    days.push({
      dayOfWeek: d,
      isOpen: h ? h.is_open : false, // a day with no row is treated as closed
      openTime: h ? hhmm(h.open_time) : '09:00',
      closeTime: h ? hhmm(h.close_time) : '19:00',
      breaks: breaks
        .filter((b) => b.day_of_week === d)
        .map((b) => ({ id: b.id, startTime: hhmm(b.start_time), endTime: hhmm(b.end_time), label: b.label })),
    });
  }
  const closures: Closure[] = closureRows.map((c) => ({
    id: c.id,
    // pg returns `date` as JS Date at local midnight; format using the raw ISO parts
    startDate: toDateStr(c.start_date),
    endDate: toDateStr(c.end_date),
    kind: c.kind,
    reason: c.reason,
  }));
  return { settings, days, closures };
}

function toDateStr(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v as Date;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isClosed(date: string, closures: Closure[]): Closure | null {
  return closures.find((c) => date >= c.startDate && date <= c.endDate) ?? null;
}

/** Public-facing subset of settings (no internal notification/retention fields). */
export function publicBusiness(s: BusinessSettings) {
  const wa = normalizePhone(s.whatsappNumber, s.defaultCountryCode);
  return {
    name: s.businessName,
    tagline: s.tagline,
    description: s.description,
    aboutText: s.aboutText,
    logoUrl: s.logoUrl,
    heroImageUrl: s.heroImageUrl,
    phone: s.contactPhone,
    whatsappNumber: s.whatsappNumber,
    whatsappLink: waLink(wa, `Hello ${s.businessName}, I would like to ask about an appointment.`),
    email: s.contactEmail,
    address: s.address,
    currency: s.currency,
    timezone: s.timezone,
    bookingPolicyText: s.bookingPolicyText,
    cancellationPolicyText: s.cancellationPolicyText,
    cancellationDeadlineHours: s.cancellationDeadlineHours,
    slotIntervalMinutes: s.slotIntervalMinutes,
    minNoticeMinutes: s.minNoticeMinutes,
    maxAdvanceDays: s.maxAdvanceDays,
    allowSameDay: s.allowSameDay,
  };
}
