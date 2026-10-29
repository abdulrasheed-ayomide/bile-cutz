import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { COOKIE_NAMES, loadSession, type AuthContext, type Scope } from '../services/auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext | null;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function cookieOptions(maxAgeMs?: number) {
  return {
    httpOnly: true,
    secure: env.isProd || env.COOKIE_SAMESITE === 'none',
    sameSite: env.COOKIE_SAMESITE,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  } as const;
}

export function setSessionCookie(res: Response, scope: Scope, token: string, expiresAt: Date) {
  res.cookie(COOKIE_NAMES[scope], token, cookieOptions(expiresAt.getTime() - Date.now()));
}

export function clearSessionCookie(res: Response, scope: Scope) {
  res.clearCookie(COOKIE_NAMES[scope], cookieOptions());
}

async function resolve(req: Request, scope: Scope): Promise<AuthContext | null> {
  const token = req.cookies?.[COOKIE_NAMES[scope]];
  if (!token || typeof token !== 'string') return null;
  return loadSession(token, scope);
}

/** CSRF: any state-changing request made with a session must echo the session's CSRF token. */
function checkCsrf(req: Request, auth: AuthContext) {
  if (!MUTATING.has(req.method)) return;
  const sent = req.get('x-csrf-token');
  if (!sent || !timingSafeEqualStr(sent, auth.csrfToken)) throw forbidden('Security check failed. Please refresh the page and try again.');
}

function guard(scope: Scope, roles: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = await resolve(req, scope);
      if (!auth) throw unauthenticated();
      if (!roles.includes(auth.user.role)) throw forbidden();
      checkCsrf(req, auth);
      req.auth = auth;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export const requireCustomer = guard('customer', ['customer']);
/** Staff or admin. */
export const requireStaff = guard('admin', ['admin', 'staff']);
/** Admin role only (settings, services, gallery, review moderation, system). */
export const requireAdmin = guard('admin', ['admin']);

/** Attaches the customer session if present (and CSRF-checks mutating calls); never rejects. */
export async function optionalCustomer(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = await resolve(req, 'customer');
    if (auth) {
      checkCsrf(req, auth);
      req.auth = auth;
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Reads the session for GET /me style endpoints without CSRF (read-only). */
export function sessionReader(scope: Scope) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.auth = await resolve(req, scope);
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Defence in depth: reject mutating browser requests coming from a non-allowed Origin. */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !env.allowedOrigins.includes(origin.replace(/\/$/, ''))) return next(forbidden('Request origin not allowed.'));
  next();
}
