import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DatePicker } from '../components/DatePicker';
import { Empty, ErrorBox, Field, Spinner, TextField, useLoad } from '../components/ui';
import { ApiError, api, errMsg } from '../lib/api';
import { useCustomerAuth } from '../lib/auth';
import { dateLabel, duration, money, time12 } from '../lib/format';
import { useSettings } from '../lib/settings';
import type { Appointment, Service } from '../lib/types';

interface Slot { startAt: string; time: string; available: boolean }
const STEPS = ['Service', 'Date and time', 'Your details', 'Review'];

export function BookingPage() {
  const { settings } = useSettings();
  const { user } = useCustomerAuth();
  const [params] = useSearchParams();
  const [step, setStep] = useState(0);
  const [service, setService] = useState<Service | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<{ appointment: Appointment; managementPath?: string } | null>(null);
  const services = useLoad(() => api<{ items: Service[] }>('/public/services'), []);
  const slots = useLoad(() => (service && date ? api<{ slots: Slot[] }>('/public/availability', { query: { serviceId: service.id, date } }) : Promise.resolve(null)), [service?.id, date]);

  useEffect(() => { if (user) setForm((f) => ({ ...f, name: user.fullName, email: user.email, phone: f.phone || user.phone || '' })); }, [user]);
  useEffect(() => {
    const pre = params.get('service');
    if (pre && services.data && !service) { const s = services.data.items.find((x) => x.id === pre); if (s) { setService(s); setStep(1); } }
  }, [params, services.data, service]);

  const b = settings?.business;
  const currency = b?.currency ?? 'NGN';
  const freeSlots = useMemo(() => slots.data?.slots.filter((s) => s.available) ?? [], [slots.data]);

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Enter your name';
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'Enter a valid email address';
    if (form.phone && !/^[\d+()\-\s.]{6,30}$/.test(form.phone)) e.phone = 'Enter a valid phone number';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (!service || !slot) return;
    setSubmitting(true); setSubmitError('');
    try {
      const r = await api<{ appointment: Appointment; managementPath?: string }>('/public/bookings', { body: { serviceId: service.id, startAt: slot.startAt, name: form.name, email: form.email, phone: form.phone, notes: form.notes } });
      setDone(r);
    } catch (e) {
      setSubmitError(errMsg(e));
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') { setSlot(null); setStep(1); slots.reload(); }
    } finally { setSubmitting(false); }
  }

  if (!b) return <Spinner />;
  if (done) {
    const a = done.appointment;
    return (
      <div className="wrap section narrow">
        <div className="pole pole-move" aria-hidden style={{ marginBottom: '2rem' }} />
        <h1 style={{ fontSize: 'clamp(2rem,6vw,3.5rem)' }}>Request received</h1>
        <p className="muted">Your reference</p><div className="ref" aria-label={`Reference ${a.reference}`}>{a.reference}</div>
        <div className="panel" style={{ margin: '1.5rem 0' }}>
          <dl className="summary-list"><dt>Status</dt><dd>Pending approval</dd><dt>Service</dt><dd>{a.service.name}</dd><dt>When</dt><dd>{dateLabel(a.localDate)} at {time12(a.localTime)}</dd><dt>Price</dt><dd>{money(a.service.price, a.currency)} — pay at the shop</dd></dl>
        </div>
        <p>The shop will review your request and approve it. {user ? 'We’ll notify you in your account.' : `We’ve emailed a private link to ${a.customer.email}.`}</p>
        {done.managementPath && <div className="alert alert-info"><strong>Save your private booking link.</strong> It’s the only way to view or cancel this booking without an account; keep it to yourself.<div className="row" style={{ marginTop: '.6rem' }}><Link className="btn btn-primary btn-sm" to={done.managementPath}>Open my booking</Link></div>
          <p className="small" style={{ marginBottom: 0, marginTop: '.6rem' }}>Want everything in one place? <Link to="/register">Create an account</Link>, then use “Add a booking” with this link to attach it.</p></div>}
        <div className="row">{user ? <Link to="/account/appointments" className="btn btn-ghost">My appointments</Link> : null}<Link to="/" className="btn btn-ghost">Back to home</Link></div>
      </div>
    );
  }

  return (
    <div className="wrap section" style={{ paddingTop: '2rem' }}>
      <h1 style={{ fontSize: 'clamp(2rem,5vw,3.2rem)' }}>Book an appointment</h1>
      <ol className="steps" aria-label="Progress">{STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''} aria-current={i === step ? 'step' : undefined}>{s}</li>)}</ol>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr)', maxWidth: 820 }}>
        {step === 0 && (
          <section aria-labelledby="s0"><h2 id="s0" style={{ fontSize: '1.6rem' }}>Choose a service</h2>
            {services.loading ? <Spinner /> : services.error ? <ErrorBox message={services.error} retry={services.reload} /> : services.data!.items.length === 0 ? <Empty title="Booking is unavailable">There are no services to book right now.</Empty> : (
              <div className="choice-list">{services.data!.items.map((s) => (
                <button key={s.id} className="choice" aria-pressed={service?.id === s.id} onClick={() => { setService(s); setSlot(null); setDate(null); setStep(1); }}>
                  <span className="grow"><strong>{s.name}</strong><br /><span className="muted small">{s.description}</span></span>
                  <span style={{ textAlign: 'right' }}><span className="price">{money(s.price, currency)}</span><br /><span className="muted small">{duration(s.durationMinutes)}</span></span>
                </button>))}</div>)}
          </section>
        )}
        {step === 1 && service && (
          <section aria-labelledby="s1"><h2 id="s1" style={{ fontSize: '1.6rem' }}>Pick a date and time</h2>
            <p className="muted">{service.name} · {duration(service.durationMinutes)} · times shown in {b.timezone.replace('_', ' ')}</p>
            <DatePicker serviceId={service.id} value={date} onChange={(d) => { setDate(d); setSlot(null); }} timezone={b.timezone} />
            {date && (
              <div style={{ marginTop: '1.5rem' }}>
                <h3>{dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                {slots.loading ? <Spinner /> : slots.error ? <ErrorBox message={slots.error} retry={slots.reload} /> : freeSlots.length === 0 ? <Empty title="No free times that day">Try another date.</Empty> : (
                  <div className="slots" role="group" aria-label="Available times">{slots.data!.slots.map((s) => <button key={s.startAt} className="slot" disabled={!s.available} aria-pressed={slot?.startAt === s.startAt} onClick={() => setSlot(s)}>{time12(s.time)}</button>)}</div>)}
              </div>)}
            {submitError && <div className="alert alert-error" role="alert" style={{ marginTop: '1rem' }}>{submitError}</div>}
            <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} nextDisabled={!slot} />
          </section>
        )}
        {step === 2 && (
          <section aria-labelledby="s2"><h2 id="s2" style={{ fontSize: '1.6rem' }}>Your details</h2>
            {user ? <div className="alert alert-info">Booking as <strong>{user.fullName}</strong> ({user.email}). Add a phone number if you’d like WhatsApp updates.</div> : <p className="muted">No account needed. <Link to="/login" state={{ from: '/book' }}>Sign in</Link> instead if you have one.</p>}
            <form noValidate onSubmit={(e) => { e.preventDefault(); if (validate()) setStep(3); }}>
              <Field id="name" label="Full name" autoComplete="name" value={form.name} error={errors.name} readOnly={!!user} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Field id="email" label="Email" type="email" autoComplete="email" value={form.email} error={errors.email} readOnly={!!user} hint="We email your private booking link here." onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <Field id="phone" label="Phone (optional)" type="tel" autoComplete="tel" value={form.phone} error={errors.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <TextField id="notes" label="Notes for the barber (optional)" maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              <Nav onBack={() => setStep(1)} submit nextLabel="Review booking" />
            </form>
          </section>
        )}
        {step === 3 && service && slot && date && (
          <section aria-labelledby="s3"><h2 id="s3" style={{ fontSize: '1.6rem' }}>Review and submit</h2>
            <div className="panel"><dl className="summary-list">
              <dt>Service</dt><dd>{service.name}</dd><dt>When</dt><dd>{dateLabel(date)} at {time12(slot.time)} ({duration(service.durationMinutes)})</dd>
              <dt>Price</dt><dd>{money(service.price, currency)} — pay at the shop</dd><dt>Name</dt><dd>{form.name}</dd><dt>Email</dt><dd>{form.email}</dd>
              {form.phone && <><dt>Phone</dt><dd>{form.phone}</dd></>}{form.notes && <><dt>Notes</dt><dd>{form.notes}</dd></>}
            </dl></div>
            <p className="hint" style={{ marginTop: '.8rem' }}>Your time isn’t reserved until you submit. The shop approves each request. {b.cancellationPolicyText}</p>
            {submitError && <div className="alert alert-error" role="alert">{submitError}</div>}
            <Nav onBack={() => setStep(2)} onNext={submit} nextLabel={submitting ? 'Submitting…' : 'Submit booking request'} nextDisabled={submitting} />
          </section>
        )}
      </div>
    </div>
  );
}

function Nav({ onBack, onNext, nextDisabled, nextLabel = 'Continue', submit }: { onBack: () => void; onNext?: () => void; nextDisabled?: boolean; nextLabel?: string; submit?: boolean }) {
  return (
    <div className="row between" style={{ marginTop: '1.5rem' }}>
      <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
      <button type={submit ? 'submit' : 'button'} className="btn btn-primary" disabled={nextDisabled} onClick={submit ? undefined : onNext}>{nextLabel}</button>
    </div>
  );
}
