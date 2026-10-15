import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, link, lstat, mkdir, mkdtemp, open, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDeliveryEvidence } from '../src/delivery-evidence.mjs';

const LIMIT = 128 * 1024;
const scopeId = '11111111-1111-4111-8111-111111111111';
const fileName = '22222222-2222-4222-8222-222222222222.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, bytes = Buffer.from(JSON.stringify({
  version: 1, identity: { scopeId }, fact: { kind: 'publication.intent' }, operations: [], previous: null
}))) {
  const root = await mkdtemp(path.join(tmpdir(), 'squire-receipt-reader-'));
  const directory = path.join(root, 'delivery-evidence', scopeId);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, fileName);
  await writeFile(file, bytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root, directory, file, bytes,
    ref: { scopeId, file: fileName, bytes: bytes.length, sha256: hash(bytes) }
  };
}

function withBeforeRead(change, onRead = () => {}) {
  let changed = false;
  return {
    lstat,
    async open(file, flags) {
      assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR), 0);
      assert.ok(flags & constants.O_NOFOLLOW);
      assert.ok(flags & constants.O_NONBLOCK);
      const handle = await open(file, flags);
      return {
        stat: options => handle.stat(options),
        async read(...args) {
          if (!changed) { changed = true; await change(file); }
          const result = await handle.read(...args);
          onRead(args[0], args[2], args[3], result.bytesRead);
          return result;
        },
        close: () => handle.close()
      };
    }
  };
}

test('reads at the 128 KiB bound and allocates/requests no more than the validated length', async t => {
  const prefix = Buffer.from('{"version":1,"identity":{"scopeId":"' + scopeId + '"},"fact":{"kind":"ok"},"operations":[],"pad":"');
  const suffix = Buffer.from('"}');
  const bytes = Buffer.concat([prefix, Buffer.alloc(LIMIT - prefix.length - suffix.length, 120), suffix]);
  const f = await fixture(t, bytes);
  let actual = 0;
  const io = withBeforeRead(async () => {}, (buffer, _length, position, bytesRead) => {
    assert.equal(buffer.length, LIMIT);
    assert.ok(position + bytesRead <= f.ref.bytes);
    actual += bytesRead;
    assert.ok(actual <= LIMIT);
  });
  const result = await readDeliveryEvidence(f.root, f.ref, {}, io);
  assert.equal(result.fact.kind, 'ok');
  assert.equal(actual, LIMIT);
});

test('rejects file growth during the bounded read', async t => {
  const f = await fixture(t);
  let actual = 0;
  const io = withBeforeRead(file => appendFile(file, 'x'), (_buffer, _length, _position, bytesRead) => { actual += bytesRead; });
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, io), { code: 'delivery_evidence_incomplete' });
  assert.ok(actual <= f.ref.bytes);
});

test('rejects file shrink during the bounded read', async t => {
  const f = await fixture(t);
  const io = withBeforeRead(file => truncate(file, 0));
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, io), { code: 'delivery_evidence_incomplete' });
});

test('rejects replacement of the final path after opening the original inode', async t => {
  const f = await fixture(t);
  const replacement = path.join(f.directory, 'replacement.json');
  await writeFile(replacement, f.bytes);
  const io = {
    lstat,
    async open(file, flags) {
      const handle = await open(file, flags);
      await rename(replacement, file);
      return handle;
    }
  };
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, io), { code: 'delivery_evidence_incomplete' });
});

test('accepts bounded partial reads and closes the handle on read failure', async t => {
  const f = await fixture(t);
  let readCalls = 0, closed = false;
  const io = {
    lstat,
    async open(file, flags) {
      const opened = await open(file, flags);
      return {
        stat: options => opened.stat(options),
        async read(buffer, offset, length, position) {
          readCalls++;
          return opened.read(buffer, offset, Math.min(length, 7), position);
        },
        close: async () => { closed = true; await opened.close(); }
      };
    }
  };
  const value = await readDeliveryEvidence(f.root, f.ref, {}, io);
  assert.equal(value.fact.kind, 'publication.intent');
  assert.ok(readCalls > 1);
  assert.equal(closed, true);

  let failedReadClosed = false;
  const failing = {
    lstat,
    async open(file, flags) {
      const opened = await open(file, flags);
      return {
        stat: options => opened.stat(options),
        async read() { throw new Error(`read failed ${file} PRIVATE`); },
        close: async () => { failedReadClosed = true; await opened.close(); }
      };
    }
  };
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, failing), { code: 'delivery_evidence_incomplete' });
  assert.equal(failedReadClosed, true);
});

