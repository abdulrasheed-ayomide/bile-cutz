import { describe, expect, it } from 'vitest';
import { addDays, dateLabel, duration, money, time12, todayIn } from './format';

describe('format helpers', () => {
  it('formats money in the shop currency', () => {
    expect(money(3000, 'NGN')).toMatch(/3,000/);
    expect(money(12.5, 'USD')).toMatch(/12\.50/);
  });
  it('formats durations', () => {
    expect(duration(30)).toBe('30 min');
    expect(duration(60)).toBe('1 hr');
    expect(duration(90)).toBe('1 hr 30 min');
  });
  it('converts 24h times to 12h', () => {
    expect(time12('09:00')).toBe('9:00 AM');
    expect(time12('13:30')).toBe('1:30 PM');
    expect(time12('00:15')).toBe('12:15 AM');
    expect(time12('12:00')).toBe('12:00 PM');
  });
  it('does not shift local dates across timezones', () => {
    expect(dateLabel('2026-10-27', { day: 'numeric', month: 'short', year: 'numeric' })).toBe('27 Oct 2026');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('computes today in a given timezone', () => {
    expect(todayIn('Africa/Lagos')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
