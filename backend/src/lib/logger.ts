import { env } from '../config/env.js';

/**
 * Minimal structured logger. Callers must never pass secrets, tokens, passwords or
 * customer PII; as a safety net, well-known sensitive keys are redacted.
 */
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|hash|ticket|service_role/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  if (env.isTest && level !== 'error') return;
  const line = { level, time: new Date().toISOString(), msg, ...(meta ? (redact(meta) as object) : {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
