import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { HoursTable, ServiceCard } from '../components/shared';
import { Empty, ErrorBox, Spinner, Stars, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { relTime } from '../lib/format';
import { useSettings } from '../lib/settings';
import type { Faq, GalleryImage, Review, Service } from '../lib/types';

function useCurrency() { return useSettings().settings?.business.currency ?? 'NGN'; }

export function Home() {
  const { settings } = useSettings();
  const b = settings?.business;
  const services = useLoad(() => api<{ items: Service[] }>('/public/services', { query: { featured: 1 } }), []);
  const gallery = useLoad(() => api<{ items: GalleryImage[] }>('/public/gallery', { query: { limit: 6 } }), []);
  const reviews = useLoad(() => api<{ items: Pick<Review, 'id' | 'authorName' | 'rating' | 'comment' | 'createdAt'>[]; average: number | null; count: number }>('/public/reviews', { query: { limit: 3 } }), []);
  const faqs = useLoad(() => api<{ items: Faq[] }>('/public/faqs'), []);
  const currency = useCurrency();
  if (!b) return <Spinner />;
  return (
    <>
      <section className="hero">
        {b.heroImageUrl && <div className="hero-bg" style={{ backgroundImage: `url(${b.heroImageUrl})` }} />}
        <div className="hero-pole" aria-hidden />
        <div className="wrap">
          <h1>{b.name}</h1>
          <p className="lead">{b.description}</p>
          <div className="actions">
            <Link to="/book" className="btn btn-primary">Book an appointment</Link>
            {b.whatsappLink && <a className="btn btn-ghost" href={b.whatsappLink} target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a>}
          </div>
          <div className="hero-facts">
            <span><strong>Pay at the shop</strong>No online payment needed</span>
            <span><strong>{b.address}</strong>Find us</span>
            {reviews.data && reviews.data.count > 0 && <span><strong><Stars n={Math.round(reviews.data.average ?? 5)} /> {reviews.data.average}</strong>from {reviews.data.count} reviews</span>}
          </div>
        </div>
      </section>
      <div className="wrap"><div className="pole pole-thin" aria-hidden /></div>

      <section className="section wrap">
        <div className="section-head"><h2>Services</h2><Link to="/services">See all services</Link></div>
        {services.loading ? <Spinner /> : services.error ? <ErrorBox message={services.error} retry={services.reload} /> : services.data!.items.length === 0 ? <Empty title="No services yet">Check back soon.</Empty> : (
          <div className="services-grid">{services.data!.items.map((s) => <ServiceCard key={s.id} s={s} currency={currency} />)}</div>
        )}
      </section>

      {gallery.data && gallery.data.items.length > 0 && (
        <section className="section wrap" style={{ paddingTop: 0 }}>
          <div className="section-head"><h2>Recent work</h2><Link to="/gallery">Open gallery</Link></div>
          <div className="gallery-grid" style={{ columns: '3 200px' }}>{gallery.data.items.slice(0, 6).map((g) => <img key={g.id} src={g.url} alt={g.caption || 'Haircut by our barbers'} loading="lazy" style={{ marginBottom: '.75rem', borderRadius: 6 }} />)}</div>
        </section>
      )}

      {reviews.data && reviews.data.items.length > 0 && (
        <section className="section wrap" style={{ paddingTop: 0 }}>
          <div className="section-head"><h2>What customers say</h2><Link to="/reviews">All reviews</Link></div>
          <div className="reviews-grid">{reviews.data.items.map((r) => <ReviewCard key={r.id} r={r} />)}</div>
        </section>
      )}

      <section className="section wrap" style={{ paddingTop: 0 }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: '2rem' }}>
          <div className="panel"><h3>Opening hours</h3><HoursTable /></div>
          <div className="panel"><h3>Find us</h3><p>{b.address}</p><p className="muted">{b.phone}<br />{b.email}</p>
            <div className="row"><Link to="/contact" className="btn btn-ghost btn-sm">Contact details</Link>{b.whatsappLink && <a className="btn btn-ghost btn-sm" href={b.whatsappLink} target="_blank" rel="noopener noreferrer">WhatsApp</a>}</div></div>
        </div>
      </section>

      {faqs.data && faqs.data.items.length > 0 && (
        <section className="section wrap narrow" style={{ paddingTop: 0 }}>
          <div className="section-head"><h2>Questions</h2><Link to="/faq">More answers</Link></div>
          <FaqList items={faqs.data.items.slice(0, 4)} />
        </section>
      )}
    </>
  );
}

export const ReviewCard = ({ r }: { r: { authorName: string; rating: number; comment: string; createdAt: string } }) => (
  <figure className="review" style={{ margin: 0 }}><Stars n={r.rating} /><blockquote>“{r.comment}”</blockquote><figcaption className="muted small">{r.authorName} · {relTime(r.createdAt)}</figcaption></figure>
);

export const FaqList = ({ items }: { items: Faq[] }) => (
  <div className="faq">{items.map((f) => <details key={f.id}><summary>{f.question}</summary><p>{f.answer}</p></details>)}</div>
);

