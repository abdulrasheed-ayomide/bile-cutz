import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** URL-safe random token (default 256 bits). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes; they are high-entropy so a fast hash is appropriate. */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', env.SESSION_SECRET).update(data).digest('base64url');
}

export interface TicketPayload {
  uid: string;
  scope: 'customer' | 'admin';
  exp: number; // unix seconds
}

/** Short-lived signed ticket used to authenticate the Socket.IO handshake. */
export function signTicket(payload: Omit<TicketPayload, 'exp'>, ttlSeconds = 60): string {
  const body: TicketPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const b64 = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${b64}.${hmac(b64)}`;
}

export function verifyTicket(ticket: unknown): TicketPayload | null {
  if (typeof ticket !== 'string') return null;
  const [b64, sig] = ticket.split('.');
  if (!b64 || !sig || !timingSafeEqualStr(sig, hmac(b64))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as TicketPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.scope !== 'customer' && payload.scope !== 'admin') return null;
    return payload;
  } catch {
    return null;
  }
}
