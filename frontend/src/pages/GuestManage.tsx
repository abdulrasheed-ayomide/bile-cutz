import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, ConfirmDialog, ErrorBox, Spinner, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { dateLabel, money, time12 } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Appointment } from '../lib/types';

/** Private guest booking page, authorised only by the unguessable token in the URL. */
export function GuestManagePage() {
  const { token } = useParams();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api<{ appointment: Appointment; business: any }>(`/guest/bookings/${token}`), [token]);
  if (loading) return <Spinner />;
  if (error || !data) return <div className="wrap section narrow"><h1>Booking not found</h1><ErrorBox message="This link isn’t valid. Check that you copied the whole link from your email." /></div>;
  const a = data.appointment;
  return (
    <div className="wrap section narrow">
      <p className="muted">Your private booking</p>
      <h1 style={{ fontSize: 'clamp(2rem,6vw,3.2rem)' }}>{a.reference}</h1>
      <div className="panel stack">
        <div className="row between"><strong>{a.service.name}</strong><Badge status={a.status} /></div>
        <dl className="summary-list"><dt>When</dt><dd>{dateLabel(a.localDate)} at {time12(a.localTime)}</dd><dt>Price</dt><dd>{money(a.service.price, a.currency)} — pay at the shop</dd><dt>Name</dt><dd>{a.customer.name}</dd>{a.statusReason && <><dt>Note</dt><dd>{a.statusReason}</dd></>}</dl>
        {a.status === 'pending' && <div className="alert alert-info">Waiting for the shop to approve your request.</div>}
        {a.status === 'approved' && <div className="alert alert-ok">Confirmed. See you at {data.business.address}.</div>}
        {a.history && <details><summary className="small muted" style={{ cursor: 'pointer' }}>History</summary><ul className="timeline" style={{ marginTop: '.8rem' }}>{a.history.map((h, i) => <li key={i}><strong>{h.toStatus[0]!.toUpperCase() + h.toStatus.slice(1)}</strong> <span className="muted small">{new Date(h.createdAt).toLocaleString('en-GB')}</span>{h.reason && <div className="small muted">{h.reason}</div>}</li>)}</ul></details>}
        <div className="row">{a.canCancel && <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel booking</button>}{data.business.whatsappLink && <a className="btn btn-ghost" href={data.business.whatsappLink} target="_blank" rel="noopener noreferrer">Message the shop</a>}</div>
        {!a.canCancel && ['pending', 'approved'].includes(a.status) && <p className="hint">{data.business.cancellationPolicyText} To change this booking now, contact the shop on {data.business.phone}.</p>}
      </div>
      <p className="muted small" style={{ marginTop: '1.5rem' }}>Anyone with this link can view and cancel this booking, so keep it private. Want it in an account? <Link to="/register">Create one</Link>, then add this booking from “My appointments”.</p>
      {cancelling && <ConfirmDialog title="Cancel this booking?" message="The time will be released for other customers." confirmLabel="Cancel booking" danger askReason onClose={() => setCancelling(false)} onConfirm={async (reason) => { await api(`/guest/bookings/${token}/cancel`, { body: { reason } }); toast('ok', 'Booking cancelled'); reload(); }} />}
    </div>
  );
}
