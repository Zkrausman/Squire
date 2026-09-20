import { open, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { JsonRunStateStore } from '../dist/src/personal/json-run-state.js';
const [directory, input, stage] = process.argv.slice(2);
const states = new JsonRunStateStore(directory);
const state = JSON.parse(await readFile(input, 'utf8'));
const ready = process.env.SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH;
let held;
const barrier = (async () => {
  for (;;) {
    try { await access(ready); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(r => setTimeout(r, 5)); }
  }
  if (stage !== 'abandon-published') held = await open(path.join(directory, 'locks', 'aidev-1.lock'), 'r');
  process.send({ ready: true, pid: process.pid });
})();
try {
  await states.reserve(state);
  if (stage.startsWith('claim')) await states.claimReserved({ ...state, version: 2, launchState: 'started', controllerPid: process.pid, lifecycle: 'preparing', step: 'preparing', preparationState: 'started' });
  if (stage === 'abandon-published') await states.failReserved({ ...state, version: 2, status: 'failed', lifecycle: 'failed', launchState: 'failed', preparationState: 'failed', endedAt: state.updatedAt, lastError: 'fixture abandonment' });
  await barrier;
} finally { await held?.close(); process.disconnect(); }
