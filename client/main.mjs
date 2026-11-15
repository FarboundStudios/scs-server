import { readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { createClient } from './client.mjs';

try {
  const configPath = resolve(process.argv[2] ?? 'client/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const client = await createClient({...config,identityDirectory:dirname(configPath)});
  console.log(`HeavyMP · ${config.name} · local monitor: http://127.0.0.1:${client.monitorAddress?.port ?? 34062}`);
  console.log('HeavyMP network service is running.');
  let lastSummary = '';
  client.events.on('status', s => {
    const summary = `${s.connected ? 'Connected' : 'Disconnected'} · telemetry ${s.telemetry ? 'received' : 'waiting'}${s.error ? ` · ${s.error}` : ''}`;
    if (summary !== lastSummary) { console.log(summary); lastSummary = summary; }
  });
  const shutdown = async () => { await client.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch (e) { console.error(e.message); console.error('Copy client/config.example.json to client/config.json and enter the server address and player name.'); process.exitCode = 1; }
