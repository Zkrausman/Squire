import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const cli = name => fileURLToPath(new URL('../bin/squire-' + name + '.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/offline-review/fixture.mjs', import.meta.url));
const read = async path => JSON.parse(await fs.readFile(path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = path => assert.rejects(fs.lstat(path), {code: 'ENOENT'});
const json = (path, value) => fs.writeFile(path, JSON.stringify(value) + '\n', {mode: 0o600});
function run(file, args = [], lines) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 262144,
    input: lines === undefined ? '' : lines.join('\n') + '\n',
  });
  assert.equal(r.error, undefined);
  return r;
}
function ok(r) { assert.equal(r.status, 0, r.stderr); return r.stdout; }
const guide = (family, destination, lines) => run(cli('review-bindings'), [family, destination], lines);
function stopped(r) {
  assert.equal(r.status, 2);
  assert.match(r.stderr, /PROJECT_REVIEW_BINDINGS_STOPPED/);
  assert.doesNotMatch(r.stdout, /PROJECT_REVIEW_BINDINGS_WRITTEN/);
}
async function setup(t) {
  const root = ok(run(fixture)).trim(), file = name => join(root, name);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const stores = await read(file('stores.json'));
  const original = {
    result_file: file('original-result.json'),
    base_git_dir: stores.base.dir, base_git_identity: stores.base.identity,
    candidate_git_dir: stores.original.dir, candidate_git_identity: stores.original.identity,
    output_dir: file('original-package'),
  };
  return {file, stores, original};
}
const fields = (dir, identity) => [dir, String(identity.dev), String(identity.ino)];
const values = b => [b.result_file, ...fields(b.base_git_dir, b.base_git_identity),
  ...fields(b.candidate_git_dir, b.candidate_git_identity), b.output_dir];
const revisionTail = b => [b.revised_result_file, ...fields(b.revised_git_dir, b.revised_git_identity),
  b.original_package.dir, b.original_package.manifest_sha256, String(b.prior_decisions.length),
  ...b.prior_decisions.flatMap(r => [r.dir, r.file_sha256]), b.selected_decision_id, b.output_dir];
const revisionRepeated = b => [b.original_result_file, ...fields(b.base_git_dir, b.base_git_identity),
  ...fields(b.original_git_dir, b.original_git_identity)];
function prepare(f, family, bindings, stem) {
  return run(cli('review-prepare'), [family, bindings, f.file(stem + '-spec.json'), f.file(stem + '-sheet.json')]);
}
const digest = stdout => stdout.match(/^Manifest SHA256: ([a-f0-9]{64})$/m)[1];
async function inventory(root) {
  const entries = await fs.readdir(root, {recursive: true, withFileTypes: true});
  const result = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name), stat = await fs.lstat(path);
    result[path.slice(root.length + 1)] = [stat.mode, entry.isFile() ? sha(await fs.readFile(path)) : null];
  }
  return result;
}
async function selectedRecord(f, expected, id) {
  const witness = await read(f.original.result_file);
  const dir = f.file(id);
  await fs.mkdir(dir, {mode: 0o700});
  const bytes = Buffer.from(JSON.stringify({
    attestations: [], base_commit: witness.base_commit, base_tree: witness.base_tree,
    boundaries: ['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY'],
    candidate_commit: witness.candidate_commit, candidate_tree: witness.candidate_tree,
    choice: 'REVISE', decision_id: id, note: null, review_package_sha256: expected,
    reviewer_label: 'synthetic-fixture', schema: 'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',
  }));
  await fs.writeFile(join(dir, 'decision.json'), bytes, {mode: 0o400, flag: 'wx'});
  return {dir, file_sha256: sha(bytes)};
}

