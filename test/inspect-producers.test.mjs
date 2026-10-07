import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, existsSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { digest } from '../src/contracts.mjs';
import { inspectProducers } from '../src/inspect-producers.mjs';
import { inspectionLimits } from '../src/inspection-snapshot.mjs';
import { publicState } from '../src/api.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function directory(t, beforeRemove = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'squire-inspection-test-'));
  t.after(async () => { await beforeRemove(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return root;
}
function fingerprint(root) {
  return readdirSync(root).sort().map(name => {
    const file = path.join(root, name), s = statSync(file, { bigint: true });
    return [name, s.size, s.mtimeNs, s.ctimeNs, createHash('sha256').update(readFileSync(file)).digest('hex')];
  });
}
function fixture(t) {
  const cleanup = [];
  const root = directory(t, async () => { for (const close of cleanup.reverse()) await close(); });
  const store = new Store(root); cleanup.push(() => store.close());
  const config = { id: 'fixture', stateDir: root };
  store.initialize({ ...config, tickets: [{ id: 'a' }] });
  const lease = store.lease('controller:fixture');
  const scope = store.beginProducer('fixture', 'ticket:a', lease, [digest('repository')]);
  const jobId = randomUUID(), operationId = randomUUID();
  store.update('fixture', s => {
    store.reserveProducerCall(scope, jobId); s.agentCalls++;
    s.tickets[0].producerHold = { scopeId: scope, status: 'implementing' };
    s.tickets[0].status = 'blocked';
  }, 'job.started', { jobId });
  const grant = store.registerProcess(scope, jobId, operationId, path.join(root, 'private-logs'), digest('private-request'));
  const terminal = { kind: 'terminal', endedAt: 123456, exitCode: 9, receiptDigest: digest('receipt') };
  return { root, store, config, scope, jobId, operationId, grant, terminal, addCleanup: close => cleanup.push(close), inspect: () => inspectProducers(config),
    finish: () => {
      store.claimProcess(grant, 'registered', 'supervisor', digest('private-request'));
      store.claimProcess(grant, 'supervisor', 'target', digest('private-request'));
      store.finishProcess(grant, 'target', terminal);
    } };
}

test('open and terminal-but-unprojected scopes retain links and fences without changing live WAL, SHM, leases or events', t => {
  const f = fixture(t);
  let before = fingerprint(f.root);
  const v = f.inspect(), s = v.scopes[0], op = s.operations[0];
  assert.deepEqual(fingerprint(f.root), before);
  assert.equal(v.evidence, 'complete_for_selected_records');
  assert.equal(v.holds[0].scopeId, f.scope);
  assert.equal(s.resources[0].resourceId, digest('repository'));
  assert.equal(s.explanation, 'operation_outcome_unknown_scope_open');
  assert.equal(op.phase, 'registered');
  assert.equal(op.liveness, 'unknown');
  assert.equal(op.reservation.jobId, f.jobId);
  assert.equal(op.reservation.linkage, 'linked');
  assert.deepEqual(s.reservations[0].operationIds, [f.operationId]);
  assert.equal(op.artifacts.presence, 'not_checked');
  assert.equal(v.snapshot.eventHighWater, 2);
  f.finish();
  before = fingerprint(f.root);
  for (let i = 0; i < 5; i++) {
    const next = f.inspect().scopes[0];
    assert.equal(next.explanation, 'terminal_records_present_scope_outcome_unprojected');
    assert.equal(next.replacementFence, 'retained');
    assert.equal(next.operations[0].terminal.immutableGuard, 'recognized');
    assert.equal(next.operations[0].terminal.exitCode, 9);
    assert.equal(next.operations[0].terminal.artifactVerified, false);
  }
  assert.deepEqual(fingerprint(f.root), before);
  assert.throws(() => f.store.assertProducerScopesClear('fixture'), { code: 'producer_unresolved' });
});

for (const phase of ['supervisor', 'target']) test(`${phase} grant is not proof of spawn, liveness or settlement`, t => {
  const f = fixture(t);
  f.store.claimProcess(f.grant, 'registered', 'supervisor', digest('private-request'));
  if (phase === 'target') f.store.claimProcess(f.grant, 'supervisor', 'target', digest('private-request'));
  const before = fingerprint(f.root), op = f.inspect().scopes[0].operations[0];
  assert.equal(op.phase, phase);
  assert.match(op.launch, /unconfirmed/);
  assert.equal(op.terminal.outcome, 'unknown');
  assert.deepEqual(fingerprint(f.root), before);
});

test('closed scope referenced by a stale hold is distinct from immutable process terminal', t => {
  const f = fixture(t); f.finish();
  f.store.update('fixture', () => {}, 'producer.completed', {}, f.scope);
  const before = fingerprint(f.root), s = f.inspect().scopes[0];
  assert.equal(s.closure, 'recorded_closed');
  assert.equal(s.explanation, 'producer_outcome_recorded');
  assert.equal(s.outcomeStateDigest.length, 64);
  assert.deepEqual(fingerprint(f.root), before);
});

test('reservation without registered operation remains unknown, never refunded or called not-started', t => {
  const f = fixture(t);
  f.store.db.prepare('DELETE FROM process_operations WHERE id=?').run(f.operationId);
  const before = fingerprint(f.root), s = f.inspect().scopes[0];
  assert.equal(s.explanation, 'scope_open_no_operation_evidence');
  assert.equal(s.reservations[0].jobId, f.jobId);
  assert.deepEqual(s.reservations[0].operationIds, []);
  assert.deepEqual(fingerprint(f.root), before);
});

test('missing database and missing project fail without creating files', t => {
  const root = directory(t), before = fingerprint(root);
  assert.throws(() => inspectProducers({ id: 'missing', stateDir: root }), { code: 'inspection_missing' });
  assert.deepEqual(fingerprint(root), before);
  assert.throws(() => inspectProducers({ id: 'missing', stateDir: path.join(root, 'absent') }), { code: 'inspection_missing' });
  assert.equal(existsSync(path.join(root, 'absent')), false);
  const f = fixture(t), snapshot = fingerprint(f.root);
  assert.throws(() => inspectProducers({ ...f.config, id: 'missing' }), { code: 'inspection_project' });
  assert.deepEqual(fingerprint(f.root), snapshot);
});

test('legacy schema is labeled and never migrated; event high-water accepts unrelated project gaps', t => {
  const root = directory(t), db = new DatabaseSync(path.join(root, 'squire.sqlite'));
  db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY,state TEXT); CREATE TABLE events(cursor INTEGER PRIMARY KEY,project TEXT);
    INSERT INTO project VALUES('legacy','{\"id\":\"legacy\",\"status\":\"running\",\"tickets\":[]}');
    INSERT INTO events VALUES(1,'legacy'),(500,'other')`);
  db.close();
  const before = fingerprint(root), v = inspectProducers({ id: 'legacy', stateDir: root });
  assert.equal(v.evidence, 'partial');
  assert.ok(v.issues.includes('missing_or_legacy_producer_scopes'));
  assert.ok(v.issues.includes('legacy_or_unknown_process_protocol'));
  assert.equal(v.snapshot.eventHighWater, 500);
  assert.equal(v.controllerLiveness, 'unknown');
  assert.deepEqual(fingerprint(root), before);
});

test('malformed evidence, absent references and secret/path/command payloads are not echoed or read', t => {
  const f = fixture(t), missing = randomUUID(), secret = 'SECRET_DO_NOT_DISCLOSE';
  f.store.db.prepare('UPDATE process_operations SET terminal=?,directory=?,request_digest=? WHERE id=?')
    .run(JSON.stringify({ kind: 'terminal', secret, argv: ['touch', '/arbitrary'] }), `/outside/${secret}`, secret, f.operationId);
  f.store.db.prepare('DELETE FROM producer_calls').run();
  f.store.update('fixture', s => {
    s.config.prompt = secret;
    s.blocker = { code: 'producer_unresolved', message: secret, detail: { scopeId: missing, scopes: [{ id: '../../private' }] } };
    s.tickets[0].producerHold.blocker = { message: secret };
  });
  const before = fingerprint(f.root), v = f.inspect(), text = JSON.stringify(v);
  assert.equal(v.evidence, 'partial');
  for (const value of [secret, '/outside', '/arbitrary', '../../private', 'lease_owner', 'token', 'argv', 'prompt']) assert.equal(text.includes(value), false);
  assert.ok(v.issues.includes('malformed_terminal'));
  assert.ok(v.issues.includes('reservation_link_missing_or_malformed'));
  assert.ok(v.issues.includes('referenced_scope_missing'));
  assert.equal(v.scopes.find(s => s.scopeId === missing).evidence, 'missing');
  assert.deepEqual(fingerprint(f.root), before);
});

test('oversize fields are labeled; oversized source and record sets fail boundedly', t => {
  const f = fixture(t);
  f.store.db.prepare('UPDATE process_operations SET terminal=? WHERE id=?').run('x'.repeat(5000), f.operationId);
  let before = fingerprint(f.root), v = f.inspect();
  assert.ok(v.issues.includes('oversize_record_field'));
  assert.equal(v.scopes[0].operations[0].terminal.evidence, 'oversize');
  assert.deepEqual(fingerprint(f.root), before);
  f.store.db.prepare('UPDATE project SET state=? WHERE id=?').run('x'.repeat(inspectionLimits.stateBytes + 1), 'fixture');
  v = f.inspect(); assert.ok(v.issues.includes('malformed_or_oversize_project_state'));
  f.store.db.exec('BEGIN');
  for (let i = 0; i <= inspectionLimits.rows; i++) f.store.db.prepare('INSERT INTO producer_resources VALUES (?,?)').run(f.scope, digest(String(i)));
  f.store.db.exec('COMMIT'); before = fingerprint(f.root);
  assert.throws(f.inspect, { code: 'inspection_limit' });
  assert.deepEqual(fingerprint(f.root), before);
  const root = directory(t), file = path.join(root, 'squire.sqlite');
  writeFileSync(file, ''); truncateSync(file, inspectionLimits.sourceBytes + 1);
  assert.throws(() => inspectProducers({ id: 'large', stateDir: root }), { code: 'inspection_limit' });
  assert.equal(statSync(file).size, inspectionLimits.sourceBytes + 1);
});

test('rollback journal, corrupt source and schema views are refused or labeled without source repair', t => {
  const f = fixture(t); writeFileSync(path.join(f.root, 'squire.sqlite-journal'), 'retained');
  let before = fingerprint(f.root);
  assert.throws(f.inspect, { code: 'inspection_journal' });
  assert.deepEqual(fingerprint(f.root), before);
  const root = directory(t), file = path.join(root, 'squire.sqlite');
  writeFileSync(file, 'not sqlite'); before = fingerprint(root);
  assert.throws(() => inspectProducers({ id: 'bad', stateDir: root }), { code: 'inspection_unavailable' });
  assert.deepEqual(fingerprint(root), before);
  rmSync(file);
  const db = new DatabaseSync(file); db.exec("CREATE VIEW project AS SELECT 'bad' AS id,'secret' AS state"); db.close();
  before = fingerprint(root);
  assert.ok(inspectProducers({ id: 'bad', stateDir: root }).issues.includes('missing_or_legacy_project'));
  assert.deepEqual(fingerprint(root), before);
});

test('a source database symlink is refused without following its content', { skip: process.platform === 'win32' }, t => {
  const root = directory(t), other = path.join(root, 'secret'); writeFileSync(other, 'private');
  symlinkSync(other, path.join(root, 'squire.sqlite'));
  assert.throws(() => inspectProducers({ id: 'bad', stateDir: root }), { code: 'inspection_path' });
  assert.equal(readFileSync(other, 'utf8'), 'private');
});

test('CLI is structured, rejects options and malformed configs before Store, and leaves status behavior intact', t => {
  const f = fixture(t), filename = path.join(f.root, 'project.json');
  writeFileSync(filename, JSON.stringify({ ...f.config, runtime: { command: ['DO_NOT_RUN'] }, prompt: 'private' }));
  const run = (...args) => spawnSync(process.execPath, ['bin/squire.mjs', ...args], { encoding: 'utf8', timeout: 10000 });
  let before = fingerprint(f.root), result = run('inspect-producers', filename);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).type, 'squire.producer-inspection');
  assert.deepEqual(fingerprint(f.root), before);
  for (const args of [[], [filename, '--retry'], [filename, '--scope=secret'], [path.join(f.root, 'missing-secret.json')]]) {
    result = run('inspect-producers', ...args);
    assert.equal(result.status, 1); const error = JSON.parse(result.stdout);
    assert.equal(error.type, 'squire.error'); assert.equal(error.code, 'inspection_input');
    assert.equal(result.stdout.includes('secret'), false);
  }
  writeFileSync(filename, '{"SECRET_DO_NOT_ECHO":'); before = fingerprint(f.root);
  result = run('inspect-producers', filename);
  assert.equal(JSON.parse(result.stdout).code, 'inspection_input');
  assert.equal(result.stdout.includes('SECRET'), false);
  assert.deepEqual(fingerprint(f.root), before);
  result = run('--help'); assert.match(result.stdout, /inspect-producers project.json/);
  writeFileSync(filename, JSON.stringify({ version: 1, ...f.config, goal: 'Synthetic fixture', services: {
    app: { source: path.join(path.dirname(f.root), 'synthetic-source.git'), branch: 'main', delivery: { kind: 'local' },
      checks: [{ name: 'fake', argv: ['node', '-e', ''], timeoutSeconds: 1 }] }
  } }));
  f.store.update('fixture', s => { s.config = JSON.parse(readFileSync(filename, 'utf8')); });
  result = run('status', filename);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.trim(), JSON.stringify(publicState(f.store.get('fixture'))));
});

test('a commit during capture deterministically refuses the mixed image, without retry or mutation by inspection', t => {
  const f = fixture(t), original = fs.readSync;
  let commits = 0, afterWriter;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!commits++) {
      f.store.update('fixture', s => { s.updatedAt = 999; }, 'synthetic.writer');
      afterWriter = fingerprint(f.root);
    }
    return result;
  });
  syncBuiltinESMExports();
  try { assert.throws(f.inspect, { code: 'inspection_changed' }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(fingerprint(f.root), afterWriter);
});

test('capacity and retained delivery/recovery phases remain visible; unknown statuses are partial', t => {
  const f = fixture(t);
  for (const phase of ['postmerge', 'waiting_ci', 'merging', 'preparing', 'prepared', 'repairing', 'review_ready', 'continuing', 'recovering_partial', 'recovering_candidate']) {
    f.store.update('fixture', s => { s.status = 'waiting_capacity'; s.tickets[0].producerHold.status = phase; });
    const before = fingerprint(f.root), view = f.inspect();
    assert.equal(view.durableStatus, 'waiting_capacity');
    assert.equal(view.holds[0].priorStatus, phase);
    assert.equal(view.evidence, 'complete_for_selected_records');
    assert.deepEqual(fingerprint(f.root), before);
  }
  f.store.update('fixture', s => { s.status = 'SECRET_FUTURE_STATUS'; });
  const view = f.inspect();
  assert.equal(view.durableStatus, 'unknown'); assert.equal(view.evidence, 'partial');
  assert.ok(view.issues.includes('unknown_durable_status')); assert.equal(JSON.stringify(view).includes('SECRET'), false);
});

test('cleanup failure is sanitized and withholds the result without modifying source state', t => {
  const f = fixture(t), original = fs.rmSync, before = fingerprint(f.root);
  let temporary;
  t.mock.method(fs, 'rmSync', (name) => { temporary = name; throw Object.assign(new Error(`SECRET path ${name}`), { code: 'EBUSY' }); });
  syncBuiltinESMExports();
  try {
    assert.throws(f.inspect, error => error.code === 'inspection_cleanup' && !error.message.includes('SECRET') && !error.message.includes(temporary));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (temporary) original(temporary, { recursive: true, force: true }); }
  assert.deepEqual(fingerprint(f.root), before);
});

test('aggregate scope references fail before scope lookups, and relative artifact paths remain unknown', t => {
  const f = fixture(t);
  f.store.update('fixture', s => {
    s.blocker = { code: 'producer_unresolved', detail: { scopes: Array.from({ length: 150 }, () => ({ id: randomUUID() })) } };
    s.tickets[0].blocker = { code: 'producer_unresolved', detail: { scopes: Array.from({ length: 150 }, () => ({ id: randomUUID() })) } };
  });
  const before = fingerprint(f.root);
  let lookups = 0;
  const original = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) {
    if (/FROM producer_scopes WHERE id=/.test(sql)) lookups++;
    return original.call(this, sql);
  });
  try { assert.throws(f.inspect, { code: 'inspection_limit' }); } finally { t.mock.restoreAll(); }
  assert.equal(lookups, 0); assert.deepEqual(fingerprint(f.root), before);
  f.store.update('fixture', s => { s.blocker = null; s.tickets[0].blocker = null; });
  f.store.db.prepare('UPDATE process_operations SET directory=? WHERE id=?').run('../../secret', f.operationId);
  const view = f.inspect();
  assert.ok(view.issues.includes('artifact_directory_missing_malformed_or_oversize'));
  assert.equal(view.scopes[0].operations[0].artifacts.directoryDigest, null);
});

test('concurrent WAL commits yield a coherent captured horizon or an explicit unavailable result', { timeout: 20000 }, async t => {
  const f = fixture(t), control = new Int32Array(new SharedArrayBuffer(8));
  // Keep a real concurrent SQLite writer alive; all data is disposable synthetic state.
  const worker = new Worker(`const {workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite');
    const gate=new Int32Array(workerData.control), db=new DatabaseSync(workerData.file); db.exec('PRAGMA busy_timeout=1000');
    let n=0;
    while(!Atomics.load(gate,1)) { db.exec('BEGIN IMMEDIATE');
      const s=JSON.parse(db.prepare('SELECT state FROM project WHERE id=?').get('fixture').state); s.updatedAt=100000+(++n);
      db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(s),'fixture');
      db.prepare('INSERT INTO events(project,data) VALUES (?,?)').run('fixture',JSON.stringify({n})); db.exec('COMMIT');
      if(n===1) { Atomics.store(gate,0,1); Atomics.notify(gate,0); }
      Atomics.wait(gate,1,0,2);
    } db.close();`, { eval: true, workerData: { control: control.buffer, file: path.join(f.root, 'squire.sqlite') } });
  const done = new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject); });
  f.addCleanup(async () => { Atomics.store(control, 1, 1); Atomics.notify(control, 1); await done; });
  assert.notEqual(Atomics.wait(control, 0, 0, 5000), 'timed-out');
  for (let i = 0; i < 20; i++) {
    let view;
    try {
      view = f.inspect();
    } catch (e) { assert.ok(['inspection_changed', 'inspection_unavailable'].includes(e.code), e.stack); continue; }
    assert.equal(view.updatedAt - 100000, view.snapshot.eventHighWater - 2);
  }
  Atomics.store(control, 1, 1); await done;
  const before = fingerprint(f.root), view = f.inspect();
  assert.equal(view.updatedAt - 100000, view.snapshot.eventHighWater - 2);
  assert.deepEqual(fingerprint(f.root), before);
});
