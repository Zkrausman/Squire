import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Parse Linux /proc/<pid>/stat without splitting the parenthesized comm field. */
export function parseProcStat(text) {
  if (typeof text !== 'string') throw new TypeError('invalid proc stat');
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open <= 0 || close <= open || !/^\d+$/.test(text.slice(0, open).trim())) throw new TypeError('invalid proc stat');
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const integer = index => {
    if (!/^-?\d+$/.test(fields[index] ?? '')) throw new TypeError('invalid proc stat');
    const value = Number(fields[index]);
    if (!Number.isSafeInteger(value)) throw new TypeError('invalid proc stat');
    return value;
  };
  if (!positive(pid) || fields[0]?.length !== 1) throw new TypeError('invalid proc stat');
  // Fields after comm begin at field 3: state. starttime is field 22.
  const startTicks = integer(19);
  if (!positive(startTicks)) throw new TypeError('invalid proc stat');
  return { pid, state: fields[0], parentPid: integer(1), processGroupId: integer(2), sessionId: integer(3), startTicks };
}

const identityTuple = value => [value.pid, value.parentPid, value.processGroupId, value.sessionId, value.startTicks].join(':');
const errorReason = error => error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission_denied' :
  error?.code === 'ENOENT' || error?.code === 'ESRCH' ? 'process_missing_or_reaped' : 'identity_read_failed';

export function unknownProcessIdentity({ operationId, requestDigest, role, platform = process.platform, arch = process.arch }, reason) {
  return { version: 1, operationId, requestDigest, role, status: 'unknown', reason,
    adapter: { id: platform === 'linux' ? 'linux-procfs' : 'unsupported', version: 1, platform, arch }, observedAt: Date.now() };
}

/**
 * Observe a process birth identity using a stable procfs double read. The procfs
 * self alias is checked against the numeric PID used by Node before any numeric
 * observation is trusted. Target reads also remain bound to the still-live
 * ChildProcess handle across every asynchronous read. This records identity
 * only; it grants no recovery authority.
 */
