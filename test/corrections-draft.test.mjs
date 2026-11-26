import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyProjectCandidateReviewPackage} from '../src/project-candidate-review-package.mjs';
import {runProjectReviewCandidateCli} from '../bin/squire-project-review.mjs';

const script = fileURLToPath(new URL('../bin/squire-corrections-draft.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const side = bytes => ({mode: '100644', bytes: bytes.length, sha256: sha(bytes),
  git_sha1: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ?
  Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : x;
const prepared = {status: 0, stdout: 'PROJECT_CORRECTIONS_DRAFT_PREPARED\n', stderr: ''};
const rejected = {status: 2, stdout: '', stderr: 'PROJECT_CORRECTIONS_DRAFT_REJECTED\n'};
function run(...args) {
  const {status, stdout, stderr, error} = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  if (error) throw error;
  return {status, stdout, stderr};
}
async function fixture(t, marker = '5') {
  const root = await fs.mkdtemp(join(tmpdir(), 'squire-corrections-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const pkg = join(root, 'original-package');
  // Fixed synthetic package, independently encoded in the original V1 wire
  // format. No Git repository, candidate creation, or decision operation.
  const samples = [
    {path: 'assets/add.bin', old: null, next: Buffer.from([0, 1, 255]), edited: Buffer.from([0, 2, 255])},
    {path: 'docs/replace.md', old: Buffer.from('base\n'), next: Buffer.from('candidate\n'), edited: Buffer.from('owner\n')},
    {path: 'docs/third.md', old: null, next: Buffer.from('third\n'), edited: Buffer.from('third edited\n')},
  ];
  await fs.mkdir(pkg, {mode: 0o700});
  await fs.mkdir(join(pkg, 'changes'), {mode: 0o700});
  for (const sub of ['assets', 'docs']) await fs.mkdir(join(pkg, 'changes', sub), {mode: 0o700});
  let diff = 'SQUIRE_FULL_CHANGED_CONTENT_V1\n';
  const paths = [];
  for (const s of samples) {
    const old = s.old && side(s.old), next = side(s.next), binary = s.path.endsWith('.bin');
    paths.push({path: s.path, old, new: next, binary_review_required: binary});
    diff += `path ${JSON.stringify(s.path)}\nold ${old?.git_sha1 ?? 'ABSENT'}\nnew ${next.git_sha1}\n`;
    if (binary) diff += 'BINARY_REVIEW_REQUIRED; inspect exact .old/.new copies\n';
    else {
      if (s.old) diff += `- ${JSON.stringify(s.old.toString())}\n`;
      diff += `+ ${JSON.stringify(s.next.toString())}\n`;
    }
    if (s.old) await fs.writeFile(join(pkg, 'changes', s.path + '.old'), s.old, {mode: 0o400});
    await fs.writeFile(join(pkg, 'changes', s.path + '.new'), s.next, {mode: 0o400});
    s.file = join(root, `replacement-${samples.indexOf(s)}`);
    await fs.writeFile(s.file, s.edited, {mode: 0o400});
  }
  const manifest = {schema: 'SQUIRE_PROJECT_CANDIDATE_REVIEW_PACKAGE_V1',
    input_result_sha256: marker.repeat(64), candidate_ref: 'refs/heads/candidate-fixture',
    base_commit: '1'.repeat(40), base_tree: '2'.repeat(40), candidate_commit: '3'.repeat(40), candidate_tree: '4'.repeat(40),
    changed_paths: paths.map(x => x.path), paths, diff: {bytes: Buffer.byteLength(diff), sha256: sha(diff)},
    boundaries: ['SOURCE_REVIEW_PENDING', 'TASK_CORRECTNESS_NOT_EVALUATED', 'ORIGIN_SUPPLIED_NOT_AUTHENTICATED']};
  const encoded = Buffer.from(JSON.stringify(sorted(manifest)));
  const digest = sha(encoded);
  await fs.writeFile(join(pkg, 'review-manifest.json'), encoded, {mode: 0o400});
  await fs.writeFile(join(pkg, 'diff.txt'), diff, {mode: 0o400});
  const result = await verifyProjectCandidateReviewPackage(pkg, {}, digest);
  assert.equal(result.manifest_sha256, digest);
  const args = [samples[1].path, samples[1].file, samples[0].path, samples[0].file];
  return {root, pkg, digest, manifest, samples, args, destination: join(root, 'corrections.json')};
}

function expectedRow(s) {
  const witness = side(s.next);
  return {path: s.path, original: {blob: witness.git_sha1, bytes: witness.bytes, sha256: witness.sha256}, content_path: s.file};
}

test('draft uses verified candidate witnesses for an addition and replacement; both CLI revision routes read the supplied array', async t => {
  const f = await fixture(t);
  for (const profile of ['standard', 'large']) {
    const destination = join(f.root, profile + '.json');
    assert.deepEqual(run(profile, f.pkg, f.digest, destination, ...f.args), prepared);
    const rows = JSON.parse(await fs.readFile(destination));
    assert.deepEqual(rows, f.samples.slice(0, 2).map(expectedRow));
    assert.notEqual(rows[1].original.blob, side(f.samples[1].old).git_sha1);
    assert.equal((await fs.stat(destination)).mode & 0o7777, 0o600);
    // Exercise only the existing revision CLI's intake, with an inert adapter.
    // Its actual revision builder is never invoked, nor is a decision recorded.
    const schema = profile === 'standard' ? 'SQUIRE_STANDARD_PROJECT_REVIEW_' : 'SQUIRE_PROJECT_REVIEW_';
    const original = {schema: schema + 'IMPORT_V1', operation_id: 'revision', caller_label: 'fixture',
      receipt_path: join(f.root, 'receipt'), receipt_sha256: '5'.repeat(64), stage_dir: join(f.root, 'stage'),
      stage_manifest_sha256: '6'.repeat(64), snapshot_dir: join(f.root, 'snapshot'), base_git_dir: join(f.root, 'base'),
      base_git_identity: {dev: 1, ino: 2}, base_commit: f.manifest.base_commit, base_tree: f.manifest.base_tree,
      candidate_dir: join(f.root, 'candidate'), allowed_changes: f.samples.slice(0, 2).map(s => ({path: s.path,
        original: s.old ? {blob: side(s.old).git_sha1, bytes: s.old.length, sha256: sha(s.old)} : null}))};
    const prior_candidate = {git_dir: join(f.root, 'prior'), identity: {dev: 1, ino: 3}, operation_id: 'fixture',
      commit: f.manifest.candidate_commit, tree: f.manifest.candidate_tree};
    const spec = {schema: schema + 'REVISION_V1', original, prior_candidate, corrections: rows};
    const specPath = join(f.root, profile + '-spec.json');
    await fs.writeFile(specPath, JSON.stringify(spec), {mode: 0o400});
    let captured, unexpected = 0;
    const forbidden = async () => { unexpected++; throw new Error('unexpected build route'); };
    const inspect = async value => {
      captured = value.corrections.map(c => ({...c, original: {...c.original}, bytes_data: Buffer.from(c.bytes_data)}));
      // Deliberately stop at the adapter boundary, before any real build.
      throw new Error('inert intake stop');
    };
    const ports = {readReceiptBytes: async path => Uint8Array.from(path === specPath ? await fs.readFile(specPath) : [1]),
      build: forbidden, buildStandard: forbidden,
      revise: profile === 'large' ? inspect : forbidden, reviseStandard: profile === 'standard' ? inspect : forbidden,
      stdout: {write() {}}, stderr: {write() {}}};
    assert.equal(await runProjectReviewCandidateCli([profile === 'standard' ? '--revise-standard' : '--revise', specPath], ports), 2);
    assert.equal(unexpected, 0);
    assert.deepEqual(captured, rows.map(({path, original}, i) => ({path, original, bytes_data: f.samples[i].edited})));
  }
  assert.equal((await verifyProjectCandidateReviewPackage(f.pkg, {}, f.digest)).manifest_sha256, f.digest);
  for (const s of f.samples) assert.deepEqual(await fs.readFile(s.file), s.edited);
});

test('rejects wrong digest, unknown or duplicate selection, original bytes and damaged package', async t => {
  const f = await fixture(t);
  const [a, b] = f.samples;
  const swapped = await fixture(t, '6');
  assert.notEqual(swapped.digest, f.digest);
  assert.deepEqual(run('standard', swapped.pkg, f.digest, f.destination, ...f.args), rejected);
  await assert.rejects(fs.stat(f.destination), {code: 'ENOENT'});
  const same = join(f.root, 'same');
  await fs.writeFile(same, a.next, {mode: 0o400});
  for (const [digest, args] of [
    ['a'.repeat(64), f.args], [f.digest, ['docs/unknown.md', b.file]],
    [f.digest, [a.path, a.file, a.path, b.file]], [f.digest, [a.path, same]],
  ]) {
    assert.deepEqual(run('standard', f.pkg, digest, f.destination, ...args), rejected);
    await assert.rejects(fs.stat(f.destination), {code: 'ENOENT'});
  }
  const changedSide = join(f.pkg, 'changes', a.path + '.new');
  await fs.unlink(changedSide);
  await fs.writeFile(changedSide, Buffer.from([0, 2, 1]), {mode: 0o400});
  assert.deepEqual(run('standard', f.pkg, f.digest, f.destination, ...f.args), rejected);
  await assert.rejects(fs.stat(f.destination), {code: 'ENOENT'});
});

test('rejects occupied, overlapping and non-regular files without modifying them', async t => {
  const f = await fixture(t);
  const occupied = join(f.root, 'occupied');
  await fs.writeFile(occupied, 'preserve');
  const link = join(f.root, 'link');
  await fs.symlink(f.samples[0].file, link);
  const hardlinkSource = join(f.root, 'hardlink-source');
  const hardlink = join(f.root, 'hardlink');
  await fs.writeFile(hardlinkSource, 'linked replacement', {mode: 0o400});
  await fs.link(hardlinkSource, hardlink);
  const writable = join(f.root, 'writable');
  await fs.writeFile(writable, 'writable', {mode: 0o600});
  for (const destination of [occupied, link, f.samples[0].file, join(f.pkg, 'inside')]) {
    assert.equal(run('large', f.pkg, f.digest, destination, ...f.args).status, 2);
  }
  for (const replacement of [link, hardlink, writable, f.root, join(f.pkg, 'changes', f.samples[0].path + '.new')]) {
    assert.deepEqual(run('large', f.pkg, f.digest, f.destination, f.samples[0].path, replacement), rejected);
  }
  assert.equal(await fs.readFile(occupied, 'utf8'), 'preserve');
  assert.deepEqual(await fs.readFile(f.samples[0].file), f.samples[0].edited);
  await assert.rejects(fs.stat(f.destination), {code: 'ENOENT'});
  assert.equal(run('--help').status, 0);
  assert.equal(run('standard', f.pkg, f.digest, f.destination).status, 2);
  assert.equal(run('standard', f.pkg, f.digest.slice(1), f.destination, ...f.args).status, 2);
});

test('caps each payload and the selected profile aggregate while allowing exact-fit payloads', async t => {
  const f = await fixture(t);
  const files = await Promise.all([0, 1, 2, 3].map(async i => {
    const p = join(f.root, 'large-' + i);
    await fs.writeFile(p, Buffer.alloc(524288 + (i === 3 ? 1 : 0), i + 1), {mode: 0o400});
    return p;
  }));
  const pairs = f.samples.flatMap((s, i) => [s.path, files[i]]);
  assert.deepEqual(run('standard', f.pkg, f.digest, join(f.root, 'exact.json'), ...pairs.slice(0, 4)), prepared);
  assert.deepEqual(run('standard', f.pkg, f.digest, f.destination, ...pairs), rejected);
  assert.deepEqual(run('large', f.pkg, f.digest, join(f.root, 'large.json'), ...pairs), prepared);
  assert.deepEqual(run('large', f.pkg, f.digest, f.destination, f.samples[0].path, files[3]), rejected);
  await assert.rejects(fs.stat(f.destination), {code: 'ENOENT'});
});
