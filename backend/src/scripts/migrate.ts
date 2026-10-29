import { closePool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

migrate((m) => console.log(m))
  .then((applied) => console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.'))
  .catch((e) => {
    console.error(`Migration failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
