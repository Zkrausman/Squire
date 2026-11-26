import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';
import {planStaging, writeStage, verifyStage, planLargeProjectStaging,
  writeLargeProjectStage, verifyLargeProjectStage} from '../src/multifile-staging.mjs';
import {verifyExport, verifyLargeProjectExport} from '../src/multifile-export.mjs';

const ports = {fs, uid: process.getuid()};
const cli = name => fileURLToPath(new URL(`../bin/squire-stage-${name}.mjs`, import.meta.url));
const encoder = new TextEncoder();
const files = profile => [
  {path: 'src/example.txt', classification: 'SOURCE', content: profile === 'large'
    ? encoder.encode('x'.repeat(65537)) : encoder.encode('// synthetic\r\n')},
  {path: 'docs/note.md', classification: 'DOC', content: encoder.encode('Café\n')},
  {path: 'assets/mixed.bin', classification: 'LOCAL_ASSET', content: Uint8Array.of(0, 255, 13, 128)},
  {path: 'assets/empty.bin', classification: 'LOCAL_ASSET', content: new Uint8Array()},
];
async function stage(profile, path, id = 'fixture') {
  const spec = {stage_operation_id: id, caller_label: 'synthetic', files: files(profile)};
  return profile === 'large'
    ? writeLargeProjectStage(planLargeProjectStaging({...spec, output_profile: PROJECT_OUTPUT_LARGE_PROFILE}), path, ports)
    : writeStage(planStaging(spec), path, ports);
}
function run(name, args, status = 0) {
  const result = spawnSync(process.execPath, [cli(name), ...args], {encoding: 'utf8', timeout: 10000});
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stderr);
  if (status === 0) assert.equal(result.stderr, '');
  else assert.equal(result.stdout, '');
  return result;
}
function reject(name, args, diagnostic) {
  assert.match(run(name, args, 2).stderr, diagnostic);
}
const verifyArgs = (profile, kind, path, digest) => [profile, kind, path, digest];
const exportArgs = (profile, path, digest, destination, id = 'transfer') =>
  [profile, path, digest, id, 'synthetic', destination];
