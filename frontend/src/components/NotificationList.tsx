import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Pager, Spinner, useLoad } from './ui';
import { api } from '../lib/api';
import { relTime } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Notification, Paged } from '../lib/types';

/** Where a notification leads. Deleting a notification never touches the record it points to. */
function target(n: Notification, scope: 'customer' | 'admin') {
  if (!n.entityId) return null;
  if (n.entityType === 'appointment') return scope === 'admin' ? `/admin/appointments/${n.entityId}` : `/account/appointments/${n.entityId}`;
  if (n.entityType === 'conversation') return scope === 'admin' ? `/admin/messages?c=${n.entityId}` : '/account/messages';
  if (n.entityType === 'review') return scope === 'admin' ? `/admin/reviews?id=${n.entityId}` : '/account/appointments';
  return null;
}

export function NotificationList({ scope }: { scope: 'customer' | 'admin' }) {
  const base = scope === 'admin' ? '/admin/notifications' : '/notifications';
  const nav = useNavigate();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { data, loading, error, reload } = useLoad(() => api<Paged<Notification> & { unreadCount: number }>(base, { query: { page, pageSize: 20, unread: onlyUnread ? 1 : undefined } }), [page, onlyUnread, base]);
  const changed = () => { window.dispatchEvent(new Event('notifications:changed')); reload(); };

  async function open(n: Notification) {
    if (!n.read) { await api(`${base}/${n.id}/read`, { method: 'POST', body: {} }).catch(() => {}); window.dispatchEvent(new Event('notifications:changed')); }
    const t = target(n, scope); if (t) nav(t); else reload();
  }
  async function del(body: object, msg: string) { try { const r = await api<{ deleted: number }>(`${base}/delete`, { body }); toast('ok', `${msg} (${r.deleted})`); setSel(new Set()); changed(); } catch (e: any) { toast('error', e.message); } }

  return (
    <div>
      <div className="row between" style={{ marginBottom: '1rem' }}>
        <label className="check"><input type="checkbox" checked={onlyUnread} onChange={(e) => { setOnlyUnread(e.target.checked); setPage(1); }} /> Unread only</label>
        <div className="row">
          <button className="btn btn-ghost btn-sm" disabled={!data?.unreadCount} onClick={async () => { await api(`${base}/read-all`, { body: {} }); changed(); }}>Mark all as read</button>
          <button className="btn btn-danger btn-sm" disabled={!sel.size} onClick={() => del({ ids: [...sel] }, 'Deleted selected')}>Delete selected</button>
          <button className="btn btn-danger btn-sm" onClick={() => confirm('Delete all READ notifications older than 30 days? Bookings, messages and reviews are not affected.') && del({ olderThanDays: 30, onlyRead: true }, 'Cleared old notifications')}>Clear old</button>
        </div>
      </div>
      <div className="panel panel-flush">
        {loading && !data ? <Spinner /> : error ? <ErrorBox message={error} retry={reload} /> : data!.items.length === 0 ? <Empty title={onlyUnread ? 'You’re all caught up' : 'No notifications yet'}>Updates about bookings and messages will appear here.</Empty> : (
          data!.items.map((n) => (
            <div key={n.id} className={`note ${n.read ? '' : 'unread'}`}>
              <input type="checkbox" aria-label={`Select: ${n.title}`} checked={sel.has(n.id)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(n.id); else s.delete(n.id); setSel(s); }} />
              <div className="body"><button className="open" onClick={() => open(n)}><strong>{!n.read && <span className="dot" aria-label="Unread" style={{ marginRight: '.4rem' }} />}{n.title}</strong><span className="muted">{n.body}</span><span className="muted small"> · {relTime(n.createdAt)}</span></button></div>
            </div>))
        )}
        {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
