import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChatThread } from '../../components/Chat';
import { PageTitle } from '../../components/layouts';
import { NotificationList } from '../../components/NotificationList';
import { Badge, ConfirmDialog, Empty, ErrorBox, Field, Modal, Pager, SelectField, Spinner, Stars, TextField, useDebounced, useLoad } from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { useAdminAuth } from '../../lib/auth';
import { DAYS, dateLabel, duration, money, relTime, time12 } from '../../lib/format';
import { useSettings } from '../../lib/settings';
import { useSocket } from '../../lib/socket';
import { useToast } from '../../lib/toast';
import type { Appointment, Closure, Conversation, DaySchedule, Faq, GalleryImage, Paged, Review, Service, User } from '../../lib/types';

/* ---------------- Services ---------------- */
export function ServicesAdmin() {
  const { user } = useAdminAuth();
  const isAdmin = user!.role === 'admin';
  const { settings } = useSettings();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api<{ items: Service[] }>('/admin/services'), []);
  const [edit, setEdit] = useState<Service | 'new' | null>(null);
  const [del, setDel] = useState<Service | null>(null);
  const currency = settings?.business.currency ?? 'NGN';
  async function move(i: number, dir: -1 | 1) {
    const ids = data!.items.map((s) => s.id); const j = i + dir; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try { await api('/admin/services/reorder', { body: { ids } }); reload(); } catch (e) { toast('error', errMsg(e)); }
  }
  async function patch(s: Service, body: object) { try { await api(`/admin/services/${s.id}`, { method: 'PATCH', body }); reload(); } catch (e) { toast('error', errMsg(e)); } }
  return (
    <>
      <PageTitle actions={isAdmin && <button className="btn btn-primary" onClick={() => setEdit('new')}>Add service</button>}>Services</PageTitle>
      {!isAdmin && <div className="alert alert-info">Only the shop owner can change services.</div>}
      <div className="panel panel-flush">{loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No services yet">Add your first service so customers can book.</Empty> : (
        <div className="table-wrap"><table className="stack-table"><thead><tr><th>Service</th><th>Price</th><th>Duration</th><th>Visible</th><th>Featured</th>{isAdmin && <th>Actions</th>}</tr></thead>
          <tbody>{data!.items.map((s, i) => (
            <tr key={s.id}>
              <td data-label="Service"><strong>{s.name}</strong><div className="muted small">{s.description.slice(0, 80)}</div></td>
              <td data-label="Price">{money(s.price, currency)}</td><td data-label="Duration">{duration(s.durationMinutes)}</td>
              <td data-label="Visible"><label className="check"><input type="checkbox" checked={s.isActive} disabled={!isAdmin} onChange={(e) => patch(s, { isActive: e.target.checked })} />{s.isActive ? 'Bookable' : 'Hidden'}</label></td>
              <td data-label="Featured"><input type="checkbox" aria-label={`Feature ${s.name}`} checked={s.isFeatured} disabled={!isAdmin} onChange={(e) => patch(s, { isFeatured: e.target.checked })} /></td>
              {isAdmin && <td className="nowrap"><button className="btn btn-ghost btn-sm" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button> <button className="btn btn-ghost btn-sm" aria-label={`Move ${s.name} down`} disabled={i === data!.items.length - 1} onClick={() => move(i, 1)}>↓</button> <button className="btn btn-ghost btn-sm" onClick={() => setEdit(s)}>Edit</button> <button className="btn btn-danger btn-sm" onClick={() => setDel(s)}>Remove</button></td>}
            </tr>))}</tbody></table></div>)}</div>
      <p className="hint">Existing bookings keep the name, price and length they were made with, so edits and removals never change history.</p>
      {edit && <ServiceForm svc={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={reload} />}
      {del && <ConfirmDialog title={`Remove ${del.name}?`} message="It will disappear from the website and can no longer be booked. Past and upcoming bookings are kept." confirmLabel="Remove service" danger onClose={() => setDel(null)} onConfirm={async () => { await api(`/admin/services/${del.id}`, { method: 'DELETE' }); toast('ok', 'Service removed'); reload(); }} />}
    </>
  );
}

