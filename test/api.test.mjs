import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createControlServer } from '../src/api.mjs';
import { fixture, FixtureRuntime } from './support.mjs';

test('control API authenticates local clients, rejects browser ingress, exposes durable cursors and pause/resume', async t => {
  const f = await fixture(t); f.store.pause(f.config.id);
  const api = await createControlServer(f.store, { providers: { runtime: new FixtureRuntime() } }); f.addCleanup(() => api.close());
  const token = (await readFile(api.tokenFile, 'utf8')).trim(), headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${api.url}/v1/projects`)).status, 401);
  assert.equal((await fetch(`${api.url}/v1/projects`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const list = await (await fetch(`${api.url}/v1/projects`, { headers })).json(); assert.equal(list.projects[0].id, f.config.id); assert.equal(list.projects[0].config, undefined);
  const events = await (await fetch(`${api.url}/v1/projects/${f.config.id}/events?after=0`, { headers })).json(); assert.equal(events.events.length, 2);
  assert.equal((await fetch(`${api.url}/v1/projects/${f.config.id}/events?after=-1`, { headers })).status, 400);
  assert.equal((await fetch(`${api.url}/v1/projects/${f.config.id}/pause`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${api.url}/v2/projects`, { headers })).status, 404);
});
test('control API rejects config expansion and submits an authorized queue without model-specific protocol', { timeout: 90000 }, async t => {
  const f = await fixture(t); f.store.pause(f.config.id);
  const api = await createControlServer(f.store, { providers: { runtime: new FixtureRuntime() } }); f.addCleanup(() => api.close());
  const token = (await readFile(api.tokenFile, 'utf8')).trim(), headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${api.url}/v1/projects`, { method: 'POST', headers, body: JSON.stringify({ ...f.config, stateDir: f.root }) })).status, 400);
  assert.equal((await fetch(`${api.url}/v1/projects/${f.config.id}/resume`, { method: 'POST', headers, body: '{}' })).status, 202);
  // Pause command is durable even while a phase is in flight; no later merge starts.
  await fetch(`${api.url}/v1/projects/${f.config.id}/pause`, { method: 'POST', headers, body: '{}' });
  const result = await (await fetch(`${api.url}/v1/projects/${f.config.id}`, { headers })).json(); assert.equal(result.paused, true);
});
