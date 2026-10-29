import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChatThread } from '../../components/Chat';
import { PageTitle } from '../../components/layouts';
import { NotificationList } from '../../components/NotificationList';
import { Badge, ConfirmDialog, Empty, ErrorBox, Field, Modal, Pager, Spinner, TextField, useLoad } from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth';
import { dateLabel, money, time12 } from '../../lib/format';
import { useSettings } from '../../lib/settings';
import { useToast } from '../../lib/toast';
import type { Appointment, Conversation, Paged, User } from '../../lib/types';

function ApptRow({ a }: { a: Appointment }) {
  return (
    <Link to={`/account/appointments/${a.id}`} className="panel row between" style={{ textDecoration: 'none', color: 'inherit', padding: '1rem 1.25rem' }}>
      <span><strong>{a.service.name}</strong><br /><span className="muted small">{dateLabel(a.localDate)} at {time12(a.localTime)} · {a.reference}</span></span>
      <Badge status={a.status} />
    </Link>
  );
}

export function Overview() {
  const { user } = useCustomerAuth();
  const up = useLoad(() => api<Paged<Appointment>>('/me/appointments', { query: { tab: 'upcoming', pageSize: 5 } }), []);
  const past = useLoad(() => api<Paged<Appointment>>('/me/appointments', { query: { tab: 'past', pageSize: 3 } }), []);
  return (
    <>
      <PageTitle actions={<Link to="/book" className="btn btn-primary">Book an appointment</Link>}>Hello, {user!.fullName.split(' ')[0]}</PageTitle>
      <h3>Upcoming</h3>
      <div className="stack" style={{ marginBottom: '2rem' }}>{up.loading ? <Spinner /> : up.error ? <ErrorBox message={up.error} retry={up.reload} /> : up.data!.items.length === 0 ? <div className="panel"><Empty title="Nothing booked yet">Pick a service and a time that suits you.</Empty></div> : up.data!.items.map((a) => <ApptRow key={a.id} a={a} />)}</div>
      {past.data && past.data.items.length > 0 && <><div className="row between"><h3>Recent history</h3><Link to="/account/appointments">See all</Link></div><div className="stack">{past.data.items.map((a) => <ApptRow key={a.id} a={a} />)}</div></>}
    </>
  );
}

export function AppointmentsPage() {
  const [tab, setTab] = useState<'upcoming' | 'past' | 'all'>('upcoming');
  const [page, setPage] = useState(1);
  const [claim, setClaim] = useState(false);
  const { data, loading, error, reload } = useLoad(() => api<Paged<Appointment>>('/me/appointments', { query: { tab, page, pageSize: 10 } }), [tab, page]);
  return (
    <>
      <PageTitle actions={<><button className="btn btn-ghost btn-sm" onClick={() => setClaim(true)}>Add a guest booking</button><Link to="/book" className="btn btn-primary btn-sm">New booking</Link></>}>My appointments</PageTitle>
      <div className="seg" style={{ marginBottom: '1rem' }} role="group" aria-label="Filter">{(['upcoming', 'past', 'all'] as const).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => { setTab(t); setPage(1); }}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}</div>
      {loading ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <div className="panel"><Empty title="No appointments here">{tab === 'upcoming' ? <Link to="/book">Book your next cut</Link> : 'Your booking history will show here.'}</Empty></div> : (
        <><div className="stack">{data!.items.map((a) => <ApptRow key={a.id} a={a} />)}</div><Pager page={data!.page} pageSize={data!.pageSize} total={data!.total} onPage={setPage} /></>)}
      {claim && <ClaimDialog onClose={() => setClaim(false)} onDone={reload} />}
    </>
  );
}

function ClaimDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    const token = v.trim().split('/').filter(Boolean).pop() ?? '';
    try { await api('/me/claim-booking', { body: { token } }); toast('ok', 'Booking added to your account'); onDone(); onClose(); } catch (x) { setErr(errMsg(x)); }
  }
  return (
    <Modal title="Add a guest booking" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Paste the private booking link from your confirmation email. Only someone holding the link can add the booking.</p>
        {err && <div className="alert alert-error" role="alert">{err}</div>}
        <Field id="claim" label="Private booking link" value={v} onChange={(e) => setV(e.target.value)} required />
        <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary">Add booking</button></div>
      </form>
    </Modal>
  );
}

