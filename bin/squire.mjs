#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateConfig } from '../src/contracts.mjs';
import { Store } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { createControlServer, publicState } from '../src/api.mjs';

const [command, filename, ...options] = process.argv.slice(2);
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const help = `Squire: durable subscription-backed software delivery\n\nnode bin/squire.mjs validate project.json\nnode bin/squire.mjs doctor project.json\nnode bin/squire.mjs run project.json [--once]\nnode bin/squire.mjs status project.json\nnode bin/squire.mjs events project.json [--after=N]\nnode bin/squire.mjs pause project.json\nnode bin/squire.mjs resume project.json [--retry]\nnode bin/squire.mjs serve ABSOLUTE_STATE_ROOT [--port=41828]\n\nRun/serve persist checkpoints and wait for work or capacity; Ctrl+C cancels\nactive local jobs and pauses the project. No API key is used by the Codex adapter.\n`;
async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(help); return; }
  if (!filename) throw new Error('A project config or state root is required');
  if (command === 'serve') {
    const directory = path.resolve(filename), store = new Store(directory);
    const port = Number(options.find(o => o.startsWith('--port='))?.slice(7) ?? '41828');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const api = await createControlServer(store, { port });
    print({ type: 'squire.control.ready', version: 1, url: api.url, tokenFile: api.tokenFile });
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    await api.close(); store.close(); return;
  }
  const config = validateConfig(JSON.parse(await readFile(filename, 'utf8')));
  if (command === 'validate') { print({ valid: true, project: config.id, authentication: 'chatgpt' }); return; }
  const store = new Store(config.stateDir);
  try {
    if (['run', 'doctor'].includes(command)) store.initialize(config);
    if (command === 'status') { print(publicState(store.get(config.id))); return; }
    if (command === 'events') { const cursor = Number(options.find(o => o.startsWith('--after='))?.slice(8) ?? '0'); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor'); store.events(config.id, cursor).forEach(print); return; }
    if (command === 'pause') { print(publicState(store.pause(config.id))); return; }
    if (command === 'resume') { print(publicState(store.resume(config.id, options.includes('--retry')))); return; }
    if (!['run', 'doctor'].includes(command)) throw new Error(`Unknown command ${command}`);
    const controller = new Controller(store, config.id);
    if (command === 'doctor') {
      await controller.runtime.preflight();
      for (const service of Object.values(config.services)) await controller.deliveryFactory(service).preflight(service);
      print({ ready: true, authentication: 'chatgpt', project: config.id }); return;
    }
    const abort = new AbortController(), cancel = () => abort.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    let cursor = 0;
    const emit = () => { for (const event of store.events(config.id, cursor)) { cursor = event.cursor; print(event); } };
    const timer = setInterval(emit, 500);
    try {
      const result = await controller.run(abort.signal, { wait: !options.includes('--once') }); emit();
      print({ type: 'squire.result', ...publicState(result) });
      process.exitCode = result.status === 'completed' || result.paused ? 0 : result.status === 'blocked' ? 2 : 3;
    } finally { clearInterval(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } finally { store.close(); }
}
main().catch(e => { print({ type: 'squire.error', code: e.code ?? 'error', message: e.message, detail: e.detail }); process.exitCode = 1; });
