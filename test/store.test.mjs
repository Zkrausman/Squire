import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { fixture } from './support.mjs';

test('state and ordered outbox events survive reopening; authority changes reject', async t => {
  const f = await fixture(t);
  f.store.update(f.config.id, s => { s.tickets[0].status = 'verifying'; s.tickets[0].headSha = 'a'.repeat(40); }, 'ticket.transition', { ticket: 'a' });
  const other = new Store(f.stateDir); f.addCleanup(() => other.close());
  assert.equal(other.get(f.config.id).tickets[0].headSha, 'a'.repeat(40));
  const events = other.events(f.config.id); assert.deepEqual(events.map(e => e.type), ['project.created', 'ticket.transition']);
  assert.equal(other.events(f.config.id, events[0].cursor).length, 1);
  assert.throws(() => other.initialize({ ...f.config, goal: 'Expanded authority' }), /policy changed/);
});
test('failed transaction rolls back both state and events; lease excludes live owner', async t => {
  const f = await fixture(t), previous = f.store.get(f.config.id);
  assert.throws(() => f.store.update(f.config.id, s => { s.status = 'completed'; f.store.emit(f.config.id, 'bad', {}); throw new Error('abort'); }, 'bad'), /abort/);
  assert.equal(f.store.get(f.config.id).status, previous.status); assert.equal(f.store.events(f.config.id).length, 1);
  const release = f.store.lease('repo:main'); assert.throws(() => f.store.lease('repo:main'), /live controller/); release();
  f.store.lease('repo:main')();
});
test('pause and retry are explicit; postmerge failure retries verification, never implementation', async t => {
  const f = await fixture(t); f.store.pause(f.config.id); assert.equal(f.store.get(f.config.id).paused, true);
  f.store.update(f.config.id, s => { s.tickets[0].status = 'blocked'; s.tickets[0].mergeSha = 'a'.repeat(40); s.tickets[0].blocker = { code: 'postmerge_failed' }; });
  f.store.resume(f.config.id, true); assert.equal(f.store.get(f.config.id).tickets[0].status, 'postmerge');
});
