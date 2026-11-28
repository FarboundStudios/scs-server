import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
const workerUrl = new URL('./module-worker.mjs', import.meta.url);
import { readJson, safeDirectory } from './manager/storage.mjs';

const moduleId = /^[a-z][a-z0-9-]{1,31}$/;
const serviceIds = new Set(['phone', 'classic-chat']);
const bundledIds = new Set([...serviceIds, 'hello', 'missions']);
export const isBundledModule = id => bundledIds.has(id);
const bundledRoot = fileURLToPath(new URL('../../scripts/', import.meta.url));
export const maxCustomModules = 12;
const maxModuleDirectories = 64;
const settingsPath = directory => join(directory, 'manager', 'modules.json');


export function readInstanceModules(directory, env) {
  return env.INSTANCE_SCRIPTS_DIR ?
    readModules(directory, resolve(env.INSTANCE_SCRIPTS_DIR), {includeBundled: true}) :
    readModules(directory);
}

export async function readModules(directory, root = resolve('scripts'), {includeBundled = false} = {}) {
  await safeDirectory(root);
  const defaults = { schema: 1, overrides: {} };
  const settings = directory ? await readJson(settingsPath(directory), defaults, 16384) : defaults;
  const overrides = settings?.overrides;
  if (settings?.schema !== 1 || !overrides || typeof overrides !== 'object' ||
      Array.isArray(overrides) || Object.entries(overrides).some(([id, value]) =>
        !moduleId.test(id) || typeof value !== 'boolean')) throw Error('invalid_module_settings');
  const modules = [];
  const folders = await readdir(root, { withFileTypes: true });
  const sources = new Map();
  if (includeBundled) {
    for (const folder of await readdir(bundledRoot, {withFileTypes: true})) {
      if (folder.isDirectory() && bundledIds.has(folder.name)) sources.set(folder.name, bundledRoot);
    }
  }
  for (const folder of folders) {
    if (folder.isDirectory() && moduleId.test(folder.name) && !sources.has(folder.name)) sources.set(folder.name, root);
  }
  const candidates = [...sources].sort(([a], [b]) =>
    Number(serviceIds.has(b)) - Number(serviceIds.has(a)) || a.localeCompare(b));
  for (const [id, moduleRoot] of candidates.slice(0, maxModuleDirectories)) {
    const service = serviceIds.has(id);
    try {
      const manifest = await readJson(join(moduleRoot, id, 'manifest.json'), null, 4096);
      if (manifest === null && !service) continue;
      if (!manifest || manifest.schema !== 1 || manifest.id !== id ||
          typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 64 ||
          typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
          (manifest.description !== undefined && (typeof manifest.description !== 'string' ||
            manifest.description.length > 240))) throw Error('invalid_module_manifest');
      if (typeof manifest.entry !== 'string' || !/^[a-z0-9_-]+\.m?js$/.test(manifest.entry)) {
        throw Error('invalid_module_entry');
      }
      const entry = join(moduleRoot, id, manifest.entry);
      const file = await lstat(entry);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 256 * 1024) {
        throw Error('invalid_module_entry');
      }
      const requestsMissions = !service && Array.isArray(manifest.permissions) && manifest.permissions.includes('missions.create');
      if (requestsMissions && (!Array.isArray(manifest.missionCreators) ||
          manifest.missionCreators.length > 32 ||
          manifest.missionCreators.some(identity => typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)))) {
        throw Error('invalid_mission_creators');
      }
      modules.push({
        id, name: manifest.name.trim(), version: manifest.version,
        description: manifest.description ?? '', service, entry,
        announce: !service && Array.isArray(manifest.permissions) && manifest.permissions.includes('announce'),
        ...(requestsMissions ? {missionCreators: [...new Set(manifest.missionCreators)]} : {}),
        enabled: Object.hasOwn(overrides, id) ? overrides[id] : service,
      });
    } catch {
      modules.push({ id, name: id, service, enabled: false, error: 'Invalid manifest or entry point' });
    }
  }
  return { modules, settings, settingsFile: directory ? settingsPath(directory) : null, truncated: candidates.length > maxModuleDirectories };
}

const playerInfo = ({ id, name, lastState }) => ({
  id, name, position: lastState ? { x: lastState.x, y: lastState.y, z: lastState.z } : null,
});