function ImageUpload({ kind, value, onChange }: { kind: 'service' | 'gallery' | 'logo' | 'hero'; value: string | null; onChange: (url: string | null, storagePath?: string) => void }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const ref = useRef<HTMLInputElement>(null);
  async function pick(file?: File) {
    if (!file) return; setBusy(true); setErr('');
    try { const fd = new FormData(); fd.append('kind', kind); fd.append('file', file); const r = await api<{ url: string; storagePath: string }>('/admin/uploads', { form: fd }); onChange(r.url, r.storagePath); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  }
  return (
    <div className="upload-tile">
      {value && <img className="thumb" src={value} alt="Current image" style={{ maxWidth: 220 }} />}
      <div className="row"><input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" aria-label={`Upload ${kind} image`} onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />{value && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Remove</button>}</div>
      <span className="hint">{busy ? 'Uploading…' : 'JPEG, PNG or WebP up to 5 MB.'}</span>{err && <span className="err">{err}</span>}
    </div>
  );
}

function ServiceForm({ svc, onClose, onDone }: { svc: Service | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: svc?.name ?? '', description: svc?.description ?? '', price: String(svc?.price ?? ''), durationMinutes: String(svc?.durationMinutes ?? 30), imageUrl: svc?.imageUrl ?? null as string | null, isActive: svc?.isActive ?? true, isFeatured: svc?.isFeatured ?? false });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    const body = { ...f, price: Number(f.price), durationMinutes: Number(f.durationMinutes) };
    try { await api(svc ? `/admin/services/${svc.id}` : '/admin/services', { method: svc ? 'PATCH' : 'POST', body }); toast('ok', svc ? 'Service saved' : 'Service added'); onDone(); onClose(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <Modal title={svc ? `Edit ${svc.name}` : 'Add a service'} onClose={onClose}>
      <form onSubmit={submit}>{err && <div className="alert alert-error" role="alert">{err}</div>}
        <Field id="sn" label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <TextField id="sd" label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="row"><div className="grow"><Field id="sp" label="Price" type="number" min={0} step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></div><div className="grow"><Field id="sm" label="Duration (minutes)" type="number" min={5} max={480} step={5} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value })} required /></div></div>
        <div className="field"><span className="label">Photo (optional)</span><ImageUpload kind="service" value={f.imageUrl} onChange={(u) => setF({ ...f, imageUrl: u })} /></div>
        <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Available to book</label>
        <label className="check" style={{ margin: '.6rem 0' }}><input type="checkbox" checked={f.isFeatured} onChange={(e) => setF({ ...f, isFeatured: e.target.checked })} /> Show on the home page</label>
        <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save service'}</button></div>
      </form>
    </Modal>
  );
}

