import { Router } from 'express';
import { z } from 'zod';
import { signTicket } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { requireCustomer, requireStaff } from '../middleware/auth.js';
import { limits, noStore, pageParams, parse } from '../middleware/common.js';
import { conversationDto, getOrCreateConversation, listConversations, listMessages, markRead, sendMessage, type ChatViewer } from '../services/chat.js';

const uuid = z.string().uuid('Invalid id');
const sendSchema = z.object({ body: z.string().trim().min(1, 'Type a message').max(2000), clientMessageId: z.string().trim().min(1).max(64).optional() });
const listSchema = z.object({ before: z.coerce.number().int().positive().optional(), after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

function build(side: 'customer' | 'staff') {
  const r = Router();
  const guard = side === 'customer' ? requireCustomer : requireStaff;
  r.use(noStore, guard);
  const viewer = (req: any): ChatViewer => ({ id: req.auth.user.id, side });

  r.post('/socket-ticket', (req, res) => {
    res.json({ ticket: signTicket({ uid: req.auth!.user.id, scope: side === 'customer' ? 'customer' : 'admin' }), expiresInSeconds: 60 });
  });
  r.get('/conversations/:id/messages', async (req, res) => {
    res.json(await listMessages(parse(uuid, req.params.id), viewer(req), parse(listSchema, req.query)));
  });
  r.post('/conversations/:id/messages', limits.chat, async (req, res) => {
    const b = parse(sendSchema, req.body);
    const message = await sendMessage(parse(uuid, req.params.id), viewer(req), b.body, b.clientMessageId);
    res.status(201).json({ message });
  });
  r.post('/conversations/:id/read', async (req, res) => {
    res.json(await markRead(parse(uuid, req.params.id), viewer(req)));
  });

  if (side === 'customer') {
    r.get('/conversation', async (req, res) => {
      const id = await getOrCreateConversation(req.auth!.user.id);
      res.json({ conversation: await conversationDto(id, 'customer') });
    });
  } else {
    r.get('/conversations', async (req, res) => {
      const { page, pageSize } = pageParams(req.query);
      res.json(await listConversations({ q: typeof req.query.q === 'string' ? req.query.q : undefined, unread: req.query.unread === '1', all: req.query.all === '1', page, pageSize }));
    });
    r.post('/conversations', async (req, res) => {
      const { customerId } = parse(z.object({ customerId: uuid }), req.body);
      if (!(await queryOne(`SELECT 1 FROM users WHERE id = $1 AND role = 'customer'`, [customerId]))) throw notFound('Customer not found.');
      res.json({ conversation: await conversationDto(await getOrCreateConversation(customerId), 'staff') });
    });
  }
  return r;
}

export const customerChatRouter = build('customer');
export const adminChatRouter = build('staff');
