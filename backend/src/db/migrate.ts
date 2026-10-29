import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> backend -> project root -> database
export const DATABASE_DIR = path.resolve(here, '..', '..', '..', 'database');

/**
 * Applies versioned SQL files from database/migrations in filename order.
 * Applied versions are tracked in schema_migrations; each file runs in its own transaction.
 */
export async function migrate(log: (m: string) => void = () => {}) {
  const dir = path.join(DATABASE_DIR, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    // Serialize concurrent migrators.
    await client.query('SELECT pg_advisory_lock(7263541)');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    await client.query('SELECT pg_advisory_unlock(7263541)');
    return applied;
  } finally {
    client.release();
  }
}

/** Runs seed SQL files (idempotent). */
export async function runSeeds(opts: { demo?: boolean } = {}, log: (m: string) => void = () => {}) {
  const dir = path.join(DATABASE_DIR, 'seeds');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => opts.demo || !f.includes('demo'))
    .sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    log(`seeded ${file}`);
  }
}
