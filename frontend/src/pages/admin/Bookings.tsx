import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DatePicker } from '../../components/DatePicker';
import { PageTitle } from '../../components/layouts';
import { Badge, ConfirmDialog, Empty, ErrorBox, Field, Pager, SelectField, Spinner, TextField, useDebounced, useLoad } from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { DAYS, SOURCE_LABEL, STATUS_LABEL, addDays, dateLabel, money, pad, time12, todayIn } from '../../lib/format';
import { useSettings } from '../../lib/settings';
import { useToast } from '../../lib/toast';
import type { Appointment, Paged, Service, Status } from '../../lib/types';

const changed = () => window.dispatchEvent(new Event('admin:changed'));

export function Dashboard() {
  const { data, loading, error, reload } = useLoad(() => api<any>('/admin/dashboard/summary'), []);
  const { settings } = useSettings();
  const today = settings ? todayIn(settings.business.timezone) : '';
  if (loading) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? 'Failed'} retry={reload} />;
  const cards: [string, number, string, boolean?][] = [
    ["Today's appointments", data.todayAppointments, `/admin/appointments?date=${today}`],
    ['Pending approvals', data.pendingApprovals, '/admin/appointments?status=pending', data.pendingApprovals > 0],
    ['Approved', data.approved, '/admin/appointments?status=approved'],
    ['Completed', data.completed, '/admin/appointments?status=completed'],
    ['Cancelled', data.cancelled, '/admin/appointments?status=cancelled'],
    ['Customers', data.totalCustomers, '/admin/customers'],
    ['Reviews to approve', data.pendingReviews, '/admin/reviews?status=pending', data.pendingReviews > 0],
    ['Unread conversations', data.unreadConversations, '/admin/messages?unread=1', data.unreadConversations > 0],
  ];
  return (
    <>
      <PageTitle actions={<Link className="btn btn-primary" to="/admin/bookings/new">New booking</Link>}>Dashboard</PageTitle>
      <div className="stats">{cards.map(([l, n, to, hot]) => <Link key={l} to={to} className={`stat ${hot ? 'hot' : ''}`}><div className="n">{n}</div><div className="l">{l}</div></Link>)}</div>
      <div className="panel panel-flush">
        <div className="row between" style={{ padding: '1rem 1.25rem 0' }}><h3 style={{ margin: 0 }}>Next up</h3><Link to="/admin/appointments?status=pending">Review pending</Link></div>
        {data.upcoming.length === 0 ? <Empty title="No upcoming appointments" /> : <ApptTable items={data.upcoming} />}
      </div>
    </>
  );
}

function ApptTable({ items }: { items: Appointment[] }) {
  const nav = useNavigate();
  return (
    <div className="table-wrap"><table className="stack-table">
      <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Source</th><th>Status</th></tr></thead>
      <tbody>{items.map((a) => (
        <tr key={a.id} className="click" onClick={() => nav(`/admin/appointments/${a.id}`)}>
          <td data-label="When" className="nowrap"><Link to={`/admin/appointments/${a.id}`} onClick={(e) => e.stopPropagation()}>{dateLabel(a.localDate, { weekday: 'short', day: 'numeric', month: 'short' })}, {time12(a.localTime)}</Link></td>
          <td data-label="Customer">{a.customer.name}<div className="muted small">{a.reference}</div></td>
          <td data-label="Service">{a.service.name}</td><td data-label="Source">{SOURCE_LABEL[a.source]}</td><td data-label="Status"><Badge status={a.status} /></td>
        </tr>))}</tbody>
    </table></div>
  );
}

