import { Router } from 'express';
import { z } from 'zod';
import { clearSessionCookie, requireCustomer, requireStaff, sessionReader, setSessionCookie } from '../middleware/auth.js';
import { limits, noStore, parse } from '../middleware/common.js';
import { unauthenticated } from '../lib/errors.js';
import { COOKIE_NAMES, authenticate, changePassword, createSession, destroySession, registerCustomer, requestPasswordReset, resetPassword, toUserDto, updateProfile, type Scope } from '../services/auth.js';

export const passwordRule = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const phone = z.string().trim().max(30).regex(/^[\d+()\-\s.]*$/, 'Enter a valid phone number').optional().or(z.literal(''));

const registerSchema = z
  .object({ fullName: z.string().trim().min(1, 'Full name is required').max(120), email, phone, password: passwordRule, confirmPassword: z.string() })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

const loginSchema = z.object({ email: z.string().trim().min(1, 'Email is required'), password: z.string().min(1, 'Password is required').max(128) });
const forgotSchema = z.object({ email: z.string().trim().min(1).max(254) });
const resetSchema = z
  .object({ token: z.string().min(10).max(200), password: passwordRule, confirmPassword: z.string() })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });
const profileSchema = z.object({ fullName: z.string().trim().min(1, 'Full name is required').max(120), phone });
const passwordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: passwordRule, confirmPassword: z.string() })
  .refine((d) => d.newPassword === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

/** Builds the auth router for one scope. Customer and admin sessions are completely separate. */
function buildAuthRouter(scope: Scope) {
  const r = Router();
  const guard = scope === 'admin' ? requireStaff : requireCustomer;
  r.use(noStore);

  if (scope === 'customer') {
    r.post('/register', limits.register, async (req, res) => {
      const body = parse(registerSchema, req.body);
      const user = await registerCustomer({ fullName: body.fullName, email: body.email, phone: body.phone, password: body.password });
      const session = await createSession(user.id, 'customer', req.get('user-agent'));
      setSessionCookie(res, 'customer', session.token, session.expiresAt);
      res.status(201).json({ user: toUserDto(user), csrfToken: session.csrfToken });
    });
  }

  r.post('/login', scope === 'admin' ? limits.adminLogin : limits.login, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await authenticate(body.email, body.password, scope);
    // Rotate: drop any session presented with this request before issuing a new one.
    const old = req.cookies?.[COOKIE_NAMES[scope]];
    if (typeof old === 'string') await destroySession(old);
    const session = await createSession(user.id, scope, req.get('user-agent'));
    setSessionCookie(res, scope, session.token, session.expiresAt);
    res.json({ user: toUserDto(user), csrfToken: session.csrfToken });
  });

  r.post('/logout', async (req, res) => {
    const token = req.cookies?.[COOKIE_NAMES[scope]];
    if (typeof token === 'string') await destroySession(token);
    clearSessionCookie(res, scope);
    res.json({ ok: true });
  });

  r.get('/me', sessionReader(scope), (req, res) => {
    if (!req.auth) throw unauthenticated();
    res.json({ user: toUserDto(req.auth.user), csrfToken: req.auth.csrfToken });
  });

  r.post('/forgot-password', limits.recovery, async (req, res) => {
    const body = parse(forgotSchema, req.body);
    try {
      await requestPasswordReset(body.email, scope);
    } catch {
      /* swallow: the response must be identical whether or not the account exists / mail works */
    }
    res.status(202).json({ ok: true });
  });

  r.post('/reset-password', limits.recovery, async (req, res) => {
    const body = parse(resetSchema, req.body);
    await resetPassword(body.token, body.password, scope);
    res.json({ ok: true });
  });

  return { router: r, guard };
}

export const customerAuth = buildAuthRouter('customer');
export const adminAuth = buildAuthRouter('admin');

/** Profile + password endpoints for the signed-in user of a scope. */
function buildAccountRouter(scope: Scope) {
  const r = Router();
  const guard = scope === 'admin' ? requireStaff : requireCustomer;
  r.use(noStore);
  r.patch('/profile', guard, async (req, res) => {
    const body = parse(profileSchema, req.body);
    const user = await updateProfile(req.auth!.user.id, { fullName: body.fullName, phone: body.phone });
    res.json({ user: toUserDto(user) });
  });
  r.post('/password', guard, async (req, res) => {
    const body = parse(passwordSchema, req.body);
    await changePassword(req.auth!.user, req.auth!.sessionId, body.currentPassword, body.newPassword);
    res.json({ ok: true });
  });
  return r;
}

export const customerAccountRouter = buildAccountRouter('customer');
export const adminAccountRouter = buildAccountRouter('admin');