/* ---------------- Customers ---------------- */
export function CustomersAdmin() {
  const nav = useNavigate();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useLoad(() => api<Paged<any>>('/admin/customers', { query: { q: dq, status, page, pageSize: 20 } }), [dq, status, page]);
  return (
    <>
      <PageTitle>Customers</PageTitle>
      <div className="filters"><div className="field"><label htmlFor="cq">Search</label><input id="cq" type="search" placeholder="Name, email or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        <SelectField id="cs" label="Account status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option></SelectField></div>
      <div className="panel panel-flush">{loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No customers found" /> : (
        <div className="table-wrap"><table className="stack-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Bookings</th><th>Joined</th><th>Status</th></tr></thead>
          <tbody>{data!.items.map((c) => <tr key={c.id} className="click" onClick={() => nav(`/admin/customers/${c.id}`)}><td data-label="Name"><Link to={`/admin/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.fullName}</Link></td><td data-label="Email">{c.email}</td><td data-label="Phone">{c.phone ?? '—'}</td><td data-label="Bookings">{c.appointmentCount}</td><td data-label="Joined">{new Date(c.createdAt).toLocaleDateString('en-GB')}</td><td data-label="Status">{c.status === 'active' ? 'Active' : <Badge status="cancelled" />}</td></tr>)}</tbody></table></div>)}
        {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}</div>
    </>
  );
}

export function CustomerDetail() {
  const { id } = useParams(); const toast = useToast(); const { user } = useAdminAuth();
  const { data, loading, error, reload } = useLoad(() => api<{ customer: User; stats: any; appointments: Appointment[]; conversationId: string | null; whatsappLink: string | null }>(`/admin/customers/${id}`), [id]);
  const [susp, setSusp] = useState(false);
  const nav = useNavigate();
  if (loading) return <Spinner />;
  if (error || !data) return <><PageTitle>Customer</PageTitle><ErrorBox message={error ?? 'Not found'} /></>;
  const c = data.customer; const s = data.stats;
  async function openChat() { try { const r = await api<{ conversation: Conversation }>('/admin/chat/conversations', { body: { customerId: c.id } }); nav(`/admin/messages?c=${r.conversation.id}`); } catch (e) { toast('error', errMsg(e)); } }
  return (
    <>
      <PageTitle actions={<><button className="btn btn-ghost btn-sm" onClick={openChat}>Open conversation</button>{data.whatsappLink && <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href={data.whatsappLink}>WhatsApp</a>}</>}>{c.fullName}</PageTitle>
      <div className="two-col">
        <div className="stack">
          <div className="panel"><h3>Bookings</h3><div className="row" style={{ marginBottom: '1rem' }}>{[['Total', s.total], ['Pending', s.pending], ['Approved', s.approved], ['Completed', s.completed], ['Cancelled', s.cancelled], ['Rejected', s.rejected]].map(([l, n]) => <span key={l as string} className="badge"><span>{n}</span> {l}</span>)}</div>
            {data.appointments.length === 0 ? <Empty title="No bookings yet" /> : <div className="table-wrap"><table className="stack-table"><tbody>{data.appointments.map((a) => <tr key={a.id} className="click" onClick={() => nav(`/admin/appointments/${a.id}`)}><td><Link to={`/admin/appointments/${a.id}`}>{dateLabel(a.localDate)} {time12(a.localTime)}</Link></td><td>{a.service.name}</td><td><Badge status={a.status} /></td></tr>)}</tbody></table></div>}</div>
        </div>
        <div className="panel"><h3>Details</h3><dl className="kv"><dt>Email</dt><dd><a href={`mailto:${c.email}`}>{c.email}</a></dd><dt>Phone</dt><dd>{c.phone ?? '—'}</dd><dt>Joined</dt><dd>{new Date(c.createdAt).toLocaleDateString('en-GB')}</dd><dt>Account</dt><dd>{c.status === 'active' ? 'Active' : 'Suspended'}</dd></dl>
          {user!.role === 'admin' && <button className={`btn ${c.status === 'active' ? 'btn-danger' : 'btn-primary'}`} style={{ marginTop: '1rem' }} onClick={() => setSusp(true)}>{c.status === 'active' ? 'Suspend account' : 'Reactivate account'}</button>}</div>
      </div>
      {susp && <ConfirmDialog title={c.status === 'active' ? 'Suspend this account?' : 'Reactivate this account?'} message={c.status === 'active' ? 'They will be signed out and unable to sign in. Their history is kept.' : 'They will be able to sign in again.'} confirmLabel={c.status === 'active' ? 'Suspend' : 'Reactivate'} danger={c.status === 'active'} onClose={() => setSusp(false)} onConfirm={async () => { await api(`/admin/customers/${c.id}/status`, { method: 'PATCH', body: { status: c.status === 'active' ? 'suspended' : 'active' } }); toast('ok', 'Account updated'); reload(); }} />}
    </>
  );
}

/* ---------------- Reviews ---------------- */
export function ReviewsAdmin() {
  const { user } = useAdminAuth(); const toast = useToast();
  const [sp, setSp] = useSearchParams(); const status = sp.get('status') ?? 'pending'; const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useLoad(() => api<Paged<Review>>('/admin/reviews', { query: { status, page, pageSize: 20 } }), [status, page]);
  const [open, setOpen] = useState<Review | null>(null);
  const isAdmin = user!.role === 'admin';
  async function set(r: Review, to: string) { try { await api(`/admin/reviews/${r.id}/status`, { body: { status: to } }); toast('ok', `Review ${to}`); setOpen(null); window.dispatchEvent(new Event('admin:changed')); reload(); } catch (e) { toast('error', errMsg(e)); } }
  return (
    <>
      <PageTitle>Reviews</PageTitle>
      <div className="seg" style={{ marginBottom: '1rem' }} role="group" aria-label="Review status">{['pending', 'approved', 'rejected', 'hidden'].map((s) => <button key={s} aria-pressed={status === s} onClick={() => { setSp({ status: s }); setPage(1); }}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}</div>
      {!isAdmin && <div className="alert alert-info">Only the shop owner can approve or hide reviews.</div>}
      <div className="panel panel-flush">{loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title={`No ${status} reviews`} /> : data!.items.map((r) => (
        <div className="note" key={r.id}><div className="body"><button className="open" onClick={() => setOpen(r)}><Stars n={r.rating} /> <strong style={{ display: 'inline' }}>{r.authorName}</strong><span className="muted small"> · {relTime(r.createdAt)}</span><br /><span>{r.comment.length > 160 ? `${r.comment.slice(0, 160)}…` : r.comment}</span></button></div></div>))}
        {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}</div>
      {open && <Modal title="Review" onClose={() => setOpen(null)}><p><Stars n={open.rating} /> <strong>{open.authorName}</strong></p><p>{open.comment}</p><p className="muted small">Submitted {new Date(open.createdAt).toLocaleString('en-GB')} · <Link to={`/admin/appointments/${open.appointmentId}`}>View appointment</Link></p>
        <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setOpen(null)}>Close</button>
          {isAdmin && open.status !== 'approved' && <button className="btn btn-primary" onClick={() => set(open, 'approved')}>{open.status === 'pending' ? 'Approve and publish' : 'Restore and publish'}</button>}
          {isAdmin && open.status === 'pending' && <button className="btn btn-danger" onClick={() => set(open, 'rejected')}>Reject</button>}
          {isAdmin && open.status === 'approved' && <button className="btn btn-danger" onClick={() => set(open, 'hidden')}>Hide from website</button>}</div></Modal>}
    </>
  );
}

/* ---------------- Gallery & FAQs ---------------- */
export function GalleryAdmin() {
  const { user } = useAdminAuth(); const toast = useToast(); const isAdmin = user!.role === 'admin';
  const { data, loading, error, reload } = useLoad(() => api<{ items: GalleryImage[] }>('/admin/gallery'), []);
  const [del, setDel] = useState<GalleryImage | null>(null);
  async function add(url: string | null, storagePath?: string) { if (!url) return; try { await api('/admin/gallery', { body: { url, storagePath } }); toast('ok', 'Photo added'); reload(); } catch (e) { toast('error', errMsg(e)); } }
  async function move(i: number, dir: -1 | 1) { const ids = data!.items.map((g) => g.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; await api('/admin/gallery/reorder', { body: { ids } }).catch(() => {}); reload(); }
  async function patch(g: GalleryImage, body: object) { try { await api(`/admin/gallery/${g.id}`, { method: 'PATCH', body }); reload(); } catch (e) { toast('error', errMsg(e)); } }
  return (
    <>
      <PageTitle>Gallery</PageTitle>
      {isAdmin && <div className="panel" style={{ marginBottom: '1rem' }}><h3>Add a photo</h3><ImageUpload kind="gallery" value={null} onChange={add} /></div>}
      {loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <div className="panel"><Empty title="No photos yet">Upload your best cuts to show them on the website.</Empty></div> : (
        <div className="gal-admin">{data!.items.map((g, i) => (
          <div className="panel stack" key={g.id}><img className="thumb" src={g.url} alt={g.caption || 'Gallery photo'} />
            <CaptionField g={g} disabled={!isAdmin} onSave={(c) => patch(g, { caption: c })} />
            {isAdmin && <div className="row"><label className="check"><input type="checkbox" checked={g.isActive} onChange={(e) => patch(g, { isActive: e.target.checked })} /> Shown</label><button className="btn btn-ghost btn-sm" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>←</button><button className="btn btn-ghost btn-sm" aria-label="Move later" disabled={i === data!.items.length - 1} onClick={() => move(i, 1)}>→</button><button className="btn btn-danger btn-sm" onClick={() => setDel(g)}>Delete</button></div>}</div>))}</div>)}
      {del && <ConfirmDialog title="Delete this photo?" message="It will be removed from the website and from storage." confirmLabel="Delete photo" danger onClose={() => setDel(null)} onConfirm={async () => { await api(`/admin/gallery/${del.id}`, { method: 'DELETE' }); toast('ok', 'Photo deleted'); reload(); }} />}
    </>
  );
}
function CaptionField({ g, onSave, disabled }: { g: GalleryImage; onSave: (c: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(g.caption); useEffect(() => setV(g.caption), [g.caption]);
  return <input aria-label="Caption" placeholder="Caption (optional)" value={v} disabled={disabled} maxLength={200} onChange={(e) => setV(e.target.value)} onBlur={() => v !== g.caption && onSave(v)} />;
}

export function FaqsAdmin() {
  const { user } = useAdminAuth(); const toast = useToast(); const isAdmin = user!.role === 'admin';
  const { data, loading, error, reload } = useLoad(() => api<{ items: Faq[] }>('/admin/faqs'), []);
  const [edit, setEdit] = useState<Faq | 'new' | null>(null);
  return (
    <>
      <PageTitle actions={isAdmin && <button className="btn btn-primary" onClick={() => setEdit('new')}>Add question</button>}>FAQs</PageTitle>
      <div className="panel panel-flush">{loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title="No questions yet" /> : data!.items.map((f) => (
        <div className="note" key={f.id}><div className="body"><strong>{f.question}</strong><div className="muted">{f.answer}</div>{!f.isActive && <span className="badge badge-hidden">Hidden</span>}</div>{isAdmin && <div className="row"><button className="btn btn-ghost btn-sm" onClick={() => setEdit(f)}>Edit</button><button className="btn btn-danger btn-sm" onClick={async () => { if (confirm('Delete this question?')) { await api(`/admin/faqs/${f.id}`, { method: 'DELETE' }); toast('ok', 'Deleted'); reload(); } }}>Delete</button></div>}</div>))}</div>
      {edit && <FaqForm faq={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={reload} />}
    </>
  );
}
function FaqForm({ faq, onClose, onDone }: { faq: Faq | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ question: faq?.question ?? '', answer: faq?.answer ?? '', isActive: faq?.isActive ?? true }); const [err, setErr] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); try { await api(faq ? `/admin/faqs/${faq.id}` : '/admin/faqs', { method: faq ? 'PATCH' : 'POST', body: f }); onDone(); onClose(); } catch (x) { setErr(errMsg(x)); } }
  return <Modal title={faq ? 'Edit question' : 'Add a question'} onClose={onClose}><form onSubmit={submit}>{err && <div className="alert alert-error">{err}</div>}<Field id="fq" label="Question" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} required /><TextField id="fa" label="Answer" value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} required /><label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Show on website</label><div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></form></Modal>;
}

/* ---------------- Messages inbox ---------------- */
export function MessagesAdmin() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [unread, setUnread] = useState(sp.get('unread') === '1');
  const sel = sp.get('c');
  const { socket } = useSocket();
  const { data, loading, error, reload } = useLoad(() => api<Paged<Conversation>>('/admin/chat/conversations', { query: { q: dq, unread: unread ? 1 : undefined, pageSize: 50, all: sel ? 1 : undefined } }), [dq, unread, sel]);
  useEffect(() => { if (!socket) return; const r = () => reload(); socket.on('conversation:updated', r); return () => { socket.off('conversation:updated', r); }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);
  const current = data?.items.find((c) => c.id === sel);
  return (
    <>
      <PageTitle>Messages</PageTitle>
      <div className={`inbox ${sel ? 'open-thread' : ''}`}>
        <div>
          <div className="row" style={{ marginBottom: '.6rem' }}><input type="search" aria-label="Search conversations" placeholder="Search customers" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /><label className="check"><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />Unread</label></div>
          <div className="inbox-list">{loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title={unread ? 'No unread conversations' : 'No conversations yet'}>Customer messages will appear here.</Empty> : data!.items.map((c) => (
            <button key={c.id} className="conv" aria-current={c.id === sel} onClick={() => setSp({ c: c.id })}><span className="name"><span>{c.customer.fullName}</span>{c.unreadCount > 0 && <span className="count" aria-label={`${c.unreadCount} unread`}>{c.unreadCount}</span>}</span><span className="prev">{c.lastMessagePreview ?? 'No messages yet'}</span><span className="muted small">{c.lastMessageAt ? relTime(c.lastMessageAt) : ''}</span></button>))}</div>
        </div>
        <div className="inbox-thread">{sel ? <ChatThread key={sel} conversationId={sel} side="staff" title={current?.customer.fullName ?? 'Conversation'} onBack={() => setSp({})} /> : <div className="panel"><Empty title="Choose a conversation">Select a customer on the left to read and reply.</Empty></div>}
          {current && <p className="small" style={{ marginTop: '.6rem' }}><Link to={`/admin/customers/${current.customer.id}`}>View customer profile</Link></p>}</div>
      </div>
    </>
  );
}

export const NotificationsAdmin = () => (<><PageTitle>Notifications</PageTitle><NotificationList scope="admin" /></>);

/* ---------------- Settings ---------------- */
export function SettingsPage() {
  const toast = useToast(); const { reload: reloadPublic } = useSettings();
  const { data, loading, error, reload } = useLoad(() => api<{ business: any; openingHours: DaySchedule[]; closures: Closure[] }>('/admin/settings'), []);
  const [b, setB] = useState<any>(null); const [hours, setHours] = useState<DaySchedule[]>([]); const [tab, setTab] = useState('business');
  const [warn, setWarn] = useState('');
  useEffect(() => { if (data) { setB(data.business); setHours(data.openingHours); } }, [data]);
  if (loading && !data) return <Spinner />;
  if (error || !b) return <ErrorBox message={error ?? 'Failed'} retry={reload} />;
  const set = (k: string, v: any) => setB({ ...b, [k]: v });
  const num = (k: string, label: string, hint?: string, min = 0, max?: number) => <Field id={k} label={label} type="number" min={min} max={max} value={b[k]} hint={hint} onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))} />;
  const txt = (k: string, label: string, p: any = {}) => <Field id={k} label={label} value={b[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...p} />;
  async function saveBusiness(e: FormEvent) {
    e.preventDefault(); setWarn('');
    try { const { logoUrl, heroImageUrl, ...rest } = b; const r = await api<any>('/admin/settings', { method: 'PUT', body: { ...rest, logoUrl, heroImageUrl } }); toast('ok', 'Settings saved — changes are live'); if (r.warnings.affectedAppointments) setWarn(`${r.warnings.affectedAppointments} upcoming booking(s) exist. They are unchanged, but check they still suit your new rules.`); reload(); reloadPublic(); } catch (x) { toast('error', errMsg(x)); }
  }
  async function saveHours() { try { const r = await api<any>('/admin/settings/hours', { method: 'PUT', body: { days: hours } }); toast('ok', 'Opening hours saved'); if (r.warnings.affectedAppointments) setWarn(`${r.warnings.affectedAppointments} upcoming booking(s) exist. They are unchanged, so check they fall inside your new hours.`); reload(); reloadPublic(); } catch (x) { toast('error', errMsg(x)); } }
  const setDay = (i: number, patch: Partial<DaySchedule>) => setHours(hours.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  return (
    <>
      <PageTitle>Settings</PageTitle>
      <div className="seg" style={{ marginBottom: '1rem' }} role="group" aria-label="Settings section">{[['business', 'Business'], ['booking', 'Booking rules'], ['hours', 'Hours & closures'], ['notify', 'Notifications']].map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k!)}>{l}</button>)}</div>
      {warn && <div className="alert alert-info" role="status">{warn}</div>}
      {tab === 'hours' ? (
        <div className="stack"><div className="panel"><h3>Opening hours</h3><p className="hint">Times are in {b.timezone}. Changing hours never edits existing bookings.</p>
          {hours.map((h, i) => <div className="hours-row" key={h.dayOfWeek}><strong>{DAYS[h.dayOfWeek]}</strong><label className="check"><input type="checkbox" checked={h.isOpen} onChange={(e) => setDay(i, { isOpen: e.target.checked })} />Open</label>
            <div>{h.isOpen ? <><div className="times"><input type="time" aria-label={`${DAYS[h.dayOfWeek]} opens`} value={h.openTime} onChange={(e) => setDay(i, { openTime: e.target.value })} /> to <input type="time" aria-label={`${DAYS[h.dayOfWeek]} closes`} value={h.closeTime} onChange={(e) => setDay(i, { closeTime: e.target.value })} /></div>
              {h.breaks.map((br, k) => <div className="times" key={k} style={{ marginTop: '.4rem' }}><span className="muted small">Break</span><input type="time" aria-label="Break starts" value={br.startTime} onChange={(e) => setDay(i, { breaks: h.breaks.map((x, y) => (y === k ? { ...x, startTime: e.target.value } : x)) })} /> to <input type="time" aria-label="Break ends" value={br.endTime} onChange={(e) => setDay(i, { breaks: h.breaks.map((x, y) => (y === k ? { ...x, endTime: e.target.value } : x)) })} /><button className="btn btn-ghost btn-sm" onClick={() => setDay(i, { breaks: h.breaks.filter((_, y) => y !== k) })}>Remove</button></div>)}
              <button className="btn btn-ghost btn-sm" style={{ marginTop: '.5rem' }} onClick={() => setDay(i, { breaks: [...h.breaks, { startTime: '13:00', endTime: '14:00', label: 'Break' }] })}>Add a break</button></> : <span className="muted">Closed all day</span>}</div></div>)}
          <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={saveHours}>Save opening hours</button></div>
          <ClosuresPanel closures={data!.closures} onChange={(w) => { if (w) setWarn(`${w} upcoming booking(s) fall on those dates. They are not cancelled automatically — review and cancel them if needed.`); reload(); reloadPublic(); }} /></div>
      ) : (
        <form className="panel" onSubmit={saveBusiness}>
          {tab === 'business' && <>
            {txt('businessName', 'Business name')}{txt('tagline', 'Tagline')}
            <TextField id="description" label="Short description (home page)" value={b.description} onChange={(e) => set('description', e.target.value)} />
            <TextField id="aboutText" label="About text" hint="Separate paragraphs with a blank line." value={b.aboutText} onChange={(e) => set('aboutText', e.target.value)} />
            <div className="row" style={{ alignItems: 'flex-start' }}><div className="field grow"><span className="label">Logo</span><ImageUpload kind="logo" value={b.logoUrl} onChange={(u) => set('logoUrl', u)} /></div><div className="field grow"><span className="label">Home page hero image</span><ImageUpload kind="hero" value={b.heroImageUrl} onChange={(u) => set('heroImageUrl', u)} /></div></div>
            {txt('contactPhone', 'Phone')}{txt('whatsappNumber', 'WhatsApp number', { hint: 'Include the country code, e.g. +234 801 234 5678. Customers tap this to start a chat.' })}{txt('contactEmail', 'Contact email', { type: 'email' })}
            <TextField id="address" label="Address" value={b.address} onChange={(e) => set('address', e.target.value)} />
            <div className="row"><div className="grow">{txt('currency', 'Currency code', { hint: 'e.g. NGN, USD' })}</div><div className="grow">{txt('timezone', 'Timezone', { hint: 'e.g. Africa/Lagos' })}</div><div className="grow">{txt('defaultCountryCode', 'Default country code', { hint: 'For phone numbers without +, e.g. 234' })}</div></div></>}
          {tab === 'booking' && <>
            <div className="row" style={{ alignItems: 'flex-start' }}><div className="grow">{num('maxSimultaneous', 'Appointments at the same time', 'How many customers can be served at once (your number of chairs or barbers).', 1, 100)}</div><div className="grow">{num('slotIntervalMinutes', 'Time slot interval (minutes)', 'How far apart start times are.', 5, 240)}</div><div className="grow">{num('bufferMinutes', 'Buffer after each cut (minutes)', 'Cleaning or preparation time.', 0, 120)}</div></div>
            <div className="row" style={{ alignItems: 'flex-start' }}><div className="grow">{num('minNoticeMinutes', 'Minimum notice (minutes)', 'How soon before a slot customers can book.', 0)}</div><div className="grow">{num('maxAdvanceDays', 'Book up to (days ahead)', undefined, 1, 365)}</div><div className="grow">{num('cancellationDeadlineHours', 'Cancellation deadline (hours before)', 'Customers can’t cancel online after this.', 0, 720)}</div></div>
            {num('defaultServiceMinutes', 'Default service length (minutes)', 'Used as a starting point when adding services.', 5, 480)}
            <label className="check" style={{ margin: '.5rem 0 1rem' }}><input type="checkbox" checked={b.allowSameDay} onChange={(e) => set('allowSameDay', e.target.checked)} /> Allow same-day bookings</label>
            <TextField id="bookingPolicyText" label="Booking policy" value={b.bookingPolicyText} onChange={(e) => set('bookingPolicyText', e.target.value)} />
            <TextField id="cancellationPolicyText" label="Cancellation policy" value={b.cancellationPolicyText} onChange={(e) => set('cancellationPolicyText', e.target.value)} /></>}
          {tab === 'notify' && <><p className="muted">Choose which events create a notification for you and your staff.</p>
            {[['notifyAdminNewBooking', 'A customer submits a booking'], ['notifyAdminCancellation', 'A customer cancels a booking'], ['notifyAdminReview', 'A customer submits a review'], ['notifyAdminChat', 'A customer sends a message']].map(([k, l]) => <label className="check" key={k} style={{ marginBottom: '.7rem' }}><input type="checkbox" checked={b[k!]} onChange={(e) => set(k!, e.target.checked)} />{l}</label>)}
            {num('notificationRetentionDays', 'Keep read notifications for (days)', 'Older read notifications are deleted automatically. Bookings, messages and reviews are never deleted.', 7, 3650)}</>}
          <button className="btn btn-primary">Save settings</button>
        </form>)}
    </>
  );
}

function ClosuresPanel({ closures, onChange }: { closures: Closure[]; onChange: (affected?: number) => void }) {
  const toast = useToast(); const [f, setF] = useState({ startDate: '', endDate: '', kind: 'holiday', reason: '' });
  async function add(e: FormEvent) { e.preventDefault(); try { const r = await api<any>('/admin/settings/closures', { body: { ...f, endDate: f.endDate || f.startDate, reason: f.reason || undefined } }); toast('ok', 'Closure added'); setF({ startDate: '', endDate: '', kind: 'holiday', reason: '' }); onChange(r.warnings.affectedAppointments); } catch (x) { toast('error', errMsg(x)); } }
  return (
    <div className="panel"><h3>Holidays and closures</h3>
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={add}><div className="field"><label htmlFor="cs">From</label><input id="cs" type="date" value={f.startDate} required onChange={(e) => setF({ ...f, startDate: e.target.value })} /></div><div className="field"><label htmlFor="ce">To (optional)</label><input id="ce" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div><SelectField id="ck" label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="holiday">Holiday</option><option value="closure">Temporary closure</option></SelectField><div className="field grow"><label htmlFor="cr">Reason</label><input id="cr" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div><div className="field"><button className="btn btn-primary">Add</button></div></form>
      {closures.length === 0 ? <p className="muted">No closures scheduled.</p> : <ul style={{ listStyle: 'none', padding: 0 }}>{closures.map((c) => <li key={c.id} className="row between note"><span>{c.startDate === c.endDate ? dateLabel(c.startDate) : `${dateLabel(c.startDate)} → ${dateLabel(c.endDate)}`} <span className="muted">· {c.kind === 'holiday' ? 'Holiday' : 'Closure'}{c.reason ? ` · ${c.reason}` : ''}</span></span><button className="btn btn-danger btn-sm" onClick={async () => { await api(`/admin/settings/closures/${c.id}`, { method: 'DELETE' }); onChange(); }}>Remove</button></li>)}</ul>}</div>
  );
}

/* ---------------- System & profile ---------------- */
const mb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
export function SystemPage() {
  const toast = useToast();
  const usage = useLoad(() => api<any>('/admin/system/usage'), []);
  const [page, setPage] = useState(1);
  const audit = useLoad(() => api<Paged<any>>('/admin/audit', { query: { page } }), [page]);
  return (
    <>
      <PageTitle actions={<button className="btn btn-ghost" onClick={async () => { try { const r = await api<any>('/admin/system/cleanup', { body: {} }); toast('ok', `Cleaned ${r.oldNotifications} notifications, ${r.expiredResetTokens} reset tokens, ${r.expiredSessions} sessions`); usage.reload(); audit.reload(); } catch (e) { toast('error', errMsg(e)); } }}>Run cleanup now</button>}>System</PageTitle>
      <div className="two-col">
        <div className="panel"><h3>Database usage</h3>{usage.loading ? <Spinner /> : usage.error ? <ErrorBox message={usage.error} retry={usage.reload} /> : <>
          <p>Total size: <strong>{mb(usage.data.databaseSizeBytes)}</strong></p>
          <div className="table-wrap"><table><thead><tr><th>Table</th><th>Rows (est.)</th><th>Size</th></tr></thead><tbody>{usage.data.tables.map((t: any) => <tr key={t.name}><td>{t.name}</td><td>{t.rows}</td><td>{mb(t.sizeBytes)}</td></tr>)}</tbody></table></div>
          <p className="hint">The free Supabase plan includes 500 MB. If you approach it, upgrade the plan or export and archive old chat history. We never delete customers, bookings, reviews, chats or audit logs automatically.</p></>}</div>
        <div className="panel"><h3>Retention</h3><ul className="muted"><li>Read notifications: removed after {usage.data?.retention.notificationRetentionDays ?? '…'} days (change in Settings).</li><li>Password reset links: removed 1 day after they expire.</li><li>Customers, bookings, reviews, chats and the audit log: kept until you decide otherwise.</li></ul></div>
      </div>
      <div className="panel panel-flush" style={{ marginTop: '1.25rem' }}><h3 style={{ padding: '1rem 1.25rem 0' }}>Activity log</h3>
        {audit.loading && !audit.data ? <Spinner /> : audit.data && <><div className="table-wrap"><table className="stack-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th></tr></thead><tbody>{audit.data.items.map((l: any) => <tr key={l.id}><td className="nowrap" data-label="When">{new Date(l.createdAt).toLocaleString('en-GB')}</td><td data-label="Who">{l.actorName ?? '—'}</td><td data-label="Action">{l.action}</td><td data-label="Record" className="muted small">{l.entityType ?? ''} {l.entityId ?? ''}</td></tr>)}</tbody></table></div><Pager page={audit.data.page} pageSize={audit.data.pageSize} total={audit.data.total} onPage={setPage} /></>}</div>
    </>
  );
}

export function AdminProfile() {
  const { user, setUser } = useAdminAuth(); const toast = useToast();
  const [p, setP] = useState({ fullName: user!.fullName, phone: user!.phone ?? '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [err, setErr] = useState(''); const [pwErr, setPwErr] = useState('');
  return (
    <>
      <PageTitle>Profile</PageTitle>
      <div className="two-col" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <form className="panel" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const r = await api<{ user: User }>('/admin/profile', { method: 'PATCH', body: p }); setUser(r.user); toast('ok', 'Profile saved'); } catch (x) { setErr(errMsg(x)); } }}><h3>Your details</h3>{err && <div className="alert alert-error">{err}</div>}
          <Field id="afn" label="Full name" value={p.fullName} onChange={(e) => setP({ ...p, fullName: e.target.value })} required /><Field id="aem" label="Email" value={user!.email} readOnly /><Field id="aph" label="Phone" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /><button className="btn btn-primary">Save</button></form>
        <form className="panel" onSubmit={async (e) => { e.preventDefault(); setPwErr(''); try { await api('/admin/password', { body: pw }); setPw({ currentPassword: '', newPassword: '', confirmPassword: '' }); toast('ok', 'Password changed'); } catch (x) { setPwErr(errMsg(x)); } }}><h3>Change password</h3>{pwErr && <div className="alert alert-error">{pwErr}</div>}
          <Field id="acp" label="Current password" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /><Field id="anp" label="New password" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /><Field id="acn" label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirmPassword} onChange={(e) => setPw({ ...pw, confirmPassword: e.target.value })} required /><button className="btn btn-primary">Change password</button></form>
      </div>
    </>
  );
}
