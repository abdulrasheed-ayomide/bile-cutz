import { closePool } from '../db/pool.js';
import { runCleanup } from '../services/cleanup.js';

runCleanup()
  .then((r) => console.log('Cleanup complete:', r))
  .catch((e) => {
    console.error(`Cleanup failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
