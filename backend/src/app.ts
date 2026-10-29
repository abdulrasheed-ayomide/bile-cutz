import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { originCheck } from './middleware/auth.js';
import { errorHandler, limits, notFoundHandler } from './middleware/common.js';
import { apiRouter } from './routes/index.js';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

export function createApp() {
  const app = express();
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // The API serves JSON (+ locally stored images), never HTML pages, so a strict CSP is safe.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // images are loaded by the frontend origin
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] } },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.allowedOrigins.includes(origin.replace(/\/$/, ''))),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  if (env.STORAGE_PROVIDER === 'local') {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    // Uploaded files are validated images; nosniff + no scripts executed from this path.
    app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false, dotfiles: 'deny' }));
  }

  app.use('/api', limits.api, originCheck, apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
