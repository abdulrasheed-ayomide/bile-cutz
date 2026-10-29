import { afterEach, describe, expect, it, vi } from 'vitest';

const base = {
  NODE_ENV: 'production', DATABASE_URL: 'postgres://x@localhost/db', SESSION_SECRET: 'a'.repeat(40),
  ALLOWED_ORIGINS: 'https://shop.example.com', FRONTEND_URL: 'https://shop.example.com', EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', PUBLIC_API_URL: 'https://api.example.com',
};
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.resetModules(); });

async function load(over: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...saved, ...base, ...over } as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k];
  return import('../src/config/env.js');
}

describe('startup environment validation', () => {
  it('accepts a safe production configuration', async () => {
    const { env } = await load({});
    expect(env.isProd).toBe(true);
    expect(env.allowedOrigins).toEqual(['https://shop.example.com']);
  });
  it('fails clearly (without echoing secret values) when required variables are missing', async () => {
    await expect(load({ DATABASE_URL: undefined })).rejects.toThrow(/DATABASE_URL/);
    await expect(load({ SESSION_SECRET: 'short-secret-value' })).rejects.toThrow(/SESSION_SECRET/);
    await expect(load({ SESSION_SECRET: 'short-secret-value' })).rejects.not.toThrow(/short-secret-value/);
  });
  it('refuses unsafe production settings', async () => {
    await expect(load({ EMAIL_PROVIDER: 'dev-outbox' })).rejects.toThrow(/dev-outbox/);
    await expect(load({ SESSION_SECRET: 'change-me-' + 'x'.repeat(40) })).rejects.toThrow(/placeholder/);
    await expect(load({ FRONTEND_URL: 'http://shop.example.com' })).rejects.toThrow(/https/);
    await expect(load({ ALLOWED_ORIGINS: '*' })).rejects.toThrow(/\*/);
    await expect(load({ STORAGE_PROVIDER: 'supabase' })).rejects.toThrow(/SUPABASE_URL/);
  });
});
