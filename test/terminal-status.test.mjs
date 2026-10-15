import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { withInspectionSnapshot } from '../src/inspection-snapshot.mjs';
import { inspectTerminalStatus, parseTerminalStatusArgs, renderTerminalStatus, runTerminalStatusWatch,
  terminalStatusLimits, watchTerminalStatus, writeTerminalStatusFrame } from '../src/terminal-status.mjs';

const NOW = Date.now();

function createFixture(t, ticketIds = ['alpha', 'beta']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'squire-terminal-status-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir);
  const config = { id: 'status-project', stateDir, tickets: ticketIds.map(id => ({ id })) };
  const configPath = path.join(root, 'project.json');
  writeFileSync(configPath, JSON.stringify(config));
  const store = new Store(stateDir);
  store.initialize(config);
  store.update(config.id, state => {
    state.status = 'running';
    for (const ticket of state.tickets) ticket.status = 'implementing';
  });
  const state = store.get(config.id);
  state.updatedAt = NOW;
  store.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), config.id);
  const initialState = structuredClone(store.get(config.id));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const snapshotReader = (directory, inspect) => withInspectionSnapshot(directory, (db, capture) => inspect(db, { ...capture, capturedAt: NOW }));
  const inspect = ids => inspectTerminalStatus({ id: config.id, stateDir, ticketIds: ids }, { now: () => NOW, snapshotReader });
  const changeState = update => {
    const saved = JSON.parse(store.db.prepare('SELECT state FROM project WHERE id=?').get(config.id).state);
    update(saved);
    store.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(saved), config.id);
    return saved;
  };
  const restoreState = update => {
    const saved = structuredClone(initialState);
    update(saved);
    store.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(saved), config.id);
    return saved;
  };
  return { root, stateDir, config, configPath, store, inspect, changeState, restoreState };
}

test('zero, one and multiple selected IDs are explicit, bounded and deduplicated', t => {
  const f = createFixture(t);
  let reads = 0;
  const noSelection = inspectTerminalStatus({ id: f.config.id, stateDir: f.stateDir, ticketIds: [] }, {
    now: () => NOW, snapshotReader: () => { reads++; throw new Error('must not inspect'); }
  });
  assert.equal(noSelection.availability, 'no_selection');
  assert.equal(noSelection.failureCode, 'no_selected_tickets');
  assert.equal(reads, 0);
  assert.doesNotMatch(renderTerminalStatus(noSelection), /no active runs/i);

  const one = f.inspect(['alpha']);
  assert.deepEqual(one.tickets.map(ticket => [ticket.ticketId, ticket.durableStatus]), [['alpha', 'implementing']]);
  const many = f.inspect(['alpha', 'alpha', 'beta']);
  assert.deepEqual(many.tickets.map(ticket => [ticket.ticketId, ticket.durableStatus]), [
    ['alpha', 'implementing'], ['beta', 'implementing']
  ]);
  assert.equal(many.liveness, 'unknown');
  assert.equal(many.durableFreshness, 'fresh');
  assert.equal(many.capturedAt, NOW);
});

test('unsupported and terminal persisted statuses stay enumerated and never imply liveness', t => {
  const f = createFixture(t);
  f.changeState(state => {
    state.status = 'completed';
    state.tickets[0].status = 'shipped';
    state.tickets[1].status = 'blocked';
  });
  let result = f.inspect(['alpha', 'beta']);
  assert.equal(result.projectStatus, 'completed');
  assert.deepEqual(result.tickets.map(ticket => ticket.durableStatus), ['shipped', 'blocked']);
  assert.equal(result.liveness, 'unknown');

  f.changeState(state => { state.tickets[0].status = 'future-controller-status'; });
  result = f.inspect(['alpha']);
  assert.equal(result.tickets[0].durableStatus, 'unknown');
  assert.equal(result.tickets[0].failureCode, 'unsupported_status');
  assert.equal(result.liveness, 'unknown');
});

test('stale durable state is UNKNOWN while its fresh snapshot time remains visible', t => {
  const f = createFixture(t);
  const oldUpdate = NOW - terminalStatusLimits.maxDurableAgeMs - 1;
  f.changeState(state => { state.updatedAt = oldUpdate; state.status = 'running'; });
  const result = f.inspect(['alpha']);
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failureCode, 'state_stale');
  assert.equal(result.projectStatus, 'unknown');
  assert.equal(result.tickets[0].durableStatus, 'unknown');
  assert.equal(result.durableUpdatedAt, oldUpdate);
  assert.equal(result.capturedAt, NOW);
  assert.equal(result.durableFreshness, 'stale');
});

