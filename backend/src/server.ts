import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { attachSocket } from './realtime/socket.js';
import { startCleanupSchedule } from './services/cleanup.js';

async function main() {
  // Fail fast if the database is unreachable or the schema has not been applied.
  await pool.query('SELECT 1 FROM users LIMIT 1').catch((e) => {
    throw new Error(`Database check failed (${e.message}). Did you run "npm run db:migrate"?`);
  });

  const app = createApp();
  const server = http.createServer(app);
  const io = attachSocket(server);
  const stopCleanup = startCleanupSchedule(env.CLEANUP_INTERVAL_HOURS);

  server.listen(env.PORT, () => logger.info(`Bile Cutz API listening on :${env.PORT}`, { env: env.NODE_ENV }));

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopCleanup();
    io.close();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