export function AppointmentDetail() {
  const { id } = useParams();
  const { settings } = useSettings();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api<{ appointment: Appointment }>(`/me/appointments/${id}`), [id]);
  const [cancel, setCancel] = useState(false);
  const [review, setReview] = useState(false);
  if (loading) return <Spinner />;
  if (error || !data) return <><PageTitle>Appointment</PageTitle><ErrorBox message={error ?? 'Not found'} /></>;
  const a = data.appointment;
  return (
    <>
      <PageTitle actions={<Badge status={a.status} />}>{a.service.name}</PageTitle>
      <div className="two-col">
        <div className="panel stack">
          <dl className="kv"><dt>Reference</dt><dd>{a.reference}</dd><dt>When</dt><dd>{dateLabel(a.localDate)}, {time12(a.localTime)} – {time12(a.localEndTime)}</dd><dt>Price</dt><dd>{money(a.service.price, a.currency)} (pay at the shop)</dd><dt>Booked</dt><dd>{new Date(a.createdAt).toLocaleString('en-GB')}</dd>{a.notes && <><dt>Your notes</dt><dd>{a.notes}</dd></>}{a.statusReason && <><dt>Shop note</dt><dd>{a.statusReason}</dd></>}</dl>
          {a.status === 'pending' && <div className="alert alert-info">Waiting for the shop to approve this request.</div>}
          <div className="row">
            {a.status === 'approved' && <Link className="btn btn-primary" to={`/account/appointments/${a.id}/confirmation`}>View printable confirmation</Link>}
            {a.canCancel && <button className="btn btn-danger" onClick={() => setCancel(true)}>Cancel appointment</button>}
            {a.canReview && <button className="btn btn-primary" onClick={() => setReview(true)}>Leave a review</button>}
            {a.hasReview && <span className="muted small">Thanks — your review has been sent to the shop.</span>}
          </div>
          {!a.canCancel && ['pending', 'approved'].includes(a.status) && <p className="hint">Online cancellation closes {settings?.business.cancellationDeadlineHours} hour(s) before the appointment. Please contact the shop to change it.</p>}
        </div>
        <div className="panel"><h3>History</h3><ul className="timeline">{a.history?.map((h, i) => <li key={i}><strong>{h.toStatus[0]!.toUpperCase() + h.toStatus.slice(1)}</strong><div className="muted small">{new Date(h.createdAt).toLocaleString('en-GB')}{h.changedByRole !== 'customer' && h.changedByRole !== 'guest' ? ' · by the shop' : ''}</div>{h.reason && <div className="small">{h.reason}</div>}</li>)}</ul></div>
      </div>
      {cancel && <ConfirmDialog title="Cancel this appointment?" message={`${a.service.name} on ${dateLabel(a.localDate)} at ${time12(a.localTime)}. The shop will be told.`} confirmLabel="Cancel appointment" danger askReason onClose={() => setCancel(false)} onConfirm={async (reason) => { try { await api(`/me/appointments/${a.id}/cancel`, { body: { reason } }); toast('ok', 'Appointment cancelled'); reload(); } catch (e) { toast('error', errMsg(e)); throw e; } }} />}
      {review && <ReviewDialog id={a.id} onClose={() => setReview(false)} onDone={reload} />}
    </>
  );
}

function ReviewDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api(`/me/appointments/${id}/review`, { body: { rating, comment } }); toast('ok', 'Thanks! The shop will review it before it’s published.'); onDone(); onClose(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <Modal title="How was your visit?" onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="alert alert-error" role="alert">{err}</div>}
        <fieldset><legend>Rating</legend><div className="row">{[1, 2, 3, 4, 5].map((n) => <label key={n} className="check"><input type="radio" name="rating" checked={rating === n} onChange={() => setRating(n)} />{n}★</label>)}</div></fieldset>
        <TextField id="comment" label="Your review" value={comment} maxLength={1500} required onChange={(e) => setComment(e.target.value)} hint="Reviews are published after the shop approves them." />
        <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !comment.trim()}>{busy ? 'Sending…' : 'Send review'}</button></div>
      </form>
    </Modal>
  );
}

