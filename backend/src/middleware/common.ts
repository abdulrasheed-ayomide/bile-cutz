import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError, type ZodType } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Parses `data` with a zod schema, converting failures into a friendly 400. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw zodToAppError(r.error);
}

function zodToAppError(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const i of err.issues) {
    const key = i.path.join('.') || '_';
    fields[key] ??= i.message;
  }
  const first = err.issues[0];
  const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
  return new AppError('VALIDATION_ERROR', `${where}${first?.message ?? 'Invalid input'}`, { fields });
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(new AppError('NOT_FOUND', 'Route not found.'));

export const errorHandler: ErrorRequestHandler = (err, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) err = zodToAppError(err);
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body too large.' } });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' } });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'File is too large (max 5 MB).' } });
  // Unknown: log without request bodies / headers (could contain PII or secrets).
  logger.error('unhandled error', { method: req.method, path: req.path, message: err?.message, code: err?.code });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
};

/** Rate limiter factory. Disabled under test unless a test explicitly opts in. */
export function limiter(opts: { windowMs: number; max: number; message?: string; keyPrefix?: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest && !process.env.TEST_RATE_LIMIT,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: opts.message ?? 'Too many requests. Please slow down and try again shortly.' } }),
  });
}

export const limits = {
  api: limiter({ windowMs: 60_000, max: 300 }),
  login: limiter({ windowMs: 15 * 60_000, max: 10, message: 'Too many sign-in attempts. Please wait a few minutes.' }),
  adminLogin: limiter({ windowMs: 15 * 60_000, max: 6, message: 'Too many sign-in attempts. Please wait a few minutes.' }),
  register: limiter({ windowMs: 60 * 60_000, max: 10, message: 'Too many sign-ups from this network. Please try later.' }),
  recovery: limiter({ windowMs: 60 * 60_000, max: 5, message: 'Too many recovery requests. Please try again later.' }),
  booking: limiter({ windowMs: 60 * 60_000, max: 20, message: 'Too many booking attempts. Please try again later.' }),
  guestToken: limiter({ windowMs: 15 * 60_000, max: 60 }),
  chat: limiter({ windowMs: 60_000, max: 60, message: 'You are sending messages too quickly.' }),
};

export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store');
  next();
}

export function publicCache(seconds = 60): RequestHandler {
  return (_req, res, next) => {
    res.set('Cache-Control', `public, max-age=${seconds}`);
    next();
  };
}

/** Pagination params from a query string. */
export function pageParams(q: Record<string, unknown>, defaultSize = 20) {
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(q.pageSize ?? defaultSize), 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