test('guided original and revision reuse produce exact explicit bindings for unchanged preparation', async t => {
  const f = await setup(t), originalPath = f.file('original-bindings.json');
  const inventories = () => Promise.all(Object.values(f.stores).map(s => inventory(s.dir)));
  const before = await inventories();
  const originalEntries = values(f.original);
  assert.equal(originalEntries.length, 8);
  const originalOut = ok(guide('original', originalPath, [...originalEntries, 'yes']));
  assert.match(originalOut, /PROJECT_REVIEW_BINDINGS_WRITTEN/);
  assert.deepEqual(await read(originalPath), f.original);
  assert.equal((await fs.stat(originalPath)).mode & 0o777, 0o600);
  await absent(f.original.output_dir);
  const originalDigest = digest(ok(prepare(f, 'original', originalPath, 'original')));
  // Inert declared synthetic records, not decision creation; select the second
  // supplied ID, never the first, newest, or an automatically inferred ID.
  const prior = await Promise.all(['fixture-other', 'fixture-selected'].map(id => selectedRecord(f, originalDigest, id)));
  const revision = {
    original_result_file: f.original.result_file, revised_result_file: f.file('revised-result.json'),
    base_git_dir: f.stores.base.dir, base_git_identity: f.stores.base.identity,
    original_git_dir: f.stores.original.dir, original_git_identity: f.stores.original.identity,
    revised_git_dir: f.stores.revised.dir, revised_git_identity: f.stores.revised.identity,
    output_dir: f.file('revision-package'),
    original_package: {dir: f.original.output_dir, manifest_sha256: originalDigest},
    prior_decisions: prior, selected_decision_id: 'fixture-selected',
  };
  const revisionPath = f.file('revision-bindings.json');
  const tail = revisionTail(revision);
  // Scalar value entries exclude mode/confirmation/count, include the destination
  // CLI arg separately. Reuse copies exactly seven repeated scalar values.
  assert.equal(revisionRepeated(revision).length, 7);
  assert.equal(tail.length, 13); // 12 scalar values + 1 count, two records.
  const revisionOut = ok(guide('revision', revisionPath, ['reuse', originalPath, 'yes', ...tail, 'yes']));
  assert.match(revisionOut, /Review the exact reused fields/);
  assert.match(revisionOut, /fixture-selected/);
  assert.deepEqual(await read(revisionPath), revision);
  await absent(revision.output_dir);
  const originalBytes = await fs.readFile(originalPath);
  const direct = f.file('direct-revision-bindings.json');
  ok(guide('revision', direct, ['enter', ...revisionRepeated(revision), ...tail, 'yes']));
  assert.deepEqual(await read(direct), revision);
  assert.deepEqual(await fs.readFile(originalPath), originalBytes);

  // The separate, unchanged prepare-only CLI remains the evidence validator.
  // Multiple REVISE records may be accepted only according to its existing rules.
  const revisionDigest = digest(ok(prepare(f, 'revision', revisionPath, 'revision')));
  const manual = {...revision, output_dir: f.file('comparison-package')};
  const manualPath = f.file('comparison-bindings.json');
  await json(manualPath, manual);
  assert.equal(digest(ok(prepare(f, 'revision', manualPath, 'comparison'))), revisionDigest);
  assert.deepEqual(await inventory(revision.output_dir), await inventory(manual.output_dir));
  assert.deepEqual(await fs.readFile(f.file('revision-sheet.json')), await fs.readFile(f.file('comparison-sheet.json')));
  assert.deepEqual(await inventories(), before);
});

test('guided input rejects missing, invalid, unconfirmed and occupied destinations without overwrite', async t => {
  const f = await setup(t);
  const lines = values(f.original);
  const dest = f.file('bindings.json');
  for (const invalid of [[], lines, [...lines, 'no'],
    ['relative', ...lines.slice(1), 'yes'],
    [...lines.slice(0,2), '9007199254740992', ...lines.slice(3), 'yes']]) {
    stopped(guide('original', dest, invalid));
    await absent(dest);
  }
  await json(dest, {keep: true});
  stopped(guide('original', dest, [...lines, 'yes']));
  assert.deepEqual(await read(dest), {keep: true});
  const linked = f.file('linked.json');
  await fs.symlink(dest, linked);
  stopped(guide('original', linked, [...lines, 'yes']));
  assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
  stopped(guide('original', join(f.stores.base.dir, 'new-bindings.json'), [...lines, 'yes']));
  await absent(join(f.stores.base.dir, 'new-bindings.json'));
  await fs.mkdir(f.original.output_dir);
  stopped(guide('original', f.file('fresh.json'), [...lines, 'yes']));
  await absent(f.file('fresh.json'));
});

