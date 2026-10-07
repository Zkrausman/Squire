import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { captureProcessIdentity, parseProcNSpid, parseProcStat, sameProcessIdentity } from '../src/process-identity.mjs';

const OPERATION = '7bd57c1f-7095-4e71-9ea5-c44cc50e7192';
const REQUEST = 'a'.repeat(64);
const BOOT = 'b9e9c470-dfb0-4bc9-8bc6-b0ee7461077e';
const NAMESPACE = 'pid:[4026533000]';
const PROC_ROOT = '/fixture/proc';
const procPath = (...parts) => path.join(PROC_ROOT, ...parts);
const PROC_PATHS = {
  selfStat: procPath('self', 'stat'),
  selfStatus: procPath('self', 'status'),
  selfNamespace: procPath('self', 'ns', 'pid'),
  supervisorStat: procPath('700', 'stat'),
  supervisorStatus: procPath('700', 'status'),
  supervisorNamespace: procPath('700', 'ns', 'pid'),
  targetStat: procPath('721', 'stat'),
  targetNamespace: procPath('721', 'ns', 'pid'),
  bootId: procPath('sys', 'kernel', 'random', 'boot_id')
};
const supervisorStat = () => stat({ pid: 700, parent: 500, group: 500, session: 500, start: 100 });
const stat = ({ pid = 721, state = 'S', parent = 700, group = 721, session = 721, start = 555 } = {}) => {
  const fields = Array(20).fill('0');
  fields[0] = state; fields[1] = String(parent); fields[2] = String(group); fields[3] = String(session); fields[19] = String(start);
  return `${pid} (child ) with parens) ${fields.join(' ')}`;
};
const liveHandle = () => ({ pid: 721, exitCode: null, signalCode: null });
function procReader({ stats = [stat(), stat()], selfStats = [supervisorStat(), supervisorStat()],
  supervisorStats = [supervisorStat(), supervisorStat()], boot = [BOOT, BOOT],
  selfStatuses = ['Name:\tsupervisor\nNSpid:\t700\n', 'Name:\tsupervisor\nNSpid:\t700\n'],
  supervisorStatuses = ['Name:\tsupervisor\nNSpid:\t700\n', 'Name:\tsupervisor\nNSpid:\t700\n'],
  selfNamespaces = [NAMESPACE, NAMESPACE], supervisorNamespaces = [NAMESPACE, NAMESPACE],
  namespaces = [NAMESPACE, NAMESPACE], error, afterRead } = {}) {
  let targetReads = 0, selfReads = 0, supervisorReads = 0, selfStatusReads = 0, supervisorStatusReads = 0, bootReads = 0;
  let targetNsReads = 0, selfNsReads = 0, supervisorNsReads = 0;
  return {
    readText: async filename => {
      if (error) throw Object.assign(new Error('private path detail'), { code: error });
      let value;
      if (filename === PROC_PATHS.selfStat) value = selfStats[Math.min(selfReads++, selfStats.length - 1)];
      else if (filename === PROC_PATHS.selfStatus) value = selfStatuses[Math.min(selfStatusReads++, selfStatuses.length - 1)];
      else if (filename === PROC_PATHS.supervisorStat) value = supervisorStats[Math.min(supervisorReads++, supervisorStats.length - 1)];
      else if (filename === PROC_PATHS.supervisorStatus) value = supervisorStatuses[Math.min(supervisorStatusReads++, supervisorStatuses.length - 1)];
      else if (filename === PROC_PATHS.targetStat) value = stats[Math.min(targetReads++, stats.length - 1)];
      else if (filename === PROC_PATHS.bootId) value = boot[Math.min(bootReads++, boot.length - 1)];
      else throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      afterRead?.(filename, value);
      return value;
    },
    readLink: async filename => {
      if (filename === PROC_PATHS.selfNamespace) return selfNamespaces[Math.min(selfNsReads++, selfNamespaces.length - 1)];
      if (filename === PROC_PATHS.supervisorNamespace) return supervisorNamespaces[Math.min(supervisorNsReads++, supervisorNamespaces.length - 1)];
      if (filename === PROC_PATHS.targetNamespace) return namespaces[Math.min(targetNsReads++, namespaces.length - 1)];
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    }
  };
}
const request = (extra = {}) => ({ operationId: OPERATION, requestDigest: REQUEST, role: 'target', pid: 721,
  expectedParentPid: 700, launchHandle: liveHandle(), requireSessionLeader: true,
  platform: 'linux', arch: 'x64', procRoot: PROC_ROOT, now: () => 1234, ...extra });

test('proc stat parser preserves fields after command names containing spaces and parentheses', () => {
  assert.deepEqual(parseProcStat(stat()), { pid: 721, state: 'S', parentPid: 700, processGroupId: 721, sessionId: 721, startTicks: 555 });
  assert.throws(() => parseProcStat('not a proc record'), /invalid proc stat/);
  assert.deepEqual(parseProcNSpid('Name:\tnode\nNSpid:\t700\n'), [700]);
  assert.deepEqual(parseProcNSpid('Name:\tnode\nNSpid:\t700 700\n'), [700, 700]);
});