export function createModulesRuntime(configuration, log) {
  const runtime = new Map();
  let closing = false;
  let createMission;

  async function startCustom(module) {
    let worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: pathToFileURL(module.entry).href,
        env: {}, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      });
    } catch {
      runtime.set(module.id, { state: 'failed' });
      log('[Scripts] ' + module.id + ': worker could not start.');
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    const record = { module, worker, state: 'starting', pending: new Map(), next: 0, hooks: new Set() };
    runtime.set(module.id, record);
    await new Promise(resolveStart => {
      const startup = setTimeout(() => fail('initialization timed out'), 3000);
      function fail(reason) {
        clearTimeout(startup);
        if (record.state === 'failed' || closing) {
          resolveStart();
          return;
        }
        record.state = 'failed';
        log('[Scripts] ' + module.id + ': ' + reason + '.');
        for (const request of record.pending.values()) {
          clearTimeout(request.timeout);
          request.finish(null);
        }
        record.pending.clear();
        void worker.terminate().catch(() => {});
        resolveStart();
      }
      record.fail = fail;
      worker.on('error', () => fail('worker error'));
      worker.on('exit', () => fail('worker exited'));
      worker.on('message', message => {
        if (message?.type === 'ready' && record.state === 'starting') {
          clearTimeout(startup);
          record.hooks = new Set(message.hooks);
          record.state = 'running';
          resolveStart();
          return;
        }
        const request = record.pending.get(message?.id);
        if (!request) return;
        clearTimeout(request.timeout);
        record.pending.delete(message.id);
        if (message.type === 'failed') {
          request.finish(null);
          fail('script hook failed');
          return;
        }
        request.finish(message.result);
      });
    });
  }

  function invoke(record, hook, event) {
    if (record.state !== 'running' || !record.hooks.has(hook) || record.pending.size >= 8) return null;
    return new Promise(finish => {
      const id = ++record.next;
      const timeout = setTimeout(() => record.fail('script hook timed out'), 1000);
      record.pending.set(id, { finish, timeout });
      try {
        record.worker.postMessage({ id, hook, event });
      } catch {
        record.fail('script communication failed');
      }
    });
  }

  const cleanText = value => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : '';
  return {
    setMissionCreator(callback) {
      createMission = callback;
    },
    async activateService(id, activate) {
      const module = configuration.modules.find(item => item.id === id && item.service && item.enabled);
      if (!module) return null;
      try {
        const entry = await import(pathToFileURL(module.entry).href);
        const service = await activate(entry);
        if (!service) throw Error('The module did not provide a service.');
        runtime.set(id, { state: 'running' });
        return service;
      } catch (error) {
        runtime.set(id, { state: 'failed' });
        log('[Scripts] ' + id + ' : ' + (error?.message ?? 'Initialisation failed.'));
        return null;
      }
    },
    async start() {
      const scripts = configuration.modules.filter(module => !module.service && module.enabled);
      for (const module of scripts.slice(maxCustomModules)) runtime.set(module.id, { state: 'limit' });
      await Promise.all(scripts.slice(0, maxCustomModules).map(startCustom));
    },
    status() {
      return configuration.modules.filter(module => module.enabled).map(module => ({
        id: module.id, state: runtime.get(module.id)?.state ?? 'starting',
      }));
    },
    commands() {
      return [...runtime].filter(([, record]) => record.state === 'running' && record.hooks?.has('onCommand'))
        .map(([id]) => '/script ' + id);
    },
    playerEvent(hook, session) {
      for (const record of runtime.values()) if(record.worker)void invoke(record, hook, playerInfo(session));
    },
    command(id, args, session, tell, announce, stillConnected) {
      const record = runtime.get(id);
      if (!record || record.state !== 'running' || !record.hooks?.has('onCommand')) {
        tell('Module unavailable. Use /help to list available commands.');
        return;
      }
      const task = invoke(record, 'onCommand', { player: playerInfo(session), args });
      if (!task) {
        tell('Module busy. Try again in a moment.');
        return;
      }
      void task.then(async result => {
        if (closing || !stillConnected()) return;
        if (result === null) {
          tell('Module unavailable.');
          return;
        }
        if (result?.mission !== undefined) {
          if (!record.module.missionCreators?.includes(session.identityHash)) {
            tell('Your Steam account is not allowed to create missions with this script.');
            return;
          }
          if (!createMission) {
            tell('Mission creation is unavailable on this server.');
            return;
          }
          try {
            const mission = await createMission(session, result.mission);
            if (!closing && stillConnected()) tell(cleanText('Mission created: ' + mission.spec.title + '. Open Missions → Mine to start the delivery.'));
          } catch (error) {
            if (!closing && stillConnected()) tell(cleanText('Mission creation failed: ' + error.message));
          }
          return;
        }
        const reply = cleanText(typeof result === 'string' ? result : result?.reply);
        if (reply) tell(reply);
        const announcement = cleanText(result?.announce);
        if (announcement && record.module.announce) {
          announce(announcement);
        }
      }).catch(() => {});
    },
    async close() {
      closing = true;
      await Promise.all([...runtime.values()].map(async record => {
        for (const request of record.pending?.values() ?? []) {
          clearTimeout(request.timeout);
          request.finish(null);
        }
        record.pending?.clear();
        await record.worker?.terminate().catch(() => {});
      }));
    },
  };
}