export async function captureProcessIdentity({ operationId, requestDigest, role, pid, expectedParentPid, launchHandle,
  requireSessionLeader = false, platform = process.platform, arch = process.arch, procRoot = '/proc',
  readText = readFile, readLink = readlink, now = Date.now }) {
  const base = { version: 1, operationId, requestDigest, role, adapter: { id: platform === 'linux' ? 'linux-procfs' : 'unsupported', version: 1, platform, arch } };
  const unknown = reason => ({ ...base, status: 'unknown', reason, observedAt: now() });
  if (platform !== 'linux') return unknown('unsupported_platform');
  const selfPid = role === 'target' ? expectedParentPid : pid;
  const targetHandleLive = () => role !== 'target' ||
    (launchHandle && launchHandle.pid === pid && launchHandle.exitCode === null && launchHandle.signalCode === null);
  if (!uuid(operationId) || typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(requestDigest) ||
      !['supervisor', 'target'].includes(role) || !positive(pid) ||
      !positive(selfPid) || (role === 'target' && (!positive(expectedParentPid) || !launchHandle)))
    return unknown('invalid_observation_request');
  if (!targetHandleLive()) return unknown('launch_handle_not_live');

  try {
    const checkedText = async filename => {
      if (!targetHandleLive()) throw Object.assign(new Error('target handle settled'), { identityReason: 'launch_handle_not_live' });
      const value = await readText(filename, 'utf8');
      if (!targetHandleLive()) throw Object.assign(new Error('target handle settled'), { identityReason: 'launch_handle_not_live' });
      return value;
    };
    const checkedLink = async filename => {
      if (!targetHandleLive()) throw Object.assign(new Error('target handle settled'), { identityReason: 'launch_handle_not_live' });
      const value = await readLink(filename);
      if (!targetHandleLive()) throw Object.assign(new Error('target handle settled'), { identityReason: 'launch_handle_not_live' });
      return value;
    };
    const stat = async filename => parseProcStat(await checkedText(filename));
    const selfStatPath = path.join(procRoot, 'self/stat');
    const selfNamespacePath = path.join(procRoot, 'self/ns/pid');
    const numericSelfStatPath = path.join(procRoot, String(selfPid), 'stat');
    const numericSelfNamespacePath = path.join(procRoot, String(selfPid), 'ns/pid');
    const selfFirst = await stat(selfStatPath);
    const numericSelfFirst = await stat(numericSelfStatPath);
    const selfNamespaceBefore = await checkedLink(selfNamespacePath);
    const numericSelfNamespaceBefore = await checkedLink(numericSelfNamespacePath);

    const statPath = path.join(procRoot, String(pid), 'stat');
    const first = await stat(statPath);
    const bootBefore = (await checkedText(path.join(procRoot, 'sys/kernel/random/boot_id'))).trim().toLowerCase();
    const namespaceBefore = await checkedLink(path.join(procRoot, String(pid), 'ns/pid'));
    const second = await stat(statPath);
    const namespaceAfter = await checkedLink(path.join(procRoot, String(pid), 'ns/pid'));
    const bootAfter = (await checkedText(path.join(procRoot, 'sys/kernel/random/boot_id'))).trim().toLowerCase();

    const numericSelfSecond = await stat(numericSelfStatPath);
    const selfSecond = await stat(selfStatPath);
    const numericSelfNamespaceAfter = await checkedLink(numericSelfNamespacePath);
    const selfNamespaceAfter = await checkedLink(selfNamespacePath);
    if (!targetHandleLive()) return unknown('launch_handle_not_live');

    if (selfFirst.pid !== selfPid || numericSelfFirst.pid !== selfPid ||
        identityTuple(selfFirst) !== identityTuple(numericSelfFirst) ||
        identityTuple(selfFirst) !== identityTuple(selfSecond) || identityTuple(numericSelfFirst) !== identityTuple(numericSelfSecond))
      return unknown('supervisor_pid_mapping_mismatch');
    if (!/^pid:\[[1-9]\d*\]$/.test(selfNamespaceBefore) || selfNamespaceBefore !== numericSelfNamespaceBefore ||
        selfNamespaceBefore !== selfNamespaceAfter || numericSelfNamespaceBefore !== numericSelfNamespaceAfter)
      return unknown('supervisor_pid_namespace_mapping_mismatch');
    if (identityTuple(first) !== identityTuple(second) || first.state === 'Z' || first.state === 'X' || second.state === 'Z' || second.state === 'X')
      return unknown('identity_changed_or_reaped');
    if (first.pid !== pid) return unknown('target_pid_mapping_mismatch');
    if (!uuid(bootBefore) || bootBefore !== bootAfter || !/^pid:\[[1-9]\d*\]$/.test(namespaceBefore) || namespaceBefore !== namespaceAfter)
      return unknown('host_or_namespace_identity_changed');
    if (namespaceBefore !== selfNamespaceBefore) return unknown('target_pid_namespace_mismatch');
    if (expectedParentPid !== undefined && first.parentPid !== expectedParentPid) return unknown('parent_identity_mismatch');
    if (requireSessionLeader && (first.processGroupId !== pid || first.sessionId !== pid)) return unknown('launch_session_mismatch');
    return { ...base, status: 'verified', provenance: 'procfs-self-bound-stable-double-read-and-child-handle-check', observedAt: now(),
      identity: { pid, parentPid: first.parentPid, processGroupId: first.processGroupId, sessionId: first.sessionId,
        startTicks: first.startTicks, bootId: bootBefore, pidNamespace: namespaceBefore } };
  } catch (error) {
    if (error?.identityReason) return unknown(error.identityReason);
    return unknown(error instanceof TypeError ? 'malformed_os_identity' : errorReason(error));
  }
}

export function sameProcessIdentity(left, right) {
  return left?.status === 'verified' && right?.status === 'verified' &&
    left.operationId === right.operationId && left.requestDigest === right.requestDigest && left.role === right.role &&
    left.identity.pid === right.identity.pid && left.identity.startTicks === right.identity.startTicks &&
    left.identity.bootId === right.identity.bootId && left.identity.pidNamespace === right.identity.pidNamespace &&
    left.identity.processGroupId === right.identity.processGroupId && left.identity.sessionId === right.identity.sessionId;
}
