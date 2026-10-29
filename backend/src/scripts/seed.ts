import { closePool } from '../db/pool.js';
import { runSeeds } from '../db/migrate.js';

const demo = process.argv.includes('--demo');
runSeeds({ demo }, (m) => console.log(m))
  .then(() => console.log(demo ? 'Defaults and demo services seeded.' : 'Defaults seeded. (Use --demo to add sample services.)'))
  .catch((e) => {
    console.error(`Seeding failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
