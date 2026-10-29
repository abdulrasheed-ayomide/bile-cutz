import { DateTime } from 'luxon';

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** `YYYY-MM-DD` in the given zone for an instant. */
export function localDateOf(instant: Date | string, tz: string): string {
  const dt = DateTime.fromJSDate(new Date(instant)).setZone(tz);
  return dt.toFormat('yyyy-LL-dd');
}

/** `HH:mm` in the given zone for an instant. */
export function localTimeOf(instant: Date | string, tz: string): string {
  return DateTime.fromJSDate(new Date(instant)).setZone(tz).toFormat('HH:mm');
}

/** Converts a business-local wall-clock date + time (`HH:mm` or `HH:mm:ss`) to a UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const t = time.length === 5 ? `${time}:00` : time;
  const dt = DateTime.fromISO(`${date}T${t}`, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid local date/time ${date} ${time} in ${tz}`);
  return dt.toUTC().toJSDate();
}

export function isValidLocalDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date).isValid;
}

/** 0 = Sunday … 6 = Saturday for a local date string. */
export function dayOfWeekOf(date: string): number {
  return DateTime.fromISO(date, { zone: 'utc' }).weekday % 7; // luxon: Mon=1..Sun=7
}

export function addDaysLocal(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toFormat('yyyy-LL-dd');
}

export function todayLocal(tz: string, now: Date = new Date()): string {
  return localDateOf(now, tz);
}

/** All local dates (`YYYY-MM-DD`) in a `YYYY-MM` month. */
export function datesInMonth(month: string): string[] {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) return [];
  const out: string[] = [];
  for (let d = start; d.month === start.month; d = d.plus({ days: 1 })) out.push(d.toFormat('yyyy-LL-dd'));
  return out;
}

/** Trim a Postgres `time` string (`09:00:00`) to `HH:mm`. */
export function hhmm(t: string): string {
  return t.slice(0, 5);
}
