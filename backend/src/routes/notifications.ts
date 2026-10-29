import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requireCustomer, requireStaff } from '../middleware/auth.js';
import { noStore, pageParams, parse } from '../middleware/common.js';
import { mapNotification } from '../services/notifications.js';

const deleteSchema = z.object({ ids: z.array(z.string().uuid()).max(500).optional(), olderThanDays: z.number().int().min(0).max(3650).optional(), onlyRead: z.boolean().optional() });

/** Every query is scoped to the caller's own rows (recipient_user_id). Deleting only removes notification rows. */
function build(guard: any) {
  const r = Router();
  r.use(noStore, guard);
  const unread = async (uid: string) => (await queryOne<{ n: number }>('SELECT count(*) AS n FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL', [uid]))!.n;

  r.get('/', async (req, res) => {
    const uid = req.auth!.user.id;
    const { page, pageSize, offset } = pageParams(req.query);
    const onlyUnread = req.query.unread === '1';
    const cond = onlyUnread ? 'AND read_at IS NULL' : '';
    const total = (await queryOne<{ n: number }>(`SELECT count(*) AS n FROM notifications WHERE recipient_user_id = $1 ${cond}`, [uid]))!.n;
    const rows = await query(`SELECT * FROM notifications WHERE recipient_user_id = $1 ${cond} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [uid, pageSize, offset]);
    res.json({ items: rows.map(mapNotification), total, unreadCount: await unread(uid), page, pageSize });
  });
  r.get('/unread-count', async (req, res) => res.json({ unreadCount: await unread(req.auth!.user.id) }));
  r.post('/read-all', async (req, res) => {
    await query('UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL', [req.auth!.user.id]);
    res.json({ ok: true, unreadCount: 0 });
  });
  r.post('/delete', async (req, res) => {
    const b = parse(deleteSchema, req.body ?? {});
    const uid = req.auth!.user.id;
    if (!b.ids && b.olderThanDays == null) return res.json({ deleted: 0 });
    const params: unknown[] = [uid];
    let cond = '';
    if (b.ids) { params.push(b.ids); cond += ` AND id = ANY($${params.length}::uuid[])`; }
    if (b.olderThanDays != null) { params.push(b.olderThanDays); cond += ` AND created_at < now() - ($${params.length}::int * interval '1 day')`; }
    if (b.onlyRead) cond += ' AND read_at IS NOT NULL';
    const n = await queryOne<{ n: number }>(`WITH d AS (DELETE FROM notifications WHERE recipient_user_id = $1 ${cond} RETURNING 1) SELECT count(*) AS n FROM d`, params);
    res.json({ deleted: n?.n ?? 0 });
  });
  r.post('/:id/read', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND recipient_user_id = $2', [id, req.auth!.user.id]);
    res.json({ ok: true, unreadCount: await unread(req.auth!.user.id) });
  });
  return r;
}

export const customerNotificationsRouter = build(requireCustomer);
export const adminNotificationsRouter = build(requireStaff);
