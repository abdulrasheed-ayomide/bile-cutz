import type http from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { verifyTicket } from '../lib/crypto.js';
import { queryOne } from '../db/pool.js';
import { rooms, setIo } from './emitter.js';
import { markRead, sendMessage } from '../services/chat.js';
import { AppError } from '../lib/errors.js';

/**
 * Socket.IO server. The handshake is authenticated with a short-lived signed ticket obtained from the
 * REST API (so the browser's httpOnly cookies never need to cross origins). Handlers for chat are
 * registered in `registerChatHandlers` (see services/chat.ts).
 */
export function attachSocket(server: http.Server): Server {
  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: env.allowedOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 20_000,
  });
  setIo(io);

  io.use(async (socket, next) => {
    const ticket = verifyTicket(socket.handshake.auth?.ticket);
    if (!ticket) return next(new Error('unauthorized'));
    const user = await queryOne<{ id: string; role: string; status: string; full_name: string }>(
      'SELECT id, role, status, full_name FROM users WHERE id = $1',
      [ticket.uid],
    );
    const roleOk = user && (ticket.scope === 'admin' ? user.role === 'admin' || user.role === 'staff' : user.role === 'customer');
    if (!user || user.status !== 'active' || !roleOk) return next(new Error('unauthorized'));
    socket.data.user = { id: user.id, role: user.role, scope: ticket.scope, name: user.full_name };
    next();
  });

  io.on('connection', async (socket) => {
    const u = socket.data.user as { id: string; role: string; scope: 'customer' | 'admin' };
    socket.join(rooms.user(u.id));
    if (u.scope === 'admin') socket.join(rooms.staff);
    else {
      const conv = await queryOne<{ id: string }>('SELECT id FROM conversations WHERE customer_id = $1', [u.id]);
      if (conv) socket.join(rooms.conversation(conv.id));
    }
    const viewer = { id: u.id, side: (u.scope === 'admin' ? 'staff' : 'customer') as 'staff' | 'customer' };
    const fail = (e: unknown) => ({ ok: false, error: e instanceof AppError ? e.message : 'Could not complete that action.' });

    // The message is persisted BEFORE the ack, so `ok: true` always means it is stored.
    socket.on('message:send', async (p: any, ack?: (r: unknown) => void) => {
      try {
        if (!p || typeof p.conversationId !== 'string' || typeof p.body !== 'string') throw new AppError('VALIDATION_ERROR', 'Invalid message.');
        const message = await sendMessage(p.conversationId, viewer, p.body, typeof p.clientMessageId === 'string' ? p.clientMessageId.slice(0, 64) : null);
        ack?.({ ok: true, message });
      } catch (e) { ack?.(fail(e)); }
    });
    socket.on('conversation:read', async (p: any, ack?: (r: unknown) => void) => {
      try {
        if (!p || typeof p.conversationId !== 'string') throw new AppError('VALIDATION_ERROR', 'Invalid request.');
        ack?.(await markRead(p.conversationId, viewer));
      } catch (e) { ack?.(fail(e)); }
    });
  });

  return io;
}
