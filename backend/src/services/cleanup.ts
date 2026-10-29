import { query, queryOne, pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { getSettings } from './settings.js';

/**
 * Safe, disposable-data cleanup. It NEVER touches customers, appointments, appointment history,
 * reviews, chat messages or audit logs — those are retained indefinitely by design.
 *
 *  - password_reset_tokens: expired or used more than 1 day ago
 *  - sessions: expired
 *  - notifications: READ ones older than `notification_retention_days` (default 90), and any
 *    notification older than 1 year. Deleting a notification only removes the row; the linked
 *    appointment / conversation / review is a soft reference and is unaffected.
 */
export async function runCleanup() {
  const settings = await getSettings();
  const tokens = await queryOne<{ n: number }>(
    `WITH d AS (DELETE FROM password_reset_tokens
                 WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day' RETURNING 1)
     SELECT count(*) AS n FROM d`,
  );
  const sessions = await queryOne<{ n: number }>(`WITH d AS (DELETE FROM sessions WHERE expires_at < now() RETURNING 1) SELECT count(*) AS n FROM d`);
  const notifications = await queryOne<{ n: number }>(
    `WITH d AS (DELETE FROM notifications
                 WHERE (read_at IS NOT NULL AND created_at < now() - ($1::int * interval '1 day'))
                    OR created_at < now() - interval '365 days' RETURNING 1)
     SELECT count(*) AS n FROM d`,
    [settings.notificationRetentionDays],
  );
  const result = {
    expiredResetTokens: tokens?.n ?? 0,
    expiredSessions: sessions?.n ?? 0,
    oldNotifications: notifications?.n ?? 0,
  };
  logger.info('cleanup finished', result);
  return result;
}

/** Basic database usage numbers for the admin "System" page. */
export async function databaseUsage() {
  const size = await queryOne<{ size: number }>('SELECT pg_database_size(current_database()) AS size');
  const tables = await query<{ name: string; rows: number; size_bytes: number }>(
    `SELECT c.relname AS name, c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS size_bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY size_bytes DESC`,
  );
  const settings = await getSettings();
  return {
    databaseSizeBytes: size?.size ?? 0,
    tables: tables.map((t) => ({ name: t.name, rows: Math.max(0, t.rows), sizeBytes: t.size_bytes })),
    retention: { notificationRetentionDays: settings.notificationRetentionDays, expiredTokensAfterDays: 1, chatAuditAppointmentsReviews: 'kept indefinitely' },
  };
}

export function startCleanupSchedule(hours: number): () => void {
  if (!hours) return () => {};
  const timer = setInterval(() => runCleanup().catch((e) => logger.error('cleanup failed', { message: e.message })), hours * 3600_000);
  timer.unref();
  return () => clearInterval(timer);
}

void pool;
