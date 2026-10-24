import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/config.js';
import { createService } from './bootstrap/service.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const service = createService(config);
  service.worker.start();
  await service.app.listen({ host: config.server.host, port: config.server.port });
  const shutdown = async (): Promise<void> => {
    await service.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void start();
}
