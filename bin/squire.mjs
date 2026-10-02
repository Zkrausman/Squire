#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { validateConfig } from '../src/contracts.mjs';
import { Store } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { createControlServer, publicState } from '../src/api.mjs';

const [command, filename, ...options] = process.argv.slice(2);
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const help = `Squire: durable subscription-backed software delivery\n\nnode bin/squire.mjs validate project.json\nnode bin/squire.mjs doctor project.json\nnode bin/squire.mjs run project.json [--once]\nnode bin/squire.mjs status project.json\nnode bin/squire.mjs events project.json [--after=N]\nnode bin/squire.mjs pause project.json\nnode bin/squire.mjs resume project.json [--retry]\nnode bin/squire.mjs authorize-correction project.json correction.json\nnode bin/squire.mjs adopt-corrective-delivery project.json fulfillment.json\nnode bin/squire.mjs continue-interrupted project.json continuation.json\nnode bin/squire.mjs serve ABSOLUTE_STATE_ROOT [--port=41828]\n\nRun/serve persist checkpoints and wait for work or capacity; Ctrl+C cancels\nactive local jobs and pauses the project. No API key is used by the Codex adapter.\n`;
async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    const recoveryUsage = 'node bin/squire.mjs recover-interrupted-implementation project.json recovery.json\nnode bin/squire.mjs checkpoint-interrupted-candidate project.json checkpoint.json\n';
    process.stdout.write(help.replace('node bin/squire.mjs serve ABSOLUTE_STATE_ROOT', `${recoveryUsage}node bin/squire.mjs serve ABSOLUTE_STATE_ROOT`)); return;
  }
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
    if (command === 'configure-runtime') {
      if (!options[0]) throw new Error('Runtime JSON file required');
      const overrides = JSON.parse(await readFile(options[0], 'utf8'));
      for (const key of Object.keys(overrides)) if (!['model', 'reasoning', 'roles'].includes(key)) throw new Error(`Runtime routing field not allowed: ${key}`);
      const runtime = { ...config.runtime, ...overrides };
      const next = validateConfig({ ...config, runtime });
      const probe = new CodexRuntime(runtime, path.join(store.directory, 'projects', config.id));
      const availability = await probe.preflight();
      const state = store.configureRuntime(config, next.runtime);
      const temp = `${filename}.runtime.tmp`;
      await writeFile(temp, `${JSON.stringify(state.config, null, 2)}\n`);
      await rename(temp, filename);
      print({ configured: true, project: config.id, roles: availability.roles }); return;
    }
    if (command === 'configure-agent-budget') {
      if (!options[0] || options.length !== 1) throw new Error('Exactly one agent budget JSON file is required');
      const increase = JSON.parse(await readFile(options[0], 'utf8'));
      const result = store.configureAgentBudget(config, increase);
      const temp = `${filename}.agent-budget.tmp`;
      await writeFile(temp, `${JSON.stringify(result.config, null, 2)}\n`);
      await rename(temp, filename);
      const { config: _config, ...receipt } = result;
      print(receipt); return;
    }
    if (command === 'authorize-correction') {
      if (!options[0] || options.length !== 1) throw new Error('Exactly one correction JSON file is required');
      const correction = JSON.parse(await readFile(options[0], 'utf8'));
      print(store.authorizeCorrection(config, correction)); return;
    }
    if (command === 'adopt-corrective-delivery') {
      if (!options[0] || options.length !== 1) throw new Error('Exactly one fulfillment JSON file is required');
      const fulfillment = JSON.parse(await readFile(options[0], 'utf8'));
      print(store.adoptCorrectiveDelivery(config, fulfillment)); return;
    }
    if (command === 'continue-interrupted') {
      if (!options[0] || options.length !== 1) throw new Error('Exactly one continuation JSON file is required');
      const continuation = JSON.parse(await readFile(options[0], 'utf8'));
      print(store.continueInterrupted(config, continuation)); return;
    }
    if (command === 'recover-interrupted-implementation') {
      if (!options[0] || options.length !== 1) throw new Error('Exactly one partial recovery JSON file is required');
      const recovery = JSON.parse(await readFile(options[0], 'utf8'));
      print(await new Controller(store, config.id).recoverInterruptedImplementation(recovery)); return;
    }
    if (command === 'checkpoint-interrupted-candidate') {
      if (!options[0] || options.length !== 1) throw new Error('Exactly one interrupted candidate JSON file is required');
      const checkpoint = JSON.parse(await readFile(options[0], 'utf8'));
      print(await new Controller(store, config.id).checkpointInterruptedCandidateVerification(checkpoint)); return;
    }
    if (['run', 'doctor'].includes(command)) store.initialize(config);
    if (command === 'status') { print(publicState(store.get(config.id))); return; }
    if (command === 'events') { const cursor = Number(options.find(o => o.startsWith('--after='))?.slice(8) ?? '0'); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor'); store.events(config.id, cursor).forEach(print); return; }
    if (command === 'pause') { print(publicState(store.pause(config.id))); return; }
    if (command === 'resume') {
      if (options.some(o => o !== '--retry' && !o.startsWith('--ticket='))) throw new Error('Unknown resume option');
      const ticketIds = options.filter(o => o.startsWith('--ticket=')).map(o => o.slice(9));
      print(publicState(store.resume(config.id, options.includes('--retry'), ticketIds.length ? ticketIds : null))); return;
    }
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
