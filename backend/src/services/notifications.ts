import { query, queryOne, pool, type Queryable } from '../db/pool.js';
import { emitToRoom, rooms } from '../realtime/emitter.js';
import { getSettings } from './settings.js';

export interface NotificationInput {
  recipientUserId: string;
  type: string;
  title: string;
  body?: string;
  entityType?: 'appointment' | 'conversation' | 'review';
  entityId?: string;
  /** Same (recipient, dedupeKey) never creates a second row — makes retries idempotent. */
  dedupeKey?: string;
  /** For chat: re-open the single existing row as unread with fresh text instead of ignoring it. */
  reopen?: boolean;
}

export function mapNotification(r: any) {
  return {
    id: r.id as string,
    type: r.type as string,
    title: r.title as string,
    body: r.body as string,
    entityType: (r.entity_type ?? null) as 'appointment' | 'conversation' | 'review' | null,
    entityId: (r.entity_id ?? null) as string | null,
    read: r.read_at != null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export type NotificationDto = ReturnType<typeof mapNotification>;

/** Inserts a notification (idempotent when dedupeKey is set). Returns null if it was a duplicate. */
export async function createNotification(n: NotificationInput, db: Queryable = pool): Promise<NotificationDto | null> {
  const conflict = n.reopen
    ? `ON CONFLICT (recipient_user_id, dedupe_key) DO UPDATE
         SET read_at = NULL, title = EXCLUDED.title, body = EXCLUDED.body, created_at = now()`
    : `ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING`;
  const row = await queryOne(
    `INSERT INTO notifications (recipient_user_id, type, title, body, entity_type, entity_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ${conflict} RETURNING *`,
    [n.recipientUserId, n.type, n.title, n.body ?? '', n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null],
    db,
  );
  return row ? mapNotification(row) : null;
}

export type StaffEvent = 'newBooking' | 'chat' | 'review' | 'cancellation';

/** Notifies every active admin/staff account, honouring the admin's notification preferences. */
export async function notifyStaff(
  event: StaffEvent,
  n: Omit<NotificationInput, 'recipientUserId'>,
  db: Queryable = pool,
): Promise<{ userId: string; notification: NotificationDto }[]> {
  const s = await getSettings(db);
  const enabled = { newBooking: s.notifyAdminNewBooking, chat: s.notifyAdminChat, review: s.notifyAdminReview, cancellation: s.notifyAdminCancellation }[event];
  if (!enabled) return [];
  const staff = await query<{ id: string }>(`SELECT id FROM users WHERE role IN ('admin','staff') AND status = 'active'`, [], db);
  const out: { userId: string; notification: NotificationDto }[] = [];
  for (const u of staff) {
    const notification = await createNotification({ ...n, recipientUserId: u.id }, db);
    if (notification) out.push({ userId: u.id, notification });
  }
  return out;
}

/** Push created notifications to connected sockets. Call AFTER the transaction has committed. */
export function pushNotifications(items: { userId: string; notification: NotificationDto }[]) {
  for (const { userId, notification } of items) emitToRoom(rooms.user(userId), 'notification:new', { notification });
}
