import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { captureProcessIdentity, parseProcStat, sameProcessIdentity } from '../src/process-identity.mjs';

const OPERATION = '7bd57c1f-7095-4e71-9ea5-c44cc50e7192';
const REQUEST = 'a'.repeat(64);
const BOOT = 'b9e9c470-dfb0-4bc9-8bc6-b0ee7461077e';
const stat = ({ pid = 721, state = 'S', parent = 700, group = 721, session = 721, start = 555 } = {}) => {
  const fields = Array(20).fill('0');
  fields[0] = state; fields[1] = String(parent); fields[2] = String(group); fields[3] = String(session); fields[19] = String(start);
  return `${pid} (child ) with parens) ${fields.join(' ')}`;
};
function procReader({ stats = [stat(), stat()], boot = [BOOT, BOOT], namespaces = ['pid:[4026533000]', 'pid:[4026533000]'], error } = {}) {
  let statReads = 0, bootReads = 0, nsReads = 0;
  return {
    readText: async filename => {
      if (error) throw Object.assign(new Error('private path detail'), { code: error });
      if (filename.endsWith('/721/stat')) return stats[Math.min(statReads++, stats.length - 1)];
      if (filename.endsWith('/boot_id')) return boot[Math.min(bootReads++, boot.length - 1)];
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    },
    readLink: async filename => {
      if (filename.endsWith('/721/ns/pid')) return namespaces[Math.min(nsReads++, namespaces.length - 1)];
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    }
  };
}
const request = (extra = {}) => ({ operationId: OPERATION, requestDigest: REQUEST, role: 'target', pid: 721,
  expectedParentPid: 700, requireSessionLeader: true, platform: 'linux', arch: 'x64', procRoot: '/fixture/proc', now: () => 1234, ...extra });

test('proc stat parser preserves fields after command names containing spaces and parentheses', () => {
  assert.deepEqual(parseProcStat(stat()), { pid: 721, state: 'S', parentPid: 700, processGroupId: 721, sessionId: 721, startTicks: 555 });
  assert.throws(() => parseProcStat('not a proc record'), /invalid proc stat/);
});

test('Linux launch identity binds operation, request, role, namespace, boot and observed child relationship', async () => {
  const reader = procReader();
  const evidence = await captureProcessIdentity(request(reader));
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.operationId, OPERATION);
  assert.equal(evidence.requestDigest, REQUEST);
  assert.equal(evidence.role, 'target');
  assert.equal(evidence.provenance, 'procfs-stable-double-read-and-launch-parent-check');
  assert.deepEqual(evidence.identity, { pid: 721, parentPid: 700, processGroupId: 721, sessionId: 721,
    startTicks: 555, bootId: BOOT, pidNamespace: 'pid:[4026533000]' });
});

for (const [name, fixture, reason] of [
  ['PID changed between reads', { stats: [stat(), stat({ start: 556 })] }, 'identity_changed_or_reaped'],
  ['process already reaped', { stats: [stat({ state: 'Z' }), stat({ state: 'Z' })] }, 'identity_changed_or_reaped'],
  ['wrong parent', { stats: [stat({ parent: 701 }), stat({ parent: 701 })] }, 'parent_identity_mismatch'],
  ['wrong launch session', { stats: [stat({ group: 44 }), stat({ group: 44 })] }, 'launch_session_mismatch'],
  ['boot changed', { boot: [BOOT, 'c9e9c470-dfb0-4bc9-8bc6-b0ee7461077e'] }, 'host_or_namespace_identity_changed'],
  ['namespace changed', { namespaces: ['pid:[4026533000]', 'pid:[4026533001]'] }, 'host_or_namespace_identity_changed'],
  ['malformed identity', { stats: ['malformed', 'malformed'] }, 'malformed_os_identity'],
  ['denied procfs', { error: 'EACCES' }, 'permission_denied'],
  ['vanished process', { error: 'ENOENT' }, 'process_missing_or_reaped']
]) test(`${name} remains unknown`, async () => {
  const evidence = await captureProcessIdentity(request(procReader(fixture)));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.reason, reason);
  assert.equal(evidence.operationId, OPERATION);
  assert.equal(evidence.requestDigest, REQUEST);
  assert.equal(JSON.stringify(evidence).includes('private path detail'), false);
});

test('unsupported platforms fail closed without attempting a native identity claim', async () => {
  let reads = 0;
  const evidence = await captureProcessIdentity(request({ platform: 'win32', readText: async () => { reads++; throw new Error(); },
    readLink: async () => { reads++; throw new Error(); } }));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.reason, 'unsupported_platform');
  assert.equal(evidence.adapter.id, 'unsupported');
  assert.equal(reads, 0);
});

test('native Linux fixture binds the observed identity to a disposable spawned child', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 350)'], { stdio: 'ignore', detached: true });
  let identity;
  child.once('spawn', () => {
    identity = captureProcessIdentity({ operationId: OPERATION, requestDigest: REQUEST, role: 'target', pid: child.pid,
      expectedParentPid: process.pid, requireSessionLeader: true });
  });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  const evidence = await identity;
  assert.equal(code, 0); assert.equal(signal, null);
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.identity.parentPid, process.pid);
  assert.equal(evidence.identity.pid, evidence.identity.processGroupId);
  assert.equal(evidence.identity.pid, evidence.identity.sessionId);
});

test('process identity continuity ignores a parent reparenting but rejects a different birth identity', async () => {
  const reader = procReader();
  const first = await captureProcessIdentity(request(reader));
  const parentChanged = { ...first, identity: { ...first.identity, parentPid: 1 } };
  const reused = { ...first, identity: { ...first.identity, startTicks: first.identity.startTicks + 1 } };
  assert.equal(sameProcessIdentity(first, parentChanged), true);
  assert.equal(sameProcessIdentity(first, reused), false);
});
