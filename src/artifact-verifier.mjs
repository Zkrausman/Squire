import {lstat, realpath, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute, resolve, join, parse} from 'node:path';
import {types} from 'node:util';
import {validateJobSpec, closed, own, fail} from './job-spec.mjs';
import {validateArtifactWitness} from './job-record.mjs';

const nativeIO = Object.freeze({lstat, realpath, open});
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'];
const statData = stat => {
  if (!stat || fields.some(key => typeof stat[key] !== 'bigint') ||
      ['isFile', 'isDirectory', 'isSymbolicLink'].some(key => typeof stat[key] !== 'function')) reject('invalid_stat');
  return stat;
};
const sameFile = (a, b) => fields.every(key => a[key] === statData(b)[key]);
const sameDirectory = (a, b) => a.isDirectory() && b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
class RejectedArtifact extends Error {
  constructor(classification) { super(classification); this.classification = classification; }
}
const reject = classification => { throw new RejectedArtifact(classification); };
function classification(error) {
  if (error instanceof RejectedArtifact) return error.classification;
  if (error?.code === 'ENOENT') return 'missing_path';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'unreadable_path';
  if (['ELOOP', 'ENOTDIR'].includes(error?.code)) return 'unsafe_path';
  return 'io_failure';
}

// Physical local inspection only: caller owns and quiesces the staging tree.
// No publication, history import, hardlink store, process or network operation.
export async function verifyArtifacts(specification, options = {}) {
  const spec = validateJobSpec(specification);
  closed(options, [], ['fs', 'signal', 'expected_capture'], 'artifact_options');
  const source = own(options, 'fs') ? options.fs : nativeIO;
  closed(source, ['lstat', 'realpath', 'open'], [], 'artifact_io');
  if (['lstat', 'realpath', 'open'].some(key => typeof source[key] !== 'function')) fail('artifact_io');
  const io = Object.freeze(Object.fromEntries(['lstat', 'realpath', 'open'].map(key => [key, source[key].bind(source)])));
  const signal = options.signal;
  if (signal !== undefined && (!(signal instanceof AbortSignal) || types.isProxy(signal))) fail('signal');
  let expected = null;
  if (own(options, 'expected_capture')) {
    closed(options.expected_capture, ['job_id', 'artifact_witness'], [], 'expected_capture');
    if (options.expected_capture.job_id !== spec.job_id) fail('expected_capture.job_id');
    expected = validateArtifactWitness(options.expected_capture.artifact_witness);
    if (Object.keys(expected).length !== spec.required_artifacts.length || spec.required_artifacts.some(name => !own(expected, name))) fail('expected_capture.artifact_witness');
  }
  const witness = Object.create(null); let currentPath = null;
  const checkAbort = () => { if (signal?.aborted) reject('aborted'); };
  const inspect = async (operation, ...args) => {
    checkAbort(); const value = await operation(...args); checkAbort(); return value;
  };
  const result = (verified, failure = null) => Object.freeze({job_id: spec.job_id, verified,
    artifact_witness: Object.freeze(verified ? witness : Object.create(null)), failure});
  try {
    checkAbort();
    if (!isAbsolute(spec.task_scope) || resolve(spec.task_scope) === parse(spec.task_scope).root) reject('unsafe_root');
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) reject('unsupported_open_flags');
    const root = resolve(spec.task_scope);
    const rootBefore = statData(await inspect(io.lstat, root, {bigint: true}));
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || await inspect(io.realpath, root) !== root) reject('unsafe_root');
    for (const name of spec.required_artifacts) {
      currentPath = name; checkAbort();
      const parts = name.split('/'); const directories = [{path: root, stat: rootBefore}];
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part); const stat = statData(await inspect(io.lstat, parent, {bigint: true}));
        if (!stat.isDirectory() || stat.isSymbolicLink()) reject('unsafe_path');
        directories.push({path: parent, stat});
      }
      const path = join(root, ...parts);
      const before = statData(await inspect(io.lstat, path, {bigint: true}));
      if (!before.isFile() || before.isSymbolicLink() || await inspect(io.realpath, path) !== path) reject('unsafe_path');
      if (before.size <= 0n) reject('empty_artifact');
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) reject('artifact_size_unrepresentable');
      let handle = null, accepted = null;
      try {
        checkAbort();
        handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        checkAbort();
        const opened = statData(await inspect(handle.stat.bind(handle), {bigint: true}));
        if (!opened.isFile() || !sameFile(before, opened)) reject('artifact_changed');
        const size = Number(opened.size); const buffer = Buffer.allocUnsafe(65_536); const hash = createHash('sha256');
        let position = 0;
        while (position < size) {
          checkAbort(); const length = Math.min(buffer.length, size - position);
          const {bytesRead} = await inspect(handle.read.bind(handle), buffer, 0, length, position);
          if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) reject('artifact_changed');
          hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        }
        checkAbort();
        if ((await inspect(handle.read.bind(handle), buffer, 0, 1, position)).bytesRead !== 0) reject('artifact_changed');
        if (!sameFile(opened, await inspect(handle.stat.bind(handle), {bigint: true}))) reject('artifact_changed');
        const after = statData(await inspect(io.lstat, path, {bigint: true}));
        if (!after.isFile() || after.isSymbolicLink() || !sameFile(opened, after)) reject('artifact_changed');
        for (const directory of directories) {
          checkAbort();
          if (!sameDirectory(directory.stat, statData(await inspect(io.lstat, directory.path, {bigint: true})))) reject('directory_changed');
        }
        const entry = Object.freeze({byte_count: position, sha256: hash.digest('hex')});
        if (expected && (expected[name].byte_count !== entry.byte_count || expected[name].sha256 !== entry.sha256)) reject('expected_mismatch');
        accepted = entry;
      } finally {
        if (handle) {
          try { await handle.close(); } catch { reject('close_failed'); }
        }
      }
      checkAbort(); witness[name] = accepted;
    }
    checkAbort(); return result(true);
  } catch (error) {
    return result(false, Object.freeze({classification: classification(error), artifact_path: currentPath}));
  }
}