async function root(t) {
  const dir = await fs.mkdtemp('/tmp/squire-profile-transfer-');
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
async function snapshot(dir) {
  const result = [];
  async function visit(path, rel = '') {
    const stat = await fs.lstat(path);
    result.push({rel, inode: stat.ino, mode: stat.mode, bytes: stat.isFile() ? await fs.readFile(path) : null});
    if (stat.isDirectory()) for (const name of (await fs.readdir(path)).sort()) {
      await visit(join(path, name), join(rel, name));
    }
  }
  await visit(dir);
  return result;
}
for (const profile of ['standard', 'large']) {
  test(`${profile} transfer preserves all bytes and independently verifies selected stage and export copies`, async t => {
    const dir = await root(t);
    const source = join(dir, 'stage'), destination = join(dir, 'export');
    const staged = await stage(profile, source);
    const original = await snapshot(source);
    const result = JSON.parse(run('export', exportArgs(profile, source, staged.manifest_sha256, destination)).stdout);
    const verifyStageLibrary = profile === 'large' ? verifyLargeProjectStage : verifyStage;
    const verifyExportLibrary = profile === 'large' ? verifyLargeProjectExport : verifyExport;
    const exported = await verifyExportLibrary(destination, ports);
    assert.equal(exported.status, 'VERIFIED');
    assert.deepEqual(exported.stage_binding, {stage_operation_id: staged.stage_operation_id,
      stage_manifest_sha256: staged.manifest_sha256});
    const total = files(profile).reduce((n, f) => n + f.content.length, 0);
    assert.deepEqual(result, {operation_acknowledgement: 'ACKNOWLEDGED', manifest_sha256: exported.manifest_sha256,
      total_files: 4, total_bytes: total});
    assert.deepEqual((await fs.readdir(destination)).sort(), ['export-manifest.json', 'project']);
    assert.deepEqual(await snapshot(source), original);
    assert.equal((await verifyStageLibrary(source, ports)).manifest_sha256, staged.manifest_sha256);
    for (const [kind, path, digest] of [['stage', source, staged.manifest_sha256],
      ['export', destination, result.manifest_sha256]]) {
      const copied = join(dir, `copied-${kind}`);
      await fs.cp(path, copied, {recursive: true, errorOnExist: true, force: false});
      const before = await snapshot(copied);
      assert.notEqual((await fs.stat(copied)).ino, (await fs.stat(path)).ino);
      assert.deepEqual(JSON.parse(run('verify', verifyArgs(profile, kind, copied, digest)).stdout), {
        profile, kind, status: 'VERIFIED', manifest_sha256: digest, total_files: 4, total_bytes: total,
        original_operation_acknowledgement: 'UNKNOWN', provenance_authenticity: 'NOT_ESTABLISHED',
        crash_durability: 'NOT_ESTABLISHED',
      });
      assert.deepEqual(await snapshot(copied), before);
      for (const entry of files(profile)) {
        const path = kind === 'export' ? join(copied, 'project', entry.path) : join(copied, entry.path);
        assert.deepEqual(await fs.readFile(path), Buffer.from(entry.content));
      }
    }
  });
  test(`${profile} receiver rejects swapped, wrong-profile, wrong-kind, same-size changed and extra-inventory copies`, async t => {
    const dir = await root(t);
    const source = join(dir, 'stage'), second = join(dir, 'second'), destination = join(dir, 'export');
    const first = await stage(profile, source);
    const other = await stage(profile, second, 'other-fixture');
    assert.notEqual(first.manifest_sha256, other.manifest_sha256);
    const exported = JSON.parse(run('export', exportArgs(profile, source, first.manifest_sha256, destination)).stdout);
    const secondExport = join(dir, 'other-export');
    run('export', exportArgs(profile, second, other.manifest_sha256, secondExport));
    for (const [kind, path, swapped, digest] of [['stage', source, second, first.manifest_sha256],
      ['export', destination, secondExport, exported.manifest_sha256]]) {
      const snapshotBefore = await snapshot(swapped);
      reject('verify', verifyArgs(profile, kind, swapped, digest), /^MANIFEST_BINDING_MISMATCH\n$/);
      assert.deepEqual(await snapshot(swapped), snapshotBefore);
      reject('verify', verifyArgs(profile === 'large' ? 'standard' : 'large', kind, path, digest), /^CORRUPT_OR_INCOMPLETE\n$/);
      reject('verify', verifyArgs(profile, kind === 'stage' ? 'export' : 'stage', path, digest), /^CORRUPT_OR_INCOMPLETE\n$/);
      reject('verify', verifyArgs(profile, kind, path, digest + '\n'), /^INVALID_EXPECTED_MANIFEST_SHA256\n$/);
      const tampered = join(dir, `tampered-${kind}`);
      await fs.cp(path, tampered, {recursive: true});
      const leaf = join(tampered, ...(kind === 'export' ? ['project'] : []), 'assets/mixed.bin');
      await fs.chmod(leaf, 0o600);
      await fs.writeFile(leaf, Uint8Array.of(0, 254, 13, 128));
      await fs.chmod(leaf, 0o400);
      let before = await snapshot(tampered);
      reject('verify', verifyArgs(profile, kind, tampered, digest), /^CORRUPT_OR_INCOMPLETE\n$/);
      assert.deepEqual(await snapshot(tampered), before);
      const extra = join(dir, `extra-${kind}`);
      await fs.cp(path, extra, {recursive: true});
      await fs.writeFile(join(extra, 'undeclared.txt'), 'synthetic', {mode: 0o400});
      before = await snapshot(extra);
      reject('verify', verifyArgs(profile, kind, extra, digest), /^CORRUPT_OR_INCOMPLETE\n$/);
      assert.deepEqual(await snapshot(extra), before);
    }
    const occupied = join(dir, 'occupied');
    await fs.mkdir(occupied, {mode: 0o700});
    await fs.writeFile(join(occupied, 'sentinel'), 'preserve');
    const before = await snapshot(occupied);
    reject('export', exportArgs(profile, source, first.manifest_sha256, occupied), /^DESTINATION_ALREADY_EXISTS\n$/);
    assert.deepEqual(await snapshot(occupied), before);
    const wrong = join(dir, 'wrong-profile');
    reject('export', exportArgs(profile === 'large' ? 'standard' : 'large', source, first.manifest_sha256, wrong), /^[A-Z_]+\n$/);
    assert.deepEqual(await fs.readdir(wrong), []);
    const swapped = join(dir, 'swapped-source');
    reject('export', exportArgs(profile, second, first.manifest_sha256, swapped), /^STAGE_BINDING_MISMATCH\n$/);
    assert.deepEqual(await fs.readdir(swapped), []);
    const unused = join(dir, 'unused');
    reject('export', [...exportArgs(profile, source, first.manifest_sha256, unused), 'extra'], /^Usage:/);
    await assert.rejects(fs.lstat(unused), {code: 'ENOENT'});
  });
}

test('large-only SOURCE cannot be staged by standard and explicit CLI selection never falls back', async t => {
  const dir = await root(t);
  assert.throws(() => planStaging({stage_operation_id: 'fixture', caller_label: 'synthetic', files: files('large')}),
    {code: 'CAPACITY_EXCEEDED'});
  const source = join(dir, 'stage'), destination = join(dir, 'export');
  const staged = await stage('large', source);
  reject('export', [source, staged.manifest_sha256, 'legacy', 'synthetic', destination], /^[A-Z_]+\n$/);
  assert.deepEqual(await fs.readdir(destination), []);
  const unused = join(dir, 'unused');
  reject('export', exportArgs('AUTO', source, staged.manifest_sha256, unused), /^Usage:/);
  await assert.rejects(fs.lstat(unused), {code: 'ENOENT'});
  reject('verify', verifyArgs('AUTO', 'stage', source, staged.manifest_sha256), /^Usage:/);
  reject('verify', verifyArgs('large', 'other', source, staged.manifest_sha256), /^Usage:/);
  reject('verify', verifyArgs('large', 'stage', '.', staged.manifest_sha256), /^Usage:/);
});

test('stage transfer CLI help and imports remain inert', () => {
  for (const name of ['export', 'verify']) {
    assert.match(run(name, ['--help']).stdout, /^Usage:/);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(new URL(`../bin/squire-stage-${name}.mjs`, import.meta.url).href)})`],
    {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
