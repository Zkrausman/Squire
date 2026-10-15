import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, realpath, rm, symlink, link, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, validateDeclaredInputs, validateExecution, MAX_DECLARED_INPUT_FILE_BYTES, MAX_DECLARED_INPUT_TOTAL_BYTES } from '../src/contracts.mjs';
import { verifyDeclaredInputs } from '../src/declared-inputs.mjs';
import { assertCriterionDefinitions } from '../src/criterion-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestFor = (root, file, bytes) => ({ version: 1, root, files: [{ path: file, sha256: sha(bytes) }] });
const execution = manifest => ({ version: 2, outcome: 'Check declared content', ownedPaths: ['src/'], contextPaths: [],
  invariants: ['Keep current behavior'], checklist: [{ id: 'behavior', assertion: 'Works', steps: ['Run check'], evidence: 'Observed result',
    checks: ['behavior'], evidenceKinds: ['configured-check'] }],
  checkOwnership: [{ check: 'behavior', kind: 'trusted-inline-node', path: null, sha256: 'a'.repeat(64) }],
  stopWhen: 'Stop when blocked', maxAttempts: 2, ...(manifest === undefined ? {} : { declaredInputs: manifest }) });

async function dirs(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'squire-declared-inputs-'));
  const project = path.join(base, 'managed'), inputs = path.join(base, 'inputs');
  await mkdir(project); await mkdir(inputs);
  t.after(async () => {
    const resolved = await realpath(base);
    if (!resolved.startsWith(await realpath(os.tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup path');
    await rm(resolved, { recursive: true, force: true });
  });
  return { base, project, inputs };
}

test('version 2 optionally accepts the strict owner manifest while legacy and planner authority stay unchanged', () => {
  const legacy = execution();
  assert.equal(validateExecution(legacy), legacy);
  assert.equal(Object.hasOwn(legacy, 'declaredInputs'), false);
  const valid = { version: 1, root: '/tmp/owner-inputs', files: [{ path: 'src/helper.mjs', sha256: 'a'.repeat(64) }] };
  assert.equal(validateExecution(execution(valid)).declaredInputs, valid);
  const version1 = execution(); version1.version = 1; delete version1.checkOwnership; version1.declaredInputs = valid;
  assert.throws(() => validateExecution(version1), /Unknown ticket execution field/);
});

test('an explicitly present malformed persisted manifest cannot fall back to entry-only assurance', async t => {
  const f = await dirs(t), check = { name: 'behavior', argv: [process.execPath, '-e', ''], timeoutSeconds: 1 };
  const spec = execution(); spec.declaredInputs = undefined; spec.checkOwnership[0].sha256 = digest(check);
  await assert.rejects(assertCriterionDefinitions(spec, { checks: [check] }, f.project), { code: 'criterion_inputs_invalid' });
});

test('a valid declared manifest verifies with an inline owner check without running that check', async t => {
  const f = await dirs(t), content = Buffer.from('owner-reviewed inline-check fixture');
  await writeFile(path.join(f.inputs, 'helper.txt'), content);
  const check = { name: 'behavior', argv: [process.execPath, '-e', 'throw new Error("must not execute")'], timeoutSeconds: 1 };
  const spec = execution(manifestFor(f.inputs, 'helper.txt', content));
  spec.checkOwnership[0].sha256 = digest(check);
  assert.equal(await assertCriterionDefinitions(spec, { checks: [check] }, f.project), undefined);
});

test('manifest validation rejects malformed, unknown, duplicate, hidden, traversal and unbounded declarations generically', () => {
  const good = { version: 1, root: '/tmp/owner-inputs', files: [{ path: 'src/helper.mjs', sha256: 'a'.repeat(64) }] };
  const invalid = [
    { ...good, extraField: '/private/sentinel-path' },
    { ...good, version: 2 }, { ...good, root: 'relative/dir' }, { ...good, root: '/tmp/owner-inputs/../owner-inputs' },
    { ...good, root: `/tmp/${'r'.repeat(4097)}` },
    { ...good, root: '/tmp/.aws/owner-inputs' }, { ...good, files: [] },
    { ...good, files: Array.from({ length: 33 }, (_, i) => ({ path: `file${i}`, sha256: 'a'.repeat(64) })) },
    { ...good, files: [{ ...good.files[0], extraField: 'hidden-content' }] },
    { ...good, files: [{ path: '../secret', sha256: 'a'.repeat(64) }] },
    { ...good, files: [{ path: `dir/${'f'.repeat(501)}`, sha256: 'a'.repeat(64) }] },
    { ...good, files: [{ path: 'src/.hidden', sha256: 'a'.repeat(64) }] },
    { ...good, files: [{ path: 'src//helper.mjs', sha256: 'a'.repeat(64) }] },
    { ...good, files: [{ path: 'C:/private', sha256: 'a'.repeat(64) }] },
    { ...good, files: [{ path: 'src/helper.mjs', sha256: 'A'.repeat(64) }] },
    { ...good, files: [good.files[0], good.files[0]] }
  ];
  for (const value of invalid) {
    assert.throws(() => validateDeclaredInputs(value), error => {
      assert.equal(error.code, 'invalid_config');
      assert.equal(error.message, 'Invalid declaredInputs manifest');
      assert.equal(error.message.includes('/private/sentinel-path'), false);
      assert.equal(error.message.includes('hidden-content'), false);
      return true;
    });
  }
});

test('verifies exact listed bytes with bounded no-follow reads and fails after a listed helper changes', async t => {
  const f = await dirs(t), content = Buffer.from('owner-reviewed helper content');
  await writeFile(path.join(f.inputs, 'helper.mjs'), content);
  const manifest = manifestFor(f.inputs, 'helper.mjs', content);
  assert.equal(await verifyDeclaredInputs(manifest, f.project), true);
  assert.equal(globalThis.__declaredInputWasExecuted, undefined);
  await writeFile(path.join(f.inputs, 'helper.mjs'), 'changed helper bytes');
  await assert.rejects(verifyDeclaredInputs(manifest, f.project), { code: 'criterion_inputs_changed', message: 'Declared input verification failed; no weaker route is used' });
});

test('missing files, root and file aliases, symlinks, hardlinks and nonregular files fail closed', async t => {
  const f = await dirs(t), content = Buffer.from('fixture');
  const file = path.join(f.inputs, 'helper.mjs'); await writeFile(file, content);
  const valid = manifestFor(f.inputs, 'helper.mjs', content);
  await assert.rejects(verifyDeclaredInputs(manifestFor(f.inputs, 'missing.mjs', content), f.project), { code: 'criterion_inputs_changed' });

  const rootAlias = path.join(f.base, 'root-alias'); await symlink(f.inputs, rootAlias);
  await assert.rejects(verifyDeclaredInputs(manifestFor(rootAlias, 'helper.mjs', content), f.project), { code: 'criterion_inputs_changed' });
  const intermediate = path.join(f.inputs, 'real'); await mkdir(intermediate); await writeFile(path.join(intermediate, 'nested.mjs'), content);
  await symlink(intermediate, path.join(f.inputs, 'alias'));
  await assert.rejects(verifyDeclaredInputs(manifestFor(f.inputs, 'alias/nested.mjs', content), f.project), { code: 'criterion_inputs_changed' });
  const fileAlias = path.join(f.inputs, 'file-alias.mjs'); await symlink(file, fileAlias);
  await assert.rejects(verifyDeclaredInputs(manifestFor(f.inputs, 'file-alias.mjs', content), f.project), { code: 'criterion_inputs_changed' });
  const hardAlias = path.join(f.inputs, 'hard-alias.mjs'); await link(file, hardAlias);
  await assert.rejects(verifyDeclaredInputs(valid, f.project), { code: 'criterion_inputs_changed' });
  await rm(hardAlias);
  await mkdir(path.join(f.inputs, 'directory'));
  await assert.rejects(verifyDeclaredInputs(manifestFor(f.inputs, 'directory', content), f.project), { code: 'criterion_inputs_changed' });
});

test('managed-root overlap is rejected symmetrically, including filesystem root', async t => {
  const f = await dirs(t), content = Buffer.from('fixture');
  const nestedProject = path.join(f.inputs, 'managed'); await mkdir(nestedProject);
  await writeFile(path.join(f.inputs, 'helper.mjs'), content);
  await assert.rejects(verifyDeclaredInputs(manifestFor(f.inputs, 'helper.mjs', content), nestedProject), { code: 'criterion_inputs_changed' });

  const nestedInputs = path.join(f.project, 'inputs'); await mkdir(nestedInputs); await writeFile(path.join(nestedInputs, 'helper.mjs'), content);
  await assert.rejects(verifyDeclaredInputs(manifestFor(nestedInputs, 'helper.mjs', content), f.project), { code: 'criterion_inputs_changed' });
  await assert.rejects(verifyDeclaredInputs(manifestFor('/', 'tmp/fixture', content), f.project), { code: 'criterion_inputs_changed' });
});

test('per-file and aggregate size ceilings are checked before opening any content', async t => {
  const f = await dirs(t), oversized = Buffer.alloc(MAX_DECLARED_INPUT_FILE_BYTES + 1, 7);
  await writeFile(path.join(f.inputs, 'oversized.bin'), oversized);
  const openCalls = { count: 0 };
  const io = { open: async (...args) => { openCalls.count++; return open(...args); }, lstat, realpath };
  await assert.rejects(verifyDeclaredInputs(manifestFor(f.inputs, 'oversized.bin', oversized), f.project, io), { code: 'criterion_inputs_changed' });
  assert.equal(openCalls.count, 0);

  const bytes = Buffer.alloc(1024 * 1024, 9), files = [];
  for (let i = 0; i < 5; i++) {
    const name = `bounded-${i}.bin`; await writeFile(path.join(f.inputs, name), bytes);
    files.push({ path: name, sha256: sha(bytes) });
  }
  assert.equal(MAX_DECLARED_INPUT_TOTAL_BYTES, 4 * 1024 * 1024);
  await assert.rejects(verifyDeclaredInputs({ version: 1, root: f.inputs, files }, f.project, io), { code: 'criterion_inputs_changed' });
  assert.equal(openCalls.count, 0);
});

test('denied reads have a distinct fixed blocker and changed-during-read content is rejected', async t => {
  const f = await dirs(t), file = path.join(f.inputs, 'helper.mjs'), content = Buffer.from('unchanged length');
  await writeFile(file, content);
  const manifest = manifestFor(f.inputs, 'helper.mjs', content);
  const deniedIo = { open: async () => { throw Object.assign(new Error(file), { code: 'EACCES' }); }, lstat, realpath };
  await assert.rejects(verifyDeclaredInputs(manifest, f.project, deniedIo), error => {
    assert.equal(error.code, 'criterion_inputs_denied');
    assert.equal(error.message, 'Declared input verification was denied; no weaker route is used');
    assert.equal(error.message.includes(file), false);
    return true;
  });

  let changed = false;
  const changingIo = { lstat, realpath, open: async (...args) => {
    const handle = await open(...args);
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: async (...readArgs) => {
        if (!changed) { changed = true; await writeFile(file, 'tampered bytes'); }
        return handle.read(...readArgs);
      },
      close: () => handle.close()
    };
  } };
  await assert.rejects(verifyDeclaredInputs(manifest, f.project, changingIo), { code: 'criterion_inputs_changed' });
});
