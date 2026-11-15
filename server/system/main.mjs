import {cleanLog} from './logger.mjs';

try {
  const enabled = String(process.env.MANAGER_ENABLED ?? 'true').trim().toLowerCase();
  if (!['true', 'false', '1', '0'].includes(enabled)) throw Error('MANAGER_ENABLED must be true or false.');
  if (['false', '0'].includes(enabled)) {
    await import('./game-main.mjs');
  } else {
    const {startServerManager} = await import('./manager/main.mjs');
    const manager = await startServerManager();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await manager.close(); }
      catch (error) {
        console.error('[HVMP Server Manager] ' + cleanLog(error));
        process.exitCode = 1;
      } finally {
        process.stdin.pause();
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  console.error('[Error] Startup failed: ' + cleanLog(error));
  process.exitCode = 1;
}
