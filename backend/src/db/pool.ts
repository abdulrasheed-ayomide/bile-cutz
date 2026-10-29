import pg from 'pg';
import { env } from '../config/env.js';

// Return numeric/bigint columns as JS numbers where safe (prices, counts, message ids).
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8 / bigint / count(*)
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' string (no timezone shifting)

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Parameterized query helper. Always pass user input through `params`, never string-concatenate. */
export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const res = await db.query<T>(sql, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction (BEGIN … COMMIT, ROLLBACK on error). */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