test('rejects replacement of the selected scope directory during reading', async t => {
  const f = await fixture(t);
  const displaced = path.join(path.dirname(f.directory), 'displaced-scope');
  let scopeChecks = 0;
  const io = {
    async lstat(file, options) {
      if (file === f.directory && ++scopeChecks === 2) {
        await rename(f.directory, displaced);
        await mkdir(f.directory);
      }
      return lstat(file, options);
    },
    open
  };
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, io), { code: 'delivery_evidence_incomplete' });
});

test('rejects symlinks and files with multiple hard links', async t => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.root), `${path.basename(f.root)}-outside`);
  await writeFile(outside, f.bytes);
  try {
    await rm(f.file);
    await symlink(outside, f.file);
    await assert.rejects(readDeliveryEvidence(f.root, f.ref), { code: 'delivery_evidence_incomplete' });
    await rm(f.file);
    await link(outside, f.file);
    await assert.rejects(readDeliveryEvidence(f.root, f.ref), { code: 'delivery_evidence_incomplete' });
  } finally {
    await rm(outside, { force: true });
  }
});

test('sanitizes missing and denied read failures without exposing raw paths or content', async t => {
  const f = await fixture(t);
  await rm(f.file);
  await assert.rejects(readDeliveryEvidence(f.root, f.ref), error => {
    assert.equal(error.code, 'delivery_evidence_incomplete');
    assert.equal(error.message, 'Delivery evidence is incomplete; no replay or settlement is authorized');
    assert.ok(!error.message.includes(f.root));
    return true;
  });
  const io = {
    lstat,
    async open(file) {
      const error = new Error(`denied ${file} SECRET_RECEIPT_CONTENT`);
      error.code = 'EACCES';
      throw error;
    }
  };
  // Recreate the expected path so the injected open failure is reached.
  await writeFile(f.file, f.bytes);
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, io), error => {
    assert.equal(error.code, 'delivery_evidence_incomplete');
    assert.equal(error.message, 'Delivery evidence is incomplete; no replay or settlement is authorized');
    assert.ok(!error.message.includes(f.root));
    assert.ok(!error.message.includes('SECRET_RECEIPT_CONTENT'));
    return true;
  });
});

test('allows a sibling scope directory entry change while checking the selected layout identity', async t => {
  const f = await fixture(t);
  const evidenceRoot = path.dirname(f.directory);
  const sibling = path.join(evidenceRoot, '33333333-3333-4333-8333-333333333333');
  const io = withBeforeRead(async () => mkdir(sibling, { mode: 0o700 }));
  const result = await readDeliveryEvidence(f.root, f.ref, {}, io);
  assert.equal(result.fact.kind, 'publication.intent');
  assert.equal((await lstat(sibling)).isDirectory(), true);
});

test('rejects a valid 131,073-byte receipt with matching reference before opening', async t => {
  const value = { version: 1, identity: { scopeId }, fact: { kind: 'publication.intent' }, operations: [], previous: null };
  const bytes = Buffer.alloc(131_073, 32);
  bytes.write(JSON.stringify(value));
  const f = await fixture(t, bytes);
  assert.equal(f.ref.bytes, 131_073);
  assert.equal((await lstat(f.file)).size, 131_073);
  assert.deepEqual(JSON.parse(f.bytes), value);
  let opened = false;
  const io = { lstat, async open(...args) { opened = true; return open(...args); } };
  await assert.rejects(readDeliveryEvidence(f.root, f.ref, {}, io), { code: 'delivery_evidence_incomplete' });
  assert.equal(opened, false);
});
