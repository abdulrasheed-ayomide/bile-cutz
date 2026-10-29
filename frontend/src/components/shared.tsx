import { Link } from 'react-router-dom';
import { duration, money } from '../lib/format';
import type { Service } from '../lib/types';
import { useSettings } from '../lib/settings';

export function ServiceCard({ s, currency, action = true }: { s: Service; currency: string; action?: boolean }) {
  return (
    <article className="service-card">
      <div className="media">
        {s.imageUrl ? <img src={s.imageUrl} alt="" loading="lazy" /> : (
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" /></svg>
        )}
      </div>
      <div className="body">
        <h3>{s.name}</h3>
        <p>{s.description}</p>
        <div className="service-meta"><span className="price">{money(s.price, currency)}</span><span className="muted small">{duration(s.durationMinutes)}</span></div>
        {action && <Link to={`/book?service=${s.id}`} className="btn btn-ghost btn-sm" style={{ marginTop: '.5rem' }}>Book {s.name}</Link>}
      </div>
    </article>
  );
}

export function HoursTable() {
  const { settings } = useSettings();
  if (!settings) return null;
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: settings.business.timezone }).format(new Date()) + 'T12:00:00Z').getUTCDay();
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fmt = (t: string) => { const [h, m] = t.split(':').map(Number); return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h! < 12 ? 'am' : 'pm'}`; };
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <table className="hours-table"><tbody>
      {order.map((d) => { const h = settings.openingHours[d]!; return (
        <tr key={d} className={d === today ? 'today' : ''}>
          <td>{names[d]}</td>
          <td>{h.isOpen ? `${fmt(h.openTime)} – ${fmt(h.closeTime)}` : 'Closed'}{h.isOpen && h.breaks.length > 0 && <span className="muted small"> (break {h.breaks.map((b) => `${fmt(b.startTime)}–${fmt(b.endTime)}`).join(', ')})</span>}</td>
        </tr>
      ); })}
    </tbody></table>
  );
}