export function ServicesPage() {
  const currency = useCurrency();
  const { data, error, loading, reload } = useLoad(() => api<{ items: Service[] }>('/public/services'), []);
  return (
    <div className="wrap section" style={{ paddingTop: 0 }}>
      <div className="page-head"><h1>Services</h1><p>Prices are in {currency}. You pay at the shop after your service.</p></div>
      {loading ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No services available right now">Please check back soon.</Empty> :
        <div className="services-grid">{data!.items.map((s) => <ServiceCard key={s.id} s={s} currency={currency} />)}</div>}
    </div>
  );
}

export function GalleryPage() {
  const { data, error, loading, reload } = useLoad(() => api<{ items: GalleryImage[] }>('/public/gallery'), []);
  const [open, setOpen] = useState<GalleryImage | null>(null);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [open]);
  return (
    <div className="wrap section" style={{ paddingTop: 0 }}>
      <div className="page-head"><h1>Gallery</h1><p>A look at recent cuts, fades and beard work.</p></div>
      {loading ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No photos yet">We’re adding new work soon.</Empty> : (
        <div className="gallery-grid">{data!.items.map((g) => <button key={g.id} onClick={() => setOpen(g)} aria-label={`View photo${g.caption ? `: ${g.caption}` : ''}`}><img src={g.url} alt={g.caption || 'Haircut by our barbers'} loading="lazy" /></button>)}</div>
      )}
      {open && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer" onClick={() => setOpen(null)}>
          <button className="btn btn-ghost x" onClick={() => setOpen(null)} autoFocus>Close</button>
          <div onClick={(e) => e.stopPropagation()}><img src={open.url} alt={open.caption || 'Haircut'} />{open.caption && <p className="cap">{open.caption}</p>}</div>
        </div>
      )}
    </div>
  );
}

export function ReviewsPage() {
  const { data, error, loading, reload } = useLoad(() => api<{ items: any[]; average: number | null; count: number }>('/public/reviews', { query: { limit: 50 } }), []);
  return (
    <div className="wrap section" style={{ paddingTop: 0 }}>
      <div className="page-head"><h1>Customer reviews</h1>{data && data.count > 0 && <p><Stars n={Math.round(data.average ?? 0)} /> {data.average} average from {data.count} review{data.count === 1 ? '' : 's'}</p>}</div>
      {loading ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No reviews yet">Visited us recently? <Link to="/account/appointments">Leave a review from your account</Link> once your appointment is complete.</Empty> :
        <div className="reviews-grid">{data!.items.map((r) => <ReviewCard key={r.id} r={r} />)}</div>}
    </div>
  );
}

export function AboutPage() {
  const b = useSettings().settings?.business;
  if (!b) return <Spinner />;
  return (
    <div className="wrap section narrow" style={{ paddingTop: 0 }}>
      <div className="page-head"><h1>About {b.name}</h1></div>
      {b.aboutText.split(/\n{2,}/).map((p, i) => <p key={i} style={{ fontSize: '1.1rem' }}>{p}</p>)}
      <div className="pole" aria-hidden style={{ margin: '2rem 0' }} />
      <h3>Booking and cancellation</h3><p className="muted">{b.bookingPolicyText}</p><p className="muted">{b.cancellationPolicyText}</p>
      <Link to="/book" className="btn btn-primary">Book an appointment</Link>
    </div>
  );
}

export function FaqPage() {
  const { data, error, loading, reload } = useLoad(() => api<{ items: Faq[] }>('/public/faqs'), []);
  return (
    <div className="wrap section narrow" style={{ paddingTop: 0 }}>
      <div className="page-head"><h1>Frequently asked questions</h1></div>
      {loading ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No questions yet" /> : <FaqList items={data!.items} />}
      <p className="muted" style={{ marginTop: '2rem' }}>Still unsure? <Link to="/contact">Get in touch</Link>.</p>
    </div>
  );
}

export function ContactPage() {
  const b = useSettings().settings?.business;
  if (!b) return <Spinner />;
  return (
    <div className="wrap section" style={{ paddingTop: 0 }}>
      <div className="page-head"><h1>Contact</h1><p>Message us on WhatsApp for quick questions, or book online any time.</p></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: '1.5rem' }}>
        <div className="panel stack">
          <h3>Details</h3>
          <dl className="kv"><dt>Address</dt><dd>{b.address}</dd><dt>Phone</dt><dd><a href={`tel:${b.phone.replace(/\s/g, '')}`}>{b.phone}</a></dd><dt>Email</dt><dd><a href={`mailto:${b.email}`}>{b.email}</a></dd></dl>
          <div className="row">{b.whatsappLink && <a className="btn btn-primary" href={b.whatsappLink} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}<Link to="/book" className="btn btn-ghost">Book online</Link></div>
          <p className="hint">WhatsApp opens with a message ready to send. Nothing is sent until you press send in WhatsApp.</p>
        </div>
        <div className="panel"><h3>Opening hours</h3><HoursTable /><ClosuresNote /></div>
      </div>
    </div>
  );
}

function ClosuresNote() {
  const { settings } = useSettings();
  const c = settings?.closures ?? [];
  if (!c.length) return null;
  return <div className="alert alert-info" style={{ marginTop: '1rem' }}><strong>Upcoming closures</strong><ul style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>{c.map((x) => <li key={x.id}>{x.startDate === x.endDate ? x.startDate : `${x.startDate} to ${x.endDate}`}{x.reason ? ` — ${x.reason}` : ''}</li>)}</ul></div>;
}

void ((_: FormEvent) => {});