export function AppointmentsList() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); n.delete('page'); setSp(n, { replace: true }); };
  const page = Number(get('page') || 1);
  const services = useLoad(() => api<{ items: Service[] }>('/admin/services'), []);
  const { data, loading, error, reload } = useLoad(() => api<Paged<Appointment>>('/admin/appointments', { query: { q: dq, status: get('status'), date: get('date'), serviceId: get('serviceId'), source: get('source'), customerId: get('customerId'), sort: get('sort') || 'start_desc', page, pageSize: 20 } }), [dq, sp.toString()]);
  return (
    <>
      <PageTitle actions={<Link className="btn btn-primary" to="/admin/bookings/new">New booking</Link>}>Appointments</PageTitle>
      <div className="filters" role="search">
        <div className="field"><label htmlFor="fq">Search</label><input id="fq" type="search" placeholder="Name, email, phone or reference" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <SelectField id="fs" label="Status" value={get('status')} onChange={(e) => set('status', e.target.value)}><option value="">All statuses</option>{(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</SelectField>
        <div className="field"><label htmlFor="fd">Date</label><input id="fd" type="date" value={get('date')} onChange={(e) => set('date', e.target.value)} /></div>
        <SelectField id="fv" label="Service" value={get('serviceId')} onChange={(e) => set('serviceId', e.target.value)}><option value="">All services</option>{services.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField>
        <SelectField id="fo" label="Booking source" value={get('source')} onChange={(e) => set('source', e.target.value)}><option value="">All sources</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</SelectField>
        <SelectField id="fr" label="Sort" value={get('sort')} onChange={(e) => set('sort', e.target.value)}><option value="start_desc">Newest appointment first</option><option value="start_asc">Oldest appointment first</option><option value="created_desc">Recently requested</option></SelectField>
      </div>
      {get('customerId') && <div className="alert alert-info row between">Showing one customer’s bookings <button className="link-btn" onClick={() => set('customerId', '')}>Clear</button></div>}
      <div className="panel panel-flush">
        {loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No appointments match">Try clearing a filter.</Empty> : <ApptTable items={data!.items} />}
        {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => { const n = new URLSearchParams(sp); n.set('page', String(p)); setSp(n); }} />}
      </div>
    </>
  );
}

export function AppointmentDetailAdmin() {
  const { id } = useParams();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useLoad(() => api<{ appointment: Appointment }>(`/admin/appointments/${id}`), [id]);
  const [dlg, setDlg] = useState<null | 'approve' | 'reject' | 'cancel' | 'complete'>(null);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <><PageTitle>Appointment</PageTitle><ErrorBox message={error ?? 'Not found'} /></>;
  const a = data.appointment;
  const can = { approve: a.status === 'pending', reject: a.status === 'pending', cancel: a.status === 'pending' || a.status === 'approved', complete: a.status === 'approved' && new Date(a.startAt) <= new Date() };
  const copy: Record<string, [string, string, boolean]> = { approve: ['Approve this booking?', 'Approve', false], reject: ['Reject this booking?', 'Reject', true], cancel: ['Cancel this booking?', 'Cancel booking', true], complete: ['Mark as completed?', 'Mark completed', false] };
  const wa = a.whatsapp;
  return (
    <>
      <PageTitle actions={<><Badge status={a.status} /><button className="btn btn-ghost btn-sm no-print" onClick={() => window.print()}>Print</button></>}>{a.reference}</PageTitle>
      <div className="two-col">
        <div className="stack">
          <div className="panel">
            <h3>Appointment</h3>
            <dl className="kv"><dt>Service</dt><dd>{a.service.name} · {a.service.durationMinutes} min · {money(a.service.price, a.currency)}</dd><dt>When</dt><dd>{dateLabel(a.localDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, {time12(a.localTime)} – {time12(a.localEndTime)}</dd><dt>Source</dt><dd>{SOURCE_LABEL[a.source]}</dd><dt>Requested</dt><dd>{new Date(a.createdAt).toLocaleString('en-GB')}</dd>{a.notes && <><dt>Customer notes</dt><dd>{a.notes}</dd></>}{a.statusReason && <><dt>Reason</dt><dd>{a.statusReason}</dd></>}{a.cancelledAt && <><dt>Cancelled</dt><dd>{new Date(a.cancelledAt).toLocaleString('en-GB')} by {a.cancelledByRole}</dd></>}</dl>
            <div className="row no-print" style={{ marginTop: '1rem' }}>
              {can.approve && <button className="btn btn-primary" onClick={() => setDlg('approve')}>Approve</button>}
              {can.reject && <button className="btn btn-danger" onClick={() => setDlg('reject')}>Reject</button>}
              {can.complete && <button className="btn btn-primary" onClick={() => setDlg('complete')}>Mark completed</button>}
              {can.cancel && <button className="btn btn-danger" onClick={() => setDlg('cancel')}>Cancel</button>}
            </div>
            {a.status === 'approved' && !can.complete && <p className="hint no-print">You can mark this completed once the appointment time has started.</p>}
          </div>
          <div className="panel"><h3>Customer</h3>
            <dl className="kv"><dt>Name</dt><dd>{a.customer.userId ? <Link to={`/admin/customers/${a.customer.userId}`}>{a.customer.name}</Link> : a.customer.name} {!a.customer.userId && <span className="muted small">(guest)</span>}</dd><dt>Email</dt><dd>{a.customer.email ? <a href={`mailto:${a.customer.email}`}>{a.customer.email}</a> : '—'}</dd><dt>Phone</dt><dd>{a.customer.phone ? <a href={`tel:${a.customer.phone}`}>{a.customer.phone}</a> : '—'}</dd></dl>
            <div className="row no-print" style={{ marginTop: '1rem' }}>
              {wa?.chatLink ? <>
                {['approved'].includes(a.status) && wa.confirmationLink && <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href={wa.confirmationLink}>WhatsApp: confirmation</a>}
                {a.status === 'approved' && wa.reminderLink && <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href={wa.reminderLink}>WhatsApp: reminder</a>}
                {['cancelled', 'rejected'].includes(a.status) && wa.cancellationLink && <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href={wa.cancellationLink}>WhatsApp: cancellation</a>}
                <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href={wa.chatLink}>WhatsApp: open chat</a></> : <span className="muted small">Add a phone number to this customer to use WhatsApp.</span>}
            </div>
            {wa?.chatLink && <p className="hint no-print">WhatsApp opens with a message ready to send. You choose whether to send it, and we can’t tell if it was delivered or read.</p>}
          </div>
        </div>
        <div className="panel"><h3>Status history</h3><ul className="timeline">{a.history?.map((h, i) => <li key={i}><strong>{STATUS_LABEL[h.toStatus]}</strong>{h.fromStatus && <span className="muted small"> (from {STATUS_LABEL[h.fromStatus].toLowerCase()})</span>}<div className="muted small">{new Date(h.createdAt).toLocaleString('en-GB')} · {h.changedByName ?? (h.changedByRole === 'guest' ? 'Guest' : h.changedByRole)}</div>{h.reason && <div className="small">{h.reason}</div>}</li>)}</ul></div>
      </div>
      {dlg && <ConfirmDialog title={copy[dlg]![0]} message={`${a.customer.name} · ${a.service.name} · ${dateLabel(a.localDate)} ${time12(a.localTime)}. The customer is notified${a.customer.userId ? ' in their account' : ''}.`} confirmLabel={copy[dlg]![1]} danger={copy[dlg]![2]} askReason={dlg === 'reject' || dlg === 'cancel'} onClose={() => setDlg(null)}
        onConfirm={async (reason) => { try { const r = await api<{ appointment: Appointment }>(`/admin/appointments/${a.id}/${dlg}`, { body: { reason } }); setData(r); changed(); toast('ok', `Booking ${STATUS_LABEL[r.appointment.status].toLowerCase()}`); } catch (e) { toast('error', errMsg(e)); throw e; } }} />}
      {error && <ErrorBox message={error} retry={reload} />}
    </>
  );
}

/* ---------------- Calendar ---------------- */
type View = 'day' | 'week' | 'month';
export function CalendarPage() {
  const { settings } = useSettings();
  const tz = settings?.business.timezone ?? 'Africa/Lagos';
  const nav = useNavigate();
  const [view, setView] = useState<View>(window.innerWidth < 700 ? 'day' : 'month');
  const [anchor, setAnchor] = useState(todayIn(tz));
  const [status, setStatus] = useState('');
  const [picked, setPicked] = useState<Appointment | null>(null);
  const today = todayIn(tz);
  const range = useMemo(() => {
    const d = new Date(`${anchor}T12:00:00Z`);
    if (view === 'day') return { from: anchor, to: anchor };
    if (view === 'week') { const s = addDays(anchor, -d.getUTCDay()); return { from: s, to: addDays(s, 6) }; }
    const first = `${anchor.slice(0, 7)}-01`; const f = new Date(`${first}T12:00:00Z`);
    const s = addDays(first, -f.getUTCDay());
    return { from: s, to: addDays(s, 41) };
  }, [anchor, view]);
  // Query a UTC window one day wider on each side, then bucket by the server-supplied business-local date.
  const { data, loading, error, reload } = useLoad(() => api<{ items: Appointment[] }>('/admin/appointments/calendar', { query: { from: new Date(`${addDays(range.from, -1)}T00:00:00Z`).toISOString(), to: new Date(`${addDays(range.to, 2)}T00:00:00Z`).toISOString(), status } }), [range.from, range.to, status]);
  const byDate = useMemo(() => { const m = new Map<string, Appointment[]>(); for (const a of data?.items ?? []) { if (a.localDate >= range.from && a.localDate <= range.to) (m.get(a.localDate) ?? m.set(a.localDate, []).get(a.localDate)!).push(a); } return m; }, [data, range]);
  const step = (n: number) => { if (view === 'month') { const d = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); setAnchor(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`); } else setAnchor(addDays(anchor, n * (view === 'week' ? 7 : 1))); };
  const title = view === 'month' ? dateLabel(anchor, { month: 'long', year: 'numeric' }) : view === 'week' ? `${dateLabel(range.from, { day: 'numeric', month: 'short' })} – ${dateLabel(range.to, { day: 'numeric', month: 'short', year: 'numeric' })}` : dateLabel(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const evt = (a: Appointment) => <button key={a.id} className={`evt s-${a.status}`} onClick={(e) => { e.stopPropagation(); setPicked(a); }} title={`${a.customer.name} — ${a.service.name}`}>{time12(a.localTime)} {a.customer.name}</button>;
  return (
    <>
      <PageTitle actions={<Link className="btn btn-primary btn-sm" to="/admin/bookings/new">New booking</Link>}>Calendar</PageTitle>
      <div className="cal-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => step(-1)} aria-label="Previous">‹</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setAnchor(today)}>Today</button>
        <button className="btn btn-ghost btn-sm" onClick={() => step(1)} aria-label="Next">›</button>
        <strong className="grow" aria-live="polite">{title}</strong>
        <div className="seg" role="group" aria-label="View">{(['day', 'week', 'month'] as View[]).map((v) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v[0]!.toUpperCase() + v.slice(1)}</button>)}</div>
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">All statuses</option>{(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
      </div>
      {error && <ErrorBox message={error} retry={reload} />}
      <div aria-busy={loading}>
        {view === 'month' && <div className="month-grid">{DAYS.map((d) => <div className="dow" key={d}>{d.slice(0, 3)}</div>)}
          {Array.from({ length: 42 }).map((_, i) => { const d = addDays(range.from, i); const list = byDate.get(d) ?? []; return (
            <button key={d} className={`mcell ${d.slice(0, 7) !== anchor.slice(0, 7) ? 'other' : ''} ${d === today ? 'today' : ''}`} onClick={() => { setAnchor(d); setView('day'); }} aria-label={`${dateLabel(d)}: ${list.length} appointments`}>
              <span className="d">{Number(d.slice(8))}</span>{list.slice(0, 3).map(evt)}{list.length > 3 && <span className="more">+{list.length - 3} more</span>}
              <span className="dotrow">{list.slice(0, 6).map((a) => <i key={a.id} />)}</span>
            </button>); })}</div>}
        {view === 'week' && <div className="week-grid">{Array.from({ length: 7 }).map((_, i) => { const d = addDays(range.from, i); const list = byDate.get(d) ?? []; return <div key={d} className={`week-col ${d === today ? 'today' : ''}`}><h4>{dateLabel(d, { weekday: 'short', day: 'numeric', month: 'short' })}</h4>{list.length === 0 ? <span className="muted small">Free</span> : list.map(evt)}</div>; })}</div>}
        {view === 'day' && ((byDate.get(anchor) ?? []).length === 0 ? <div className="panel"><Empty title="No appointments this day" /></div> : <div className="day-list">{(byDate.get(anchor) ?? []).map((a) => <button key={a.id} className={`day-item s-${a.status}`} onClick={() => setPicked(a)}><span className="t">{time12(a.localTime)}</span><span className="grow"><strong>{a.customer.name}</strong><br /><span className="muted small">{a.service.name} · {SOURCE_LABEL[a.source]}</span></span><Badge status={a.status} /></button>)}</div>)}
      </div>
      {picked && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPicked(null)}><div className="modal" role="dialog" aria-modal="true" aria-label="Appointment details">
          <div className="row between"><h3 style={{ margin: 0 }}>{picked.service.name}</h3><Badge status={picked.status} /></div>
          <dl className="kv" style={{ margin: '1rem 0' }}><dt>Customer</dt><dd>{picked.customer.name}</dd><dt>When</dt><dd>{dateLabel(picked.localDate)}, {time12(picked.localTime)} – {time12(picked.localEndTime)}</dd><dt>Reference</dt><dd>{picked.reference}</dd>{picked.customer.phone && <><dt>Phone</dt><dd>{picked.customer.phone}</dd></>}</dl>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setPicked(null)}>Close</button><button className="btn btn-primary" onClick={() => nav(`/admin/appointments/${picked.id}`)}>Open appointment</button></div>
        </div></div>)}
    </>
  );
}

/* ---------------- Manual booking ---------------- */
export function NewBooking() {
  const { settings } = useSettings();
  const nav = useNavigate();
  const toast = useToast();
  const services = useLoad(() => api<{ items: Service[] }>('/admin/services'), []);
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState('');
  const [f, setF] = useState({ name: '', phone: '', email: '', notes: '', source: 'walk_in' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const slots = useLoad(() => (serviceId && date ? api<{ slots: { startAt: string; time: string; available: boolean }[] }>('/admin/availability', { query: { serviceId, date } }) : Promise.resolve(null)), [serviceId, date]);
  const active = services.data?.items.filter((s) => s.isActive) ?? [];
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api<{ appointment: Appointment }>('/admin/appointments', { body: { serviceId, startAt: slot, ...f } }); changed(); toast('ok', `Booking ${r.appointment.reference} created`); nav(`/admin/appointments/${r.appointment.id}`); }
    catch (x) { setErr(errMsg(x)); slots.reload(); } finally { setBusy(false); }
  }
  if (!settings) return <Spinner />;
  return (
    <>
      <PageTitle>New booking</PageTitle>
      <p className="muted">For walk-ins and phone bookings. It follows the same hours, breaks and capacity as online bookings, and is approved straight away.</p>
      <form onSubmit={submit} className="two-col" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="stack">
          <SelectField id="svc" label="Service" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSlot(''); setDate(null); }} required><option value="">Choose a service…</option>{active.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min · {money(s.price, settings.business.currency)}</option>)}</SelectField>
          {serviceId && <DatePicker adminMode serviceId={serviceId} value={date} onChange={(d) => { setDate(d); setSlot(''); }} timezone={settings.business.timezone} />}
          {date && (slots.loading ? <Spinner /> : <div className="slots" role="group" aria-label="Times">{slots.data?.slots.map((s) => <button type="button" key={s.startAt} className="slot" disabled={!s.available} aria-pressed={slot === s.startAt} onClick={() => setSlot(s.startAt)}>{time12(s.time)}</button>)}</div>)}
        </div>
        <div className="panel">
          {err && <div className="alert alert-error" role="alert">{err}</div>}
          <Field id="nm" label="Customer name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <Field id="ph" label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} hint="Used for WhatsApp links." />
          <Field id="em" label="Email (optional)" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <SelectField id="src" label="Booking source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{['walk_in', 'phone', 'in_person', 'other'].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</SelectField>
          <TextField id="nt" label="Notes" value={f.notes} maxLength={500} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          <button className="btn btn-primary btn-block" disabled={busy || !slot || !f.name.trim()}>{busy ? 'Saving…' : 'Create booking'}</button>
        </div>
      </form>
    </>
  );
}