test('Linux launch identity binds the procfs self PID view and live child handle', async () => {
  const reader = procReader();
  const evidence = await captureProcessIdentity(request(reader));
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.operationId, OPERATION);
  assert.equal(evidence.requestDigest, REQUEST);
  assert.equal(evidence.role, 'target');
  assert.equal(evidence.provenance, 'procfs-self-bound-stable-double-read-and-child-handle-check');
  assert.deepEqual(evidence.identity, { pid: 721, parentPid: 700, processGroupId: 721, sessionId: 721,
    startTicks: 555, bootId: BOOT, pidNamespace: NAMESPACE });
});

for (const [name, fixture, reason] of [
  ['PID changed between reads', { stats: [stat(), stat({ start: 556 })] }, 'identity_changed_or_reaped'],
  ['process already reaped', { stats: [stat({ state: 'Z' }), stat({ state: 'Z' })] }, 'identity_changed_or_reaped'],
  ['wrong parent', { stats: [stat({ parent: 701 }), stat({ parent: 701 })] }, 'parent_identity_mismatch'],
  ['wrong launch session', { stats: [stat({ group: 44 }), stat({ group: 44 })] }, 'launch_session_mismatch'],
  ['boot changed', { boot: [BOOT, 'c9e9c470-dfb0-4bc9-8bc6-b0ee7461077e'] }, 'host_or_namespace_identity_changed'],
  ['target namespace changed', { namespaces: [NAMESPACE, 'pid:[4026533001]'] }, 'host_or_namespace_identity_changed'],
  ['target belongs to another PID namespace', { namespaces: ['pid:[4026533001]', 'pid:[4026533001]'] }, 'target_pid_namespace_mismatch'],
  ['self PID numbering differs from Node', { selfStats: [stat({ pid: 701 }), stat({ pid: 701 })] }, 'supervisor_pid_mapping_mismatch'],
  ['numeric supervisor stat disagrees with procfs self', { supervisorStats: [stat({ pid: 701 }), stat({ pid: 701 })] }, 'supervisor_pid_mapping_mismatch'],
  ['self and numeric supervisor namespaces differ', { supervisorNamespaces: ['pid:[4026533001]', 'pid:[4026533001]'] }, 'supervisor_pid_namespace_mapping_mismatch'],
  ['ancestor procfs has coincident self PID and same-parent/session sibling', {
    selfStatuses: ['Name:\tsupervisor\nNSpid:\t700 700\n', 'Name:\tsupervisor\nNSpid:\t700 700\n'],
    supervisorStatuses: ['Name:\tsupervisor\nNSpid:\t700 700\n', 'Name:\tsupervisor\nNSpid:\t700 700\n'],
    stats: [stat({ start: 999 }), stat({ start: 999 })]
  }, 'supervisor_pid_numbering_unproven'],
  ['target stat PID disagrees with requested PID', { stats: [stat({ pid: 722 }), stat({ pid: 722 })] }, 'target_pid_mapping_mismatch'],
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

for (const platform of ['win32', 'darwin']) test(`${platform} identity remains unknown without native process evidence`, async () => {
  let reads = 0;
  const evidence = await captureProcessIdentity(request({ platform, readText: async () => { reads++; throw new Error(); },
    readLink: async () => { reads++; throw new Error(); } }));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.reason, 'unsupported_platform');
  assert.equal(evidence.adapter.id, 'unsupported');
  assert.equal(reads, 0);
});

test('a same-parent/session replacement before capture stays unknown after the launch handle settles', async () => {
  const launchHandle = { pid: 721, exitCode: 0, signalCode: null };
  let reads = 0;
  const evidence = await captureProcessIdentity(request({ launchHandle,
    ...procReader({ stats: [stat({ start: 999 }), stat({ start: 999 })], afterRead: () => { reads++; } }) }));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.reason, 'launch_handle_not_live');
  assert.equal(reads, 0);
});

test('a same-parent/session replacement between procfs reads remains unknown', async () => {
  const evidence = await captureProcessIdentity(request(procReader({
    stats: [stat({ start: 555 }), stat({ start: 999 })]
  })));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.reason, 'identity_changed_or_reaped');
});

test('a child reaped during procfs observation invalidates the handle-bound identity', async () => {
  const launchHandle = liveHandle();
  const evidence = await captureProcessIdentity(request({ launchHandle, ...procReader({
    stats: [stat({ start: 999 }), stat({ start: 999 })],
    afterRead: filename => { if (filename === PROC_PATHS.targetStat) launchHandle.exitCode = 0; }
  }) }));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.reason, 'launch_handle_not_live');
});

test('native Linux fixture binds the observed identity to a disposable spawned child', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 350)'], { stdio: 'ignore', detached: true });
  let identity;
  child.once('spawn', () => {
    identity = captureProcessIdentity({ operationId: OPERATION, requestDigest: REQUEST, role: 'target', pid: child.pid,
      expectedParentPid: process.pid, launchHandle: child, requireSessionLeader: true });
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
