import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeStopUnitRequest, captureStopJobReply, decodeStopJobRemoved} from '../src/stop-unit-codec.mjs';
import {createAsyncStopManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {spec} from './fixtures.mjs';

const binding = () => ({job_id: spec().job_id, unit_name: 'squire-codec.service', invocation_id: '1'.repeat(32)});
const context = () => ({binding: binding(), manager_owner: ':1.42', request_serial: 7});
const reply = () => ({sender: ':1.42', reply_serial: 7, signature: 'o', body: ['/org/freedesktop/systemd1/job/23']});
const receipt = () => captureStopJobReply(context(), reply());
const event = () => ({sender: ':1.42', path: '/org/freedesktop/systemd1', interface: 'org.freedesktop.systemd1.Manager',
  member: 'JobRemoved', signature: 'uoss', body: [23, '/org/freedesktop/systemd1/job/23', binding().unit_name, 'done']});

test('StopUnit request describes exact manager-owned destination and explicit fail mode without I/O', () => {
  const input = {binding: binding(), manager_owner: ':1.42', job_mode: 'fail'};
  const r = encodeStopUnitRequest(input);
  assert.deepEqual(r.message, {destination: ':1.42', path: '/org/freedesktop/systemd1', interface: 'org.freedesktop.systemd1.Manager',
    member: 'StopUnit', signature: 'ss', body: ['squire-codec.service', 'fail']});
  input.binding.invocation_id = '2'.repeat(32); assert.equal(r.binding.invocation_id, '1'.repeat(32));
  assert.throws(() => {r.message.body[0] = 'changed';}, TypeError);
});
test('codec rejects unsupported stop modes, guessed epoch and unsupported manager-owner profile', () => {
  const input = {binding: binding(), manager_owner: ':1.42', job_mode: 'fail'};
  for (const variant of [{job_mode: 'replace'}, {manager_owner: 'org.freedesktop.systemd1'},
    {binding: {...binding(), invocation_id: '0'.repeat(32)}}, {binding: {...binding(), invocation_id: null}}]) {
    assert.throws(() => encodeStopUnitRequest({...input, ...variant}));
  }
});
test('queued method reply is serial/owner-correlated but is not job ACK or cleanup', () => {
  const r = receipt(); assert.equal(r.job_id, 23); assert.equal(r.request_serial, 7);
  assert.equal(Object.hasOwn(r, 'job_acknowledged'), false); assert.equal(Object.hasOwn(r, 'settlement_status'), false);
  assert.equal(Object.hasOwn(r, 'live_count'), false);
});
test('wrong sender, reply serial, signature or job-path representation is rejected', () => {
  for (const patch of [{sender: ':1.99'}, {reply_serial: 8}, {signature: 's'},
    {body: ['/org/freedesktop/systemd1/job/023']}, {body: ['/org/freedesktop/systemd1/job/4294967296']},
    {body: ['/different/23']}, {body: []}]) assert.throws(() => captureStopJobReply(context(), {...reply(), ...patch}));
});
test('only matching successful JobRemoved produces transaction ACK, never a cleanup claim', () => {
  const r = decodeStopJobRemoved(receipt(), event()); assert.equal(r.status, 'ACKNOWLEDGED');
  assert.deepEqual(r.response, {binding: binding(), job_acknowledged: true});
  assert.equal(Object.hasOwn(r.response, 'live_count'), false); assert.equal(Object.hasOwn(r.response, 'settlement_status'), false);
});
test('foreign sender, interface, member, path or unrelated job/unit stays unrelated', () => {
  const variants = [{sender: ':1.43'}, {path: '/different'}, {interface: 'different'}, {member: 'JobNew'},
    {body: [24, '/org/freedesktop/systemd1/job/24', binding().unit_name, 'done']},
    {body: [23, '/org/freedesktop/systemd1/job/23', 'squire-other.service', 'done']}];
  for (const patch of variants) assert.deepEqual(decodeStopJobRemoved(receipt(), {...event(), ...patch}), {status: 'UNRELATED'});
});
test('failed and unknown matched job outcomes cannot produce successful acknowledgement or echo text', () => {
  for (const outcome of ['failed', 'canceled', 'timeout', 'PRIVATE_UNKNOWN_RESULT']) {
    const e = event(); e.body[3] = outcome; const r = decodeStopJobRemoved(receipt(), e);
    assert.deepEqual(r, {status: 'UNKNOWN'}); assert.equal(JSON.stringify(r).includes('PRIVATE_'), false);
  }
});
test('inconsistent job identifiers and malformed signatures/tuples are rejected', () => {
  for (const patch of [{signature: 's'}, {body: [23]}, {body: [23, '/org/freedesktop/systemd1/job/24', binding().unit_name, 'done']},
    {body: [-1, '/org/freedesktop/systemd1/job/0', binding().unit_name, 'done']}]) {
    assert.throws(() => decodeStopJobRemoved(receipt(), {...event(), ...patch}));
  }
});
test('receipt identity/path fields cannot be changed without failing receipt validation', () => {
  assert.throws(() => decodeStopJobRemoved({...receipt(), job_id: 24}, event()));
  assert.throws(() => decodeStopJobRemoved({...receipt(), request_serial: 0}, event()));
  assert.throws(() => decodeStopJobRemoved({...receipt(), binding: {...binding(), invocation_id: null}}, event()));
});
test('data-only arrays reject getters and proxies without evaluating their traps', () => {
  let calls = 0; const body = ['/org/freedesktop/systemd1/job/23'];
  Object.defineProperty(body, '0', {get() {calls++; return 'PRIVATE';}});
  assert.throws(() => captureStopJobReply(context(), {...reply(), body}));
  const proxy = new Proxy([], {get() {calls++; throw new Error('PRIVATE');}});
  assert.throws(() => captureStopJobReply(context(), {...reply(), body: proxy})); assert.equal(calls, 0);
});
test('codec composes with injected async StopUnit ACK without accepting queued reply as empty proof', async () => {
  let complete, outgoing; const job = spec();
  const factory = createAsyncStopManagerCustodyFactory({clock: {now: () => 0, schedule: () => () => {}}, stop_ack_timeout_ms: 100,
    qualification: Object.fromEntries(HOST_GATES.map(key => [key, true])), manager: {
      startTransientUnit() {return {binding: binding(), custody_acknowledged: true, worker_in_cgroup_before_exec: true};},
      stopUnit(request) {outgoing = encodeStopUnitRequest({...request, manager_owner: ':1.42', job_mode: 'fail'});
        return new Promise(resolve => {complete = resolve;});}
    }});
  const session = factory.create(job, {executable: '/fixture/node', args: [], env: {TMPDIR: job.task_scope}, stdio: ['ignore', 'ignore', 'ignore']},
    {unit_name: binding().unit_name, stop_grace_ms: 50});
  session.start(); session.abort(); assert.equal(outgoing.message.member, 'StopUnit');
  const queued = receipt(); assert.equal(session.snapshot().stop_job_acknowledged, false);
  const decoded = decodeStopJobRemoved(queued, event()); complete(decoded.response); await session.stopAcknowledgement();
  assert.equal(session.snapshot().stop_job_acknowledged, true); assert.equal(session.snapshot().canceled, true);
  assert.equal(session.snapshot().settlement_status, 'UNKNOWN'); assert.equal(session.snapshot().workspace_reuse_blocked, true);
});
