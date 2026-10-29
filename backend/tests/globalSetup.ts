import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prepares a clean, migrated test database once per run. Requires a reachable PostgreSQL:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/bilecutz_test npm test
 * The target database is DROPPED AND RECREATED SCHEMA-WISE (public schema reset) — never point this
 * at a database containing real data.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/bilecutz_test';
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error('Refusing to run tests: the database name must contain "test" (it will be wiped).');
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  await client.end();
  process.env.TEST_DATABASE_URL = url;
}
