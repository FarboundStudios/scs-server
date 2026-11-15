import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { createModulesRuntime, readModules } from '../server/system/modules.mjs';
import { ManagerOperations } from '../server/system/manager/operations.mjs';
import { createRelay } from '../server/system/server.mjs';
import { createClient } from '../client/client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 180; i++) {
    if (condition()) return;
    await delay(25);
  }
  throw Error('Timed out waiting for script policy or command');
}

test('Manager saves module choices only while stopped and rejects stale changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hvmp-script-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const supervisor = { state: 'stopped', status() { return { state: this.state }; } };
  const audit = [];
  const operations = new ManagerOperations({ directory, env: {}, supervisor, logs: {
    audit: async (...entry) => audit.push(entry),
  } });
  const initial = await operations.scripts();
  assert(initial.items.find(item => item.id === 'phone').enabled);
  assert(initial.items.find(item => item.id === 'classic-chat').enabled);
  assert(!initial.items.find(item => item.id === 'hello').enabled);
  assert(!initial.items.some(item => Object.hasOwn(item, 'entry')));
  await operations.setScript({ id: 'phone', enabled: false, revision: initial.revision }, 'owner');
  const updated = await operations.scripts();
  assert(!updated.items.find(item => item.id === 'phone').enabled);
  assert.equal(audit[0][1], 'script.disable');
  await assert.rejects(operations.setScript({ id: 'hello', enabled: true, revision: initial.revision }, 'owner'), /revision_conflict/);
  supervisor.state = 'running';
  await assert.rejects(operations.setScript({ id: 'hello', enabled: true, revision: updated.revision }, 'owner'), /stop_required/);
});

test('a classic-only session sends policy to the local game bridge and isolates a hanging script', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hvmp-script-relay-'));
  const root = join(directory, 'scripts');
  const data = join(directory, 'data');
  const logs = [];
  let modules, relay, client;
  const udp = createSocket('udp4');
  t.after(async () => {
    udp.close();
    await client?.close();
    await relay?.close();
    await modules?.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const id of ['classic-chat', 'phone', '_shared']) {
    await cp(new URL('../scripts/' + id + '/', import.meta.url),join(root,id),{recursive:true});
  }
  for (const id of ['example', 'broken', 'unsafe']) {
    const folder = join(root, id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({
      schema: 1, id, name: id, version: '1.0.0',
      entry: id === 'unsafe' ? '../example/index.mjs' : 'index.mjs',
    }));
    if (id === 'example') await writeFile(join(folder, 'index.mjs'),
      "export function onCommand({player, args}) {return 'Hello ' + player.name + ' ' + args.join(' ')}");
    if (id === 'broken') await writeFile(join(folder, 'index.mjs'),
      'export function onCommand() {while (true) {}}');
  }
  await mkdir(join(data, 'manager'), { recursive: true });
  await writeFile(join(data, 'manager/modules.json'), JSON.stringify({
    schema: 1, overrides: { phone: false, example: true, broken: true, unsafe: true },
  }));
  const config = await readModules(data, root);
  assert(config.modules.find(item => item.id === 'unsafe').error);
  modules = createModulesRuntime(config, message => logs.push(message));
  await modules.start();
  assert.deepEqual(modules.commands().sort(), ['/script broken', '/script example']);
  relay = await createRelay({ host: '127.0.0.1', port: 0, plaintext: true, modules, log: () => {} });
  assert.equal(relay.fakeCall('Alice').ok, false);
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  let flags = 0;
  udp.on('message', packet => {
    if (packet.length === 16 && packet.toString('ascii', 0, 4) === 'HML1') flags = packet.readUInt32LE(8);
  });
  client = await createClient({
    name: 'Alice', host: '127.0.0.1', port: relay.address.port, plaintext: true,
    telemetryPort: 0, monitorPort: 0, vehiclePort: udp.address().port,
  });
  await until(() => client.status.connected && flags === 2);
  const phone = await fetch('http://127.0.0.1:' + client.monitorAddress.port + '/phone/comms');
  assert.equal(phone.status, 503);
  const command = text => udp.send(Buffer.from(JSON.stringify({
    protocol: 1, gameId: 'eut2', type: 'chat', channel: 'global', text,
  })), client.telemetryAddress.port, '127.0.0.1');
  command('/script example cargo');
  await until(() => client.status.chat.some(message => message.text === 'Hello Alice cargo'));
  await delay(825);
  command('/script broken');
  await until(() => logs.some(message => message.includes('broken: script hook timed out')));
  assert(client.status.connected);
  assert.equal(modules.status().find(item => item.id === 'broken').state, 'failed');
  command('/script example again');
  await until(() => client.status.chat.some(message => message.text === 'Hello Alice again'));
});