export function ConfirmationPage() {
  const { id } = useParams();
  const { data, loading, error } = useLoad(() => api<{ appointment: Appointment; business: any }>(`/me/appointments/${id}/confirmation`), [id]);
  if (loading) return <Spinner />;
  if (error || !data) return <><PageTitle>Confirmation</PageTitle><ErrorBox message={error ?? 'Not available'} /><Link to={`/account/appointments/${id}`}>Back to appointment</Link></>;
  const { appointment: a, business: b } = data;
  return (
    <>
      <div className="row between no-print" style={{ marginBottom: '1rem' }}><Link to={`/account/appointments/${a.id}`}>‹ Back</Link><button className="btn btn-primary" onClick={() => window.print()}>Print confirmation</button></div>
      <div className="ticket print-area">
        <p className="muted" style={{ margin: 0 }}>{b.name} · Appointment confirmation</p>
        <div className="ref">{a.reference}</div>
        <dl>
          <dt>Status</dt><dd>Approved</dd><dt>Customer</dt><dd>{a.customer.name}</dd><dt>Service</dt><dd>{a.service.name} ({a.service.durationMinutes} min)</dd>
          <dt>Date</dt><dd>{dateLabel(a.localDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</dd><dt>Time</dt><dd>{time12(a.localTime)} – {time12(a.localEndTime)}</dd>
          <dt>Price</dt><dd>{money(a.service.price, a.currency)} — payable at the shop</dd>
        </dl>
        <hr />
        <p className="muted small" style={{ margin: 0 }}><strong>{b.name}</strong><br />{b.address}<br />{b.phone} · {b.email}</p>
        <p className="muted small">{b.cancellationPolicyText}</p>
      </div>
    </>
  );
}

export function MessagesPage() {
  const { data, loading, error, reload } = useLoad(() => api<{ conversation: Conversation }>('/chat/conversation'), []);
  const { settings } = useSettings();
  return (
    <>
      <PageTitle>Messages</PageTitle>
      <p className="muted">Private chat with {settings?.business.name}. Only you and the shop can see this conversation.</p>
      {loading ? <Spinner /> : error || !data ? <ErrorBox message={error ?? 'Could not load chat'} retry={reload} /> : <ChatThread conversationId={data.conversation.id} side="customer" title={settings?.business.name ?? 'Shop'} />}
    </>
  );
}

export const NotificationsPage = () => (<><PageTitle>Notifications</PageTitle><NotificationList scope="customer" /></>);

export function ProfilePage() {
  const { user, setUser } = useCustomerAuth();
  const toast = useToast();
  const [p, setP] = useState({ fullName: user!.fullName, phone: user!.phone ?? '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [err, setErr] = useState(''); const [pwErr, setPwErr] = useState('');
  const nav = useNavigate(); void nav;
  async function saveProfile(e: FormEvent) { e.preventDefault(); setErr(''); try { const r = await api<{ user: User }>('/me/profile', { method: 'PATCH', body: p }); setUser(r.user); toast('ok', 'Profile saved'); } catch (x) { setErr(errMsg(x)); } }
  async function savePw(e: FormEvent) { e.preventDefault(); setPwErr(''); try { await api('/me/password', { body: pw }); setPw({ currentPassword: '', newPassword: '', confirmPassword: '' }); toast('ok', 'Password changed'); } catch (x) { setPwErr(errMsg(x)); } }
  return (
    <>
      <PageTitle>Profile & password</PageTitle>
      <div className="two-col" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <form className="panel" onSubmit={saveProfile}><h3>Your details</h3>{err && <div className="alert alert-error" role="alert">{err}</div>}
          <Field id="fn" label="Full name" value={p.fullName} onChange={(e) => setP({ ...p, fullName: e.target.value })} required />
          <Field id="em" label="Email" value={user!.email} readOnly hint="Your email is your sign-in and can’t be changed here." />
          <Field id="ph" label="Phone" type="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />
          <button className="btn btn-primary">Save changes</button></form>
        <form className="panel" onSubmit={savePw}><h3>Change password</h3>{pwErr && <div className="alert alert-error" role="alert">{pwErr}</div>}
          <Field id="cp" label="Current password" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required />
          <Field id="np" label="New password" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} hint="At least 8 characters, with a letter and a number." required />
          <Field id="cn" label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirmPassword} onChange={(e) => setPw({ ...pw, confirmPassword: e.target.value })} required />
          <button className="btn btn-primary">Change password</button></form>
      </div>
    </>
  );
}
