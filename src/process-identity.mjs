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
 * Observe a process birth identity using a stable procfs double read. For target
 * processes, parent/session checks bind that observation to the supervisor's
 * detached child. This records identity only; it grants no recovery authority.
 */
export async function captureProcessIdentity({ operationId, requestDigest, role, pid, expectedParentPid,
  requireSessionLeader = false, platform = process.platform, arch = process.arch, procRoot = '/proc',
  readText = readFile, readLink = readlink, now = Date.now }) {
  const base = { version: 1, operationId, requestDigest, role, adapter: { id: platform === 'linux' ? 'linux-procfs' : 'unsupported', version: 1, platform, arch } };
  const unknown = reason => ({ ...base, status: 'unknown', reason, observedAt: now() });
  if (platform !== 'linux') return unknown('unsupported_platform');
  if (!uuid(operationId) || typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(requestDigest) ||
      !['supervisor', 'target'].includes(role) || !positive(pid) ||
      (expectedParentPid !== undefined && !positive(expectedParentPid))) return unknown('invalid_observation_request');

  try {
    const statPath = path.join(procRoot, String(pid), 'stat');
    const first = parseProcStat(await readText(statPath, 'utf8'));
    const bootBefore = (await readText(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim().toLowerCase();
    const namespaceBefore = await readLink(path.join(procRoot, String(pid), 'ns/pid'));
    const second = parseProcStat(await readText(statPath, 'utf8'));
    const namespaceAfter = await readLink(path.join(procRoot, String(pid), 'ns/pid'));
    const bootAfter = (await readText(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim().toLowerCase();
    if (identityTuple(first) !== identityTuple(second) || first.state === 'Z' || first.state === 'X' || second.state === 'Z' || second.state === 'X')
      return unknown('identity_changed_or_reaped');
    if (!uuid(bootBefore) || bootBefore !== bootAfter || !/^pid:\[[1-9]\d*\]$/.test(namespaceBefore) || namespaceBefore !== namespaceAfter)
      return unknown('host_or_namespace_identity_changed');
    if (expectedParentPid !== undefined && first.parentPid !== expectedParentPid) return unknown('parent_identity_mismatch');
    if (requireSessionLeader && (first.processGroupId !== pid || first.sessionId !== pid)) return unknown('launch_session_mismatch');
    return { ...base, status: 'verified', provenance: 'procfs-stable-double-read-and-launch-parent-check', observedAt: now(),
      identity: { pid, parentPid: first.parentPid, processGroupId: first.processGroupId, sessionId: first.sessionId,
        startTicks: first.startTicks, bootId: bootBefore, pidNamespace: namespaceBefore } };
  } catch (error) {
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
