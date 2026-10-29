import { query, pool, type Queryable } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Records an important administrative action. Audit rows are never auto-deleted.
 * `details` must not contain secrets, passwords or tokens.
 */
export async function audit(
  actor: { id: string | null; role: string } | null,
  action: string,
  entityType?: string,
  entityId?: string,
  details: Record<string, unknown> = {},
  db: Queryable = pool,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor?.id ?? null, actor?.role ?? null, action, entityType ?? null, entityId ?? null, JSON.stringify(details)],
      db,
    );
  } catch (err) {
    logger.error('audit write failed', { action, message: (err as Error).message });
  }
}
