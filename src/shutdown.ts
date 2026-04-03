import type { MuLogger } from './logger.js';

export function setupGracefulShutdown(logger: MuLogger, cleanup?: () => Promise<void>) {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down…`);

    try {
      await Promise.race([
        cleanup?.() ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } catch (err: any) {
      logger.error(`Shutdown error: ${err.message}`);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