test('guided draft preserves wrong evidence values, rejected by existing prepare-only checks', async t => {
  const f = await setup(t);
  const originalPath = f.file('original-bindings.json');
  ok(guide('original', originalPath, [...values(f.original), 'yes']));
  const originalDigest = digest(ok(prepare(f, 'original', originalPath, 'original')));
  const prior = await selectedRecord(f, originalDigest, 'fixture-prior');
  const revision = {
    original_result_file: f.original.result_file, revised_result_file: f.file('revised-result.json'),
    base_git_dir: f.stores.base.dir, base_git_identity: f.stores.base.identity,
    original_git_dir: f.stores.original.dir, original_git_identity: f.stores.original.identity,
    revised_git_dir: f.stores.revised.dir, revised_git_identity: f.stores.revised.identity,
    output_dir: f.file('revision-package'),
    original_package: {dir: f.original.output_dir, manifest_sha256: originalDigest},
    prior_decisions: [prior], selected_decision_id: 'fixture-prior',
  };
  const wrongId = {...revision, selected_decision_id: 'not-selected'};
  const wrongHash = {...revision, prior_decisions: [{...prior, file_sha256: '0'.repeat(64)}]};
  const wrongIdentity = {...revision, revised_git_identity: {dev: 1, ino: 1}};
  const missingResult = {...revision, revised_result_file: f.file('missing.json')};
  for (const [n, value] of [wrongId, wrongHash, wrongIdentity, missingResult].entries()) {
    const path = f.file('draft-' + n + '.json'), stem = 'bad-' + n;
    ok(guide('revision', path, ['reuse', originalPath, 'yes', ...revisionTail(value), 'yes']));
    assert.deepEqual(await read(path), value);
    const rejected = prepare(f, 'revision', path, stem);
    assert.equal(rejected.status, 2, rejected.stdout);
    assert.match(rejected.stderr, n === 2 ? /stage=BUILD acknowledged_stages=1/ : /stage=COMPOSE acknowledged_stages=0/);
    await absent(revision.output_dir);
    await absent(f.file(stem + '-sheet.json'));
  }
  const noReuse = f.file('no-reuse.json');
  stopped(guide('revision', noReuse, ['reuse', originalPath, 'no', ...revisionTail(revision), 'yes']));
  await absent(noReuse);
  const missingPrior = f.file('missing-prior.json');
  const tail = revisionTail(revision);
  tail.splice(7, 1, '');
  stopped(guide('revision', missingPrior, ['reuse', originalPath, 'yes', ...tail, 'yes']));
  await absent(missingPrior);
  const malformed = f.file('malformed-original.json');
  await json(malformed, {...f.original, extra: true});
  stopped(guide('revision', noReuse, ['reuse', malformed, 'yes', ...revisionTail(revision), 'yes']));
  await absent(noReuse);
});

test('guided review escapes format controls in previews without changing supplied values', async t => {
  const f = await setup(t);
  const original = {...f.original, result_file: f.file('synthetic\u202e-result.json')};
  const originalPath = f.file('original-bindings.json');
  const output = ok(guide('original', originalPath, [...values(original), 'yes']));
  assert.doesNotMatch(output, /\u202e/u);
  assert.match(output, /\\u202e-result\.json/);
  assert.deepEqual(await read(originalPath), original);
  const revisionPath = f.file('revision-bindings.json');
  const revision = {
    revised_result_file: f.file('revised-result.json'),
    revised_git_dir: f.stores.revised.dir, revised_git_identity: f.stores.revised.identity,
    output_dir: f.file('revision-package'),
    original_package: {dir: original.output_dir, manifest_sha256: 'a'.repeat(64)},
    prior_decisions: [{dir: f.file('prior-dir'), file_sha256: 'b'.repeat(64)}],
    selected_decision_id: 'selected',
  };
  const reused = ok(guide('revision', revisionPath, ['reuse', originalPath, 'yes', ...revisionTail(revision), 'yes']));
  assert.doesNotMatch(reused, /\u202e/u);
  assert.equal((reused.match(/\\u202e-result\.json/g) ?? []).length, 2);
  assert.equal((await read(revisionPath)).original_result_file, original.result_file);
});

test('guided help and import are inert', () => {
  assert.match(ok(run(cli('review-bindings'), ['--help'])), /^Usage:/);
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval',
    'const before=process.stdout.listenerCount("error"); await import('+JSON.stringify(new URL('../bin/squire-review-bindings.mjs', import.meta.url).href)+'); if(process.stdout.listenerCount("error")!==before)process.exit(1);'],
    {encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout,'');
});
