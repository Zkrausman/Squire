import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const inspectionLimits = Object.freeze({ sourceBytes: 64 * 1024 * 1024, configBytes: 1024 * 1024,
  captureMs: 2000, stateBytes: 1024 * 1024, rows: 200, fieldBytes: 4096, outputBytes: 256 * 1024 });
export function inspectionError(code) {
  const messages = {
    inspection_input: 'Expected a bounded project config with an id and absolute stateDir; no inspection options are supported.',
    inspection_missing: 'Existing state database is missing; nothing was created.',
    inspection_path: 'Inspection requires regular files, without symbolic links at the selected file paths.',
    inspection_limit: 'Inspection exceeded its fixed size, row or capture-time budget; no partial success is reported.',
    inspection_changed: 'Source changed during capture; no consistent snapshot was obtained. Inspect again later.',
    inspection_journal: 'Rollback journal is present; passive inspection cannot establish a safe snapshot.',
    inspection_unavailable: 'State could not be read consistently; no source recovery or migration was attempted.',
    inspection_cleanup: 'Private snapshot cleanup failed; result withheld. Source state was not modified.',
    inspection_project: 'Requested project is absent from the captured database.'
  };
  return Object.assign(new Error(messages[code]), { code });
}
const fingerprint = s => s && [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
function stat(file) {
  try {
    const s = lstatSync(file, { bigint: true });
    if (!s.isFile()) throw inspectionError('inspection_path');
    return s;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function readBounded(file, before, max, deadline) {
  if (!before || before.size > BigInt(max)) throw inspectionError('inspection_limit');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(before)) throw inspectionError('inspection_changed');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      if (performance.now() > deadline) throw inspectionError('inspection_limit');
      const n = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!n) throw inspectionError('inspection_changed');
      offset += n;
    }
    if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(before) ||
        fingerprint(stat(file)) !== fingerprint(before)) throw inspectionError('inspection_changed');
    return bytes;
  } finally { closeSync(fd); }
}
export function readInspectionConfig(filename) {
  try {
    const value = JSON.parse(readBounded(filename, stat(filename), inspectionLimits.configBytes,
      performance.now() + inspectionLimits.captureMs).toString('utf8'));
    if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id) ||
        typeof value.stateDir !== 'string' || value.stateDir.length > 4096 || value.stateDir.includes('\0') || !path.isAbsolute(value.stateDir))
      throw inspectionError('inspection_input');
    return { id: value.id, stateDir: value.stateDir };
  } catch { throw inspectionError('inspection_input'); }
}

/** Never connect SQLite to the source: even mode=ro can create/write WAL shared
 * memory. Capture only fixed DB/WAL names, checking identity/size/mtime/ctime
 * before and after ALL reads. No retries or immutable=true on a live database.
 * This assumes ordinary local filesystem metadata and cooperative SQLite writers;
 * it does not defend against an actor rewriting files and forging timestamps.
 * Source access times may change as with any read. */
export function withInspectionSnapshot(directory, inspect) {
  let temporary, db;
  try {
    const root = realpathSync(directory), base = path.join(root, 'squire.sqlite');
    const names = [base, `${base}-wal`, `${base}-journal`];
    const before = names.map(stat);
    if (!before[0]) throw inspectionError('inspection_missing');
    if (before[2]) throw inspectionError('inspection_journal');
    const total = before.reduce((n, s) => n + (s?.size ?? 0n), 0n);
    if (total > BigInt(inspectionLimits.sourceBytes)) throw inspectionError('inspection_limit');
    const deadline = performance.now() + inspectionLimits.captureMs;
    const files = before.slice(0, 2).map((s, i) => s ? readBounded(names[i], s, inspectionLimits.sourceBytes, deadline) : null);
    const after = names.map(stat);
    if (realpathSync(directory) !== root || before.some((s, i) => fingerprint(s) !== fingerprint(after[i])))
      throw inspectionError('inspection_changed');
    if (performance.now() > deadline) throw inspectionError('inspection_limit');
    const hash = createHash('sha256');
    for (const bytes of files) { hash.update(`${bytes?.length ?? -1}:`); if (bytes) hash.update(bytes); }
    const capture = { kind: 'stable_private_copy', sha256: hash.digest('hex'), capturedAt: Date.now(), bytes: Number(total) };
    temporary = mkdtempSync(path.join(tmpdir(), 'squire-inspect-'));
    const target = path.join(temporary, 'squire.sqlite');
    writeFileSync(target, files[0], { flag: 'wx', mode: 0o600 });
    if (files[1]) writeFileSync(`${target}-wal`, files[1], { flag: 'wx', mode: 0o600 });
    db = new DatabaseSync(target, { readOnly: true, allowExtension: false, timeout: 1000 });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN');
    const result = inspect(db, capture);
    db.exec('COMMIT');
    if (Buffer.byteLength(JSON.stringify(result)) > inspectionLimits.outputBytes) throw inspectionError('inspection_limit');
    return result;
  } catch (e) {
    if (e.code?.startsWith('inspection_')) throw e;
    if (e.code === 'ENOENT') throw inspectionError('inspection_missing');
    throw inspectionError('inspection_unavailable');
  } finally {
    try {
      try { db?.close(); } finally { if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 }); }
    } catch { throw inspectionError('inspection_cleanup'); }
  }
}
