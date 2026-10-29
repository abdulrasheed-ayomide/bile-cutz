import { pool, query, queryOne, withTransaction } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';
import { emitToRoom, rooms } from '../realtime/emitter.js';
import { createNotification, notifyStaff, pushNotifications } from './notifications.js';

export type ChatViewer = { id: string; side: 'customer' | 'staff' };

export const mapMessage = (r: any) => ({
  id: r.id as number,
  conversationId: r.conversation_id as string,
  senderId: r.sender_id as string,
  senderRole: r.sender_role as 'customer' | 'staff',
  body: r.body as string,
  clientMessageId: (r.client_message_id ?? null) as string | null,
  createdAt: new Date(r.created_at).toISOString(),
  readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
});

/** Conversation as seen by `side`: unreadCount = messages from the OTHER side not yet read. */
export async function conversationDto(id: string, side: 'customer' | 'staff') {
  const r = await queryOne(
    `SELECT c.*, u.full_name, u.email,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.read_at IS NULL AND m.sender_role <> $2) AS unread
       FROM conversations c JOIN users u ON u.id = c.customer_id WHERE c.id = $1`,
    [id, side],
  );
  if (!r) throw notFound('Conversation not found.');
  return {
    id: r.id as string,
    customer: { id: r.customer_id as string, fullName: r.full_name as string, email: r.email as string },
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    lastMessagePreview: (r.last_message_preview ?? null) as string | null,
    unreadCount: r.unread as number,
  };
}

export async function getOrCreateConversation(customerId: string) {
  await query(`INSERT INTO conversations (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING`, [customerId]);
  return (await queryOne<{ id: string }>('SELECT id FROM conversations WHERE customer_id = $1', [customerId]))!.id;
}

/** Authorization: customers only their own conversation; staff any. Same 404 either way. */
export async function assertAccess(conversationId: string, viewer: ChatViewer) {
  const c = await queryOne<{ customer_id: string }>('SELECT customer_id FROM conversations WHERE id = $1', [conversationId]);
  if (!c) throw notFound('Conversation not found.');
  if (viewer.side === 'customer' && c.customer_id !== viewer.id) throw notFound('Conversation not found.');
  return c;
}

export async function listMessages(conversationId: string, viewer: ChatViewer, opts: { before?: number; after?: number; limit?: number }) {
  await assertAccess(conversationId, viewer);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  if (opts.after != null) {
    const rows = await query(`SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id ASC LIMIT 500`, [conversationId, opts.after]);
    return { items: rows.map(mapMessage), hasMore: false };
  }
  const rows = await query(
    `SELECT * FROM messages WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
    [conversationId, opts.before ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit).reverse().map(mapMessage), hasMore };
}

/** Persists first, then broadcasts. Idempotent on (conversation, clientMessageId). */
export async function sendMessage(conversationId: string, viewer: ChatViewer, body: string, clientMessageId?: string | null) {
  await assertAccess(conversationId, viewer);
  const text = body.trim();
  if (!text || text.length > 2000) throw forbidden('Message must be 1–2000 characters.');
  const role = viewer.side;
  const out = await withTransaction(async (c) => {
    const inserted = await queryOne(
      `INSERT INTO messages (conversation_id, sender_id, sender_role, body, client_message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (conversation_id, client_message_id) DO NOTHING RETURNING *`,
      [conversationId, viewer.id, role, text, clientMessageId ?? null],
      c,
    );
    if (!inserted) {
      const existing = await queryOne('SELECT * FROM messages WHERE conversation_id = $1 AND client_message_id = $2', [conversationId, clientMessageId], c);
      return { message: mapMessage(existing), duplicate: true, pushes: [] as any[] };
    }
    await query(`UPDATE conversations SET last_message_at = $2, last_message_preview = $3 WHERE id = $1`, [conversationId, inserted.created_at, text.slice(0, 120)], c);
    const conv = await queryOne<{ customer_id: string }>('SELECT customer_id FROM conversations WHERE id = $1', [conversationId], c);
    let pushes: any[] = [];
    if (role === 'customer') {
      const who = await queryOne<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [viewer.id], c);
      pushes = await notifyStaff('chat', { type: 'chat_message', title: `New message from ${who?.full_name ?? 'a customer'}`, body: text.slice(0, 120), entityType: 'conversation', entityId: conversationId, dedupeKey: `chat:${conversationId}`, reopen: true }, c);
    } else {
      const n = await createNotification({ recipientUserId: conv!.customer_id, type: 'chat_message', title: 'New message from the shop', body: text.slice(0, 120), entityType: 'conversation', entityId: conversationId, dedupeKey: `chat:${conversationId}`, reopen: true }, c);
      if (n) pushes = [{ userId: conv!.customer_id, notification: n }];
    }
    return { message: mapMessage(inserted), duplicate: false, pushes };
  });
  if (!out.duplicate) {
    emitToRoom(rooms.staff, 'message:new', { message: out.message });
    emitToRoom(rooms.user(await customerOf(conversationId)), 'message:new', { message: out.message });
    emitToRoom(rooms.staff, 'conversation:updated', { conversation: await conversationDto(conversationId, 'staff') });
    pushNotifications(out.pushes);
  }
  return out.message;
}

async function customerOf(conversationId: string) {
  return (await queryOne<{ customer_id: string }>('SELECT customer_id FROM conversations WHERE id = $1', [conversationId]))!.customer_id;
}

export async function markRead(conversationId: string, viewer: ChatViewer) {
  await assertAccess(conversationId, viewer);
  const other = viewer.side === 'customer' ? 'staff' : 'customer';
  const n = await queryOne<{ n: number }>(
    `WITH u AS (UPDATE messages SET read_at = now() WHERE conversation_id = $1 AND sender_role = $2 AND read_at IS NULL RETURNING 1) SELECT count(*) AS n FROM u`,
    [conversationId, other],
  );
  // Clear the matching chat notification for the viewer.
  await query(`UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND dedupe_key = $2 AND read_at IS NULL`, [viewer.id, `chat:${conversationId}`]);
  if (n && n.n > 0) {
    emitToRoom(rooms.user(await customerOf(conversationId)), 'messages:read', { conversationId, by: viewer.side });
    emitToRoom(rooms.staff, 'messages:read', { conversationId, by: viewer.side });
    emitToRoom(rooms.staff, 'conversation:updated', { conversation: await conversationDto(conversationId, 'staff') });
  }
  return { ok: true, unreadCount: 0 };
}

export async function listConversations(opts: { q?: string; unread?: boolean; all?: boolean; page: number; pageSize: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.all) where.push('c.last_message_at IS NOT NULL');
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (opts.unread) where.push(`EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.read_at IS NULL AND m.sender_role = 'customer')`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await queryOne<{ n: number }>(`SELECT count(*) AS n FROM conversations c JOIN users u ON u.id = c.customer_id ${w}`, params))!.n;
  const rows = await query(
    `SELECT c.id FROM conversations c JOIN users u ON u.id = c.customer_id ${w}
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.pageSize, (opts.page - 1) * opts.pageSize],
  );
  const items = await Promise.all(rows.map((r) => conversationDto(r.id, 'staff')));
  return { items, total, page: opts.page, pageSize: opts.pageSize };
}

void pool;
