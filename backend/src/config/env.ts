import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  ALLOWED_ORIGINS: z.string().min(1, 'ALLOWED_ORIGINS is required'),
  FRONTEND_URL: z.string().url(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional().default(''),
  TRUST_PROXY: bool,
  EMAIL_PROVIDER: z.enum(['smtp', 'dev-outbox']).default('dev-outbox'),
  EMAIL_FROM: z.string().default('Bile Cutz <no-reply@example.com>'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  STORAGE_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  SUPABASE_URL: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  SUPABASE_STORAGE_BUCKET: z.string().default('bile-cutz-media'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  CLEANUP_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
});

export type Env = z.infer<typeof schema> & { allowedOrigins: string[]; isProd: boolean; isTest: boolean };

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Print only variable names + messages, never values.
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid or missing environment configuration:\n${lines.join('\n')}\nSee backend/.env.example`);
  }
  const e = parsed.data;
  const allowedOrigins = e.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const problems: string[] = [];
  if (allowedOrigins.includes('*')) problems.push('ALLOWED_ORIGINS must not contain "*"');
  if (e.COOKIE_SAMESITE === 'none' && e.NODE_ENV === 'production' && !e.PUBLIC_API_URL.startsWith('https://'))
    problems.push('COOKIE_SAMESITE=none requires an HTTPS PUBLIC_API_URL');
  if (e.NODE_ENV === 'production') {
    if (/change-me/i.test(e.SESSION_SECRET)) problems.push('SESSION_SECRET still has the example placeholder value');
    if (e.EMAIL_PROVIDER === 'dev-outbox') problems.push('EMAIL_PROVIDER=dev-outbox is not allowed in production (use smtp)');
    if (!e.FRONTEND_URL.startsWith('https://')) problems.push('FRONTEND_URL must be https in production');
  }
  if (e.EMAIL_PROVIDER === 'smtp' && (!e.SMTP_HOST || !e.SMTP_USER || !e.SMTP_PASS))
    problems.push('EMAIL_PROVIDER=smtp requires SMTP_HOST, SMTP_USER and SMTP_PASS');
  if (e.STORAGE_PROVIDER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY))
    problems.push('STORAGE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  if (problems.length) throw new Error(`Unsafe environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { ...e, allowedOrigins, isProd: e.NODE_ENV === 'production', isTest: e.NODE_ENV === 'test' };
}

export const env: Env = load();