test('missing, invalid and future update timestamps never inherit freshness from capture', t => {
  const f = createFixture(t);
  f.changeState(state => { delete state.updatedAt; });
  let result = f.inspect(['alpha']);
  assert.equal(result.failureCode, 'timestamp_missing');
  assert.equal(result.durableUpdatedAt, null);
  assert.equal(result.capturedAt, NOW);
  assert.equal(result.tickets[0].durableStatus, 'unknown');

  f.changeState(state => { state.updatedAt = NOW + terminalStatusLimits.futureTimestampSkewMs + 1; });
  result = f.inspect(['alpha']);
  assert.equal(result.failureCode, 'timestamp_invalid');
  assert.equal(result.projectStatus, 'unknown');
});

test('malformed state, project mismatch and missing tickets produce safe unknown rows', t => {
  const f = createFixture(t);
  f.store.db.prepare('UPDATE project SET state=? WHERE id=?').run('{"sentinel":"secret malformed state"}', f.config.id);
  let result = f.inspect(['alpha']);
  assert.equal(result.failureCode, 'state_malformed');
  assert.equal(result.tickets[0].durableStatus, 'unknown');
  assert.doesNotMatch(renderTerminalStatus(result), /secret malformed state/);

  f.restoreState(state => { state.id = 'cross_project_secret'; });
  result = f.inspect(['alpha']);
  assert.equal(result.failureCode, 'project_mismatch');
  assert.equal(result.projectId, f.config.id);
  assert.doesNotMatch(renderTerminalStatus(result), /cross_project_secret/);

  f.restoreState(state => { state.id = f.config.id; });
  result = f.inspect(['missing-ticket', 'alpha']);
  assert.equal(result.tickets[0].failureCode, 'ticket_missing');
  assert.equal(result.tickets[1].durableStatus, 'implementing');
});

test('oversize state and incompatible project schema fail closed', t => {
  const f = createFixture(t);
  f.changeState(state => { state.extra = 'x'.repeat(terminalStatusLimits.stateBytes + 16); });
  let result = f.inspect(['alpha']);
  assert.equal(result.failureCode, 'state_oversize');
  assert.equal(result.tickets[0].durableStatus, 'unknown');

  f.store.db.exec('DROP TABLE project; CREATE VIEW project AS SELECT 1 AS id, 1 AS state');
  result = f.inspect(['alpha']);
  assert.equal(result.failureCode, 'state_malformed');
  assert.equal(result.projectStatus, 'unknown');
});

