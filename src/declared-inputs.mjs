import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Blocker, MAX_DECLARED_INPUT_FILE_BYTES, MAX_DECLARED_INPUT_TOTAL_BYTES, validateDeclaredInputs } from './contracts.mjs';

const statKey = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
const within = (candidate, root) => {
  const relative = path.posix.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
};
const overlaps = (a, b) => within(a, b) || within(b, a);
const changed = () => new Blocker('criterion_inputs_changed', 'Declared input verification failed; no weaker route is used');

function failFor(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) return new Blocker('criterion_inputs_denied', 'Declared input verification was denied; no weaker route is used');
  return changed();
}

async function metadata(file, io) {
  const stat = await io.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_DECLARED_INPUT_FILE_BYTES)) throw changed();
  return stat;
}

async function readFrozen(file, expected, io) {
  const before = await metadata(file, io);
  if (statKey(before) !== statKey(expected)) throw changed();
  const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || statKey(opened) !== statKey(expected)) throw changed();
    const bytes = Buffer.alloc(Number(expected.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (statKey(await handle.stat({ bigint: true })) !== statKey(expected) ||
        statKey(await io.lstat(file, { bigint: true })) !== statKey(expected)) throw changed();
    return bytes;
  } finally { await handle.close(); }
}

// This checks only an explicit owner manifest. It never discovers, imports or
// executes files. The injected filesystem is for deterministic denial/race tests.
export async function verifyDeclaredInputs(manifest, projectRoot, io = { open, lstat, realpath }) {
  try { validateDeclaredInputs(manifest); }
  catch { throw new Blocker('criterion_inputs_invalid', 'Declared input manifest is invalid'); }
  try {
    const root = manifest.root;
    const canonicalRoot = await io.realpath(root);
    if (canonicalRoot !== root) throw changed();
    const rootStat = await io.lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw changed();
    const canonicalProjectRoot = await io.realpath(projectRoot);
    if (overlaps(canonicalRoot, canonicalProjectRoot)) throw changed();

    const files = [];
    let aggregate = 0n;
    for (const entry of manifest.files) {
      const file = path.posix.join(root, entry.path);
      const resolved = await io.realpath(file);
      if (resolved !== file || !within(resolved, root) || resolved === root) throw changed();
      const stat = await metadata(file, io);
      aggregate += stat.size;
      if (aggregate > BigInt(MAX_DECLARED_INPUT_TOTAL_BYTES)) throw changed();
      files.push({ file, entry, stat });
    }

    let readTotal = 0n;
    for (const item of files) {
      readTotal += item.stat.size;
      if (readTotal > BigInt(MAX_DECLARED_INPUT_TOTAL_BYTES)) throw changed();
      const bytes = await readFrozen(item.file, item.stat, io);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== item.entry.sha256) throw changed();
    }
    for (const item of files) {
      if (statKey(await io.lstat(item.file, { bigint: true })) !== statKey(item.stat) || await io.realpath(item.file) !== item.file) throw changed();
    }
    if (await io.realpath(root) !== root) throw changed();
    return true;
  } catch (error) {
    if (error instanceof Blocker) throw error;
    throw failFor(error);
  }
}
