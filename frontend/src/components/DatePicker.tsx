import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { addDays, dateLabel, pad, todayIn } from '../lib/format';
import { useLoad } from './ui';

/** Month calendar that disables days the server says have no free slot. */
export function DatePicker({ serviceId, value, onChange, timezone, adminMode }: { serviceId: string; value: string | null; onChange: (d: string) => void; timezone: string; adminMode?: boolean }) {
  const today = todayIn(timezone);
  const [month, setMonth] = useState((value ?? today).slice(0, 7));
  const path = adminMode ? '/admin/availability/dates' : '/public/availability/dates';
  const { data, loading } = useLoad(() => api<{ dates: { date: string; available: boolean }[] }>(path, { query: { serviceId, month } }), [serviceId, month]);
  const avail = useMemo(() => new Map((data?.dates ?? []).map((d) => [d.date, d.available])), [data]);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = first.getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = (n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`); };
  return (
    <div className="cal" aria-busy={loading}>
      <div className="cal-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => shift(-1)} disabled={month <= today.slice(0, 7)} aria-label="Previous month">‹</button>
        <strong>{dateLabel(`${month}-01`, { month: 'long', year: 'numeric' })}</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="cal-grid" role="grid" aria-label="Choose a date">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="dow" aria-hidden>{d}</div>)}
        {Array.from({ length: lead }).map((_, i) => <div key={`b${i}`} />)}
        {Array.from({ length: days }).map((_, i) => {
          const date = `${month}-${pad(i + 1)}`;
          const ok = !!avail.get(date);
          return <button type="button" key={date} className={`cal-day ${date === today ? 'today' : ''}`} disabled={!ok} aria-pressed={value === date} aria-label={`${dateLabel(date)}${ok ? '' : ', unavailable'}`} onClick={() => onChange(date)}>{i + 1}</button>;
        })}
      </div>
      <p className="hint" style={{ marginTop: '.6rem' }}>Crossed-out days are closed or fully booked.</p>
    </div>
  );
}
export { addDays };