test('renderer excludes prompts, bodies, paths, arbitrary errors and terminal controls', t => {
  const f = createFixture(t);
  f.changeState(state => {
    state.status = 'secret-project-status';
    state.tickets[0].status = 'secret-ticket-status\u001b[31m';
    state.tickets[0].spec.description = 'ticket body sentinel';
    state.config.privatePrompt = 'prompt sentinel';
    state.blocker = { message: 'error sentinel', path: '/private/path/sentinel' };
  });
  const rendered = renderTerminalStatus(f.inspect(['alpha']));
  for (const secret of ['secret-project-status', 'secret-ticket-status', 'ticket body sentinel', 'prompt sentinel', 'error sentinel', '/private/path/sentinel'])
    assert.doesNotMatch(rendered, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(rendered.includes('\u001b'), false);
  assert.match(rendered, /Liveness: UNKNOWN/);

  const malformed = renderTerminalStatus({ projectId: 'valid\u001b[2J', projectStatus: '\u001b[31mactive',
    failureCode: 'raw error detail /private', tickets: [{ ticketId: 'bad\nidentifier', durableStatus: 'running' }] });
  assert.equal(malformed.includes('\u001b'), false);
  assert.match(malformed, /Project ID: UNKNOWN/);
  assert.doesNotMatch(malformed, /raw error detail|bad\nidentifier/);
});

test('reader leaves source database bytes and durable metadata unchanged', t => {
  const f = createFixture(t);
  const files = readdirSync(f.stateDir).sort();
  const before = new Map(files.map(name => {
    const filename = path.join(f.stateDir, name);
    const stat = statSync(filename, { bigint: true });
    return [name, { bytes: readFileSync(filename), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }];
  }));
  f.inspect(['alpha', 'beta']);
  assert.deepEqual(readdirSync(f.stateDir).sort(), files);
  for (const name of files) {
    const filename = path.join(f.stateDir, name);
    const after = statSync(filename, { bigint: true });
    assert.deepEqual(readFileSync(filename), before.get(name).bytes);
    assert.equal(after.mtimeNs, before.get(name).mtimeNs);
    assert.equal(after.ctimeNs, before.get(name).ctimeNs);
  }
});

test('selection bounds and CLI argument validation are enforced', t => {
  const f = createFixture(t);
  const tooMany = Array.from({ length: terminalStatusLimits.maxSelectedTickets + 1 }, (_, index) => `ticket-${index}`);
  const result = f.inspect(tooMany);
  assert.equal(result.failureCode, 'invalid_request');
  assert.equal(result.tickets.length, 0);

  assert.deepEqual(parseTerminalStatusArgs([f.configPath, 'alpha', 'alpha', 'beta', '--watch=10']), {
    configPath: f.configPath, ticketIds: ['alpha', 'beta'], watchSeconds: 10
  });
  assert.deepEqual(parseTerminalStatusArgs([f.configPath, 'alpha', '--watch=0']), { failureCode: 'invalid_request' });
  assert.deepEqual(parseTerminalStatusArgs([f.configPath, 'alpha\u001b[31m']), { failureCode: 'invalid_request' });
});

test('API and renderer reject malformed request and frame shapes without throwing', t => {
  const f = createFixture(t);
  const relative = inspectTerminalStatus({ id: f.config.id, stateDir: 'relative/state', ticketIds: ['alpha'] }, {
    now: () => NOW, snapshotReader: () => { throw new Error('must not inspect relative paths'); }
  });
  assert.equal(relative.failureCode, 'invalid_request');
  assert.doesNotThrow(() => renderTerminalStatus(null));
  assert.doesNotThrow(() => renderTerminalStatus({ tickets: 'malformed collection', projectStatus: null }));
});

test('writer succeeds only on drain and cleans listeners after every terminal path', async () => {
  const value = { projectId: 'status-project', projectStatus: 'running',
    tickets: [{ ticketId: 'alpha', durableStatus: 'implementing' }] };
  const pipe = () => { const stream = new EventEmitter(); stream.write = () => false; return stream; };
  const clean = (stream, signal) => {
    for (const event of ['drain', 'error', 'close']) assert.equal(stream.listenerCount(event), 0, `${event} listener remains`);
    if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0, 'abort listener remains');
  };

  const drained = pipe();
  const drainedResult = writeTerminalStatusFrame(drained, value);
  drained.emit('drain');
  assert.equal(await drainedResult, true);
  clean(drained);

  const errored = pipe();
  const errorResult = writeTerminalStatusFrame(errored, value);
  errored.emit('error', new Error('private output error'));
  assert.equal(await errorResult, false);
  clean(errored);

  const closed = pipe();
  const closeResult = writeTerminalStatusFrame(closed, value);
  closed.emit('close');
  assert.equal(await closeResult, false);
  clean(closed);

  const aborted = pipe();
  const controller = new AbortController();
  const abortResult = writeTerminalStatusFrame(aborted, value, { signal: controller.signal });
  controller.abort();
  assert.equal(await abortResult, false);
  clean(aborted, controller.signal);

  const synchronousError = pipe();
  synchronousError.write = () => { synchronousError.emit('error', new Error('private synchronous failure')); return false; };
  assert.equal(await writeTerminalStatusFrame(synchronousError, value), false);
  clean(synchronousError);

  const thrown = pipe();
  thrown.write = () => { throw new Error('private synchronous throw'); };
  assert.equal(await writeTerminalStatusFrame(thrown, value), false);
  clean(thrown);

  for (const state of [{ destroyed: true }, { writableEnded: true }]) {
    const unavailable = pipe();
    Object.assign(unavailable, state);
    let writeCalled = false;
    unavailable.write = () => { writeCalled = true; return false; };
    assert.equal(await writeTerminalStatusFrame(unavailable, value), false);
    assert.equal(writeCalled, false);
    clean(unavailable);
  }
});

test('CLI refresh loop leaves a blocked writer when shutdown interrupts the pipe', async () => {
  const controller = new AbortController();
  const pipe = new EventEmitter();
  pipe.write = () => false;
  let reads = 0;
  const run = runTerminalStatusWatch(() => ++reads, value => writeTerminalStatusFrame(pipe, {
    projectId: 'status-project', projectStatus: 'running', tickets: [{ ticketId: 'alpha', durableStatus: 'implementing' }]
  }, { signal: controller.signal }), 1, { signal: controller.signal });
  setImmediate(() => controller.abort());
  assert.equal(await run, 'output_closed');
  assert.equal(reads, 1);
});

test('watch refreshes sequentially and stops cleanly when cancelled', async () => {
  const controller = new AbortController();
  let reads = 0, sleepCount = 0, activeReads = 0;
  const frames = [];
  const sleep = async milliseconds => {
    assert.equal(milliseconds, 1000);
    sleepCount++;
    if (sleepCount === 2) controller.abort();
  };
  for await (const value of watchTerminalStatus(async () => {
    assert.equal(activeReads, 0);
    activeReads++;
    const id = ++reads;
    await Promise.resolve();
    activeReads--;
    return id;
  }, 1, { signal: controller.signal, sleep })) frames.push(value);
  assert.deepEqual(frames, [1, 2]);
  assert.equal(reads, 2);
});
