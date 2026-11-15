import { parentPort, workerData } from 'node:worker_threads';

const script = await import(workerData);
const hooks = new Map();
for (const name of ['onCommand', 'onJoin', 'onLeave']) {
  if (typeof script[name] === 'function') hooks.set(name, script[name]);
}

const missionFields = ['title', 'source', 'destination', 'cargo', 'trailerDefinition', 'visibility', 'unitsCount', 'distanceKm'];
function missionPayload(value) {
  const result = {};
  for (const key of missionFields) {
    const field = value[key];
    if (typeof field === 'number' || typeof field === 'string' && field.length <= 120) result[key] = field;
  }
  return result;
}

parentPort.on('message', async ({ id, hook, event }) => {
  try {
    const value = await hooks.get(hook)?.(event);
    const result = typeof value === 'string'
      ? value.slice(0, 240)
      : {
        reply: typeof value?.reply === 'string' ? value.reply.slice(0, 240) : '',
        announce: typeof value?.announce === 'string' ? value.announce.slice(0, 240) : '',
        ...(hook === 'onCommand' && value?.mission && typeof value.mission === 'object' && !Array.isArray(value.mission)
          ? {mission: missionPayload(value.mission)}
          : {}),
      };
    parentPort.postMessage({ type: 'result', id, result });
  } catch {
    parentPort.postMessage({ type: 'failed', id });
  }
});
parentPort.postMessage({ type: 'ready', hooks: [...hooks.keys()] });
