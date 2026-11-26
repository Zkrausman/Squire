import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runReviewPrepare} from '../bin/squire-review-prepare.mjs';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';

const cli = name => fileURLToPath(new URL('../bin/squire-' + name + '.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/offline-review/fixture.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => fs.writeFile(path, JSON.stringify(value) + '\n', {mode: 0o600});
const read = async path => JSON.parse(await fs.readFile(path));
const absent = path => assert.rejects(fs.lstat(path), {code: 'ENOENT'});
function processRun(file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  return result;
}
function success(file, args) {
  const r = processRun(file, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const digest = stdout => stdout.match(/^Manifest SHA256: ([a-f0-9]{64})$/m)[1];
async function inventory(root) {
  const entries = await fs.readdir(root, {recursive: true, withFileTypes: true});
  const result = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const stat = await fs.lstat(path);
    result[path.slice(root.length + 1)] = [stat.mode, entry.isFile() ? sha(await fs.readFile(path)) : null];
  }
  return result;
}
async function setup(t) {
  const root = success(fixture).trim();
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = name => join(root, name);
  const stores = await read(file('stores.json'));
  const original = {
    result_file: file('original-result.json'),
    base_git_dir: stores.base.dir, base_git_identity: stores.base.identity,
    candidate_git_dir: stores.original.dir, candidate_git_identity: stores.original.identity,
    output_dir: file('original-package'),
  };
  const bindings = file('bindings.json'), spec = file('spec.json'), worksheet = file('worksheet.json');
  await json(bindings, original);
  const args = ['original', bindings, spec, worksheet];
  const inventories = () => Promise.all(Object.values(stores).map(s => inventory(s.dir)));
  return {file, stores, original, bindings, spec, worksheet, args, inventories};
}
const prepare = f => processRun(cli('review-prepare'), f.args);
function stopped(r, stage, count) {
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `PROJECT_REVIEW_PREPARE_STOPPED stage=${stage} acknowledged_stages=${count}\nPRESERVE_OUTPUTS; NO_RETRY_OR_ACK_RECOVERY\n`);
}
async function standalone(f, family, bindings) {
  const input = f.file(family + '-comparison-bindings.json');
  const spec = f.file(family + '-comparison-spec.json');
  const worksheet = f.file(family + '-comparison-worksheet.json');
  const output_dir = f.file(family + '-comparison-package');
  await json(input, {...bindings, output_dir});
  success(cli('review-spec'), [family, input, spec]);
  const rev = family === 'revision';
  const expected = digest(success(cli('candidate-review'), [rev ? '--build-revision' : '--build', spec]));
  success(cli('candidate-review'), [rev ? '--verify-revision' : '--verify', output_dir, '--expect-sha256', expected]);
  success(cli('review-worksheet'), [family, output_dir, expected, worksheet]);
  return {output_dir, worksheet, expected};
}
function blank(document, counts, binary) {
  assert.deepEqual(document.views.map(v => v.paths.length), counts);
  const rows = document.views.flatMap(v => v.paths);
  assert.equal(rows.filter(r => r.binary_review_required).length, binary);
  for (const row of rows) {
    assert.equal(row.attested, null);
    assert.equal(row.binary_inspected, null);
  }
  for (const field of ['decision_id', 'reviewer_label', 'choice']) assert.equal(document[field], null);
}
async function checkRows(pkg, worksheet, original) {
  const bytes = {
    'assets/icon.bin': [null, Buffer.from([0,255,1]), Buffer.from([0,255,2])],
    'docs/added.md': [null, '# Synthetic note\n', '# Synthetic note\n'],
    'src/app.mjs': ['export const label = "base";\n','export const label = "draft";\n','export const label = "revised";\n'],
    'src/restore.mjs': ['export const color = "blue";\n','export const color = "red";\n','export const color = "blue";\n'],
    'src/unchanged.mjs': ['export const count = 1;\n','export const count = 2;\n','export const count = 2;\n'],
  };
  for (const [index, view] of worksheet.views.entries()) {
    for (const row of view.paths) {
      for (const [side, n] of [['old', index], ['new', original ? 1 : 2]]) {
        const expected = bytes[row.path][n];
        if (expected === null) {
          assert.equal(row[side + '_copy'], null);
          assert.equal(row[side + '_sha256'], null);
        } else {
          const copy = await fs.readFile(join(pkg, row[side + '_copy']));
          assert.deepEqual(copy, Buffer.from(expected));
          assert.equal(row[side + '_sha256'], sha(copy));
        }
      }
    }
  }
}

test('prepare-only original and revision preserve standalone bytes, 12 rows, 3 binary obligations and stores', async t => {
  const f = await setup(t);
  const before = await f.inventories();
  const originalRef = await standalone(f, 'original', f.original);
  const r = prepare(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(digest(r.stdout), originalRef.expected);
  assert.match(r.stdout, /PROJECT_REVIEW_SPEC_COMPOSED\nPROJECT_REVIEW_PACKAGE_BUILT\nManifest SHA256: [a-f0-9]{64}\nPROJECT_REVIEW_PACKAGE_DIGEST_VERIFIED\nPROJECT_REVIEW_WORKSHEET_PREPARED\nPREPARE_ONLY/);
  assert.deepEqual(await inventory(f.original.output_dir), await inventory(originalRef.output_dir));
  assert.deepEqual(await fs.readFile(f.worksheet), await fs.readFile(originalRef.worksheet));
  const originalSheet = await read(f.worksheet);
  blank(originalSheet, [5], 1);
  await checkRows(f.original.output_dir, originalSheet, true);
  assert.equal((await fs.stat(f.spec)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.worksheet)).mode & 0o777, 0o600);

  // A supplied, inert test-only prior record for the fixed #315 witness.
  // No decision-preparation or record operation is invoked here.
  const witness = await read(f.original.result_file);
  const priorDir = f.file('synthetic-prior');
  await fs.mkdir(priorDir, {mode: 0o700});
  const prior = Buffer.from(JSON.stringify({
    attestations: [], base_commit: witness.base_commit, base_tree: witness.base_tree,
    boundaries: ['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY'],
    candidate_commit: witness.candidate_commit, candidate_tree: witness.candidate_tree,
    choice: 'REVISE', decision_id: 'fixture-prior', note: null,
    review_package_sha256: originalRef.expected, reviewer_label: 'synthetic-fixture',
    schema: 'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',
  }));
  await fs.writeFile(join(priorDir, 'decision.json'), prior, {mode: 0o400, flag: 'wx'});
  const revision = {
    original_result_file: f.original.result_file, revised_result_file: f.file('revised-result.json'),
    base_git_dir: f.stores.base.dir, base_git_identity: f.stores.base.identity,
    original_git_dir: f.stores.original.dir, original_git_identity: f.stores.original.identity,
    revised_git_dir: f.stores.revised.dir, revised_git_identity: f.stores.revised.identity,
    output_dir: f.file('revision-package'),
    original_package: {dir: f.original.output_dir, manifest_sha256: originalRef.expected},
    prior_decisions: [{dir: priorDir, file_sha256: sha(prior)}], selected_decision_id: 'fixture-prior',
  };
  const revisionRef = await standalone(f, 'revision', revision);
  const revBindings = f.file('rev-bindings.json'), revSpec = f.file('rev-spec.json'), revSheet = f.file('rev-sheet.json');
  await json(revBindings, revision);
  const rev = processRun(cli('review-prepare'), ['revision', revBindings, revSpec, revSheet]);
  assert.equal(rev.status, 0, rev.stderr);
  assert.equal(digest(rev.stdout), revisionRef.expected);
  assert.deepEqual(await inventory(revision.output_dir), await inventory(revisionRef.output_dir));
  assert.deepEqual(await fs.readFile(revSheet), await fs.readFile(revisionRef.worksheet));
  const revisionSheet = await read(revSheet);
  blank(revisionSheet, [4,3], 2);
  await checkRows(revision.output_dir, revisionSheet, false);
  assert.equal((await fs.stat(revSpec)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(revSheet)).mode & 0o777, 0o600);
  const manifest = await read(join(revision.output_dir, 'revision-review-manifest.json'));
  assert.equal(manifest.original_to_revised.find(r => r.path === 'src/restore.mjs').classification, 'RESTORED_BASE');
  assert.deepEqual(await fs.readFile(join(priorDir,'decision.json')), prior);
  assert.deepEqual(await f.inventories(), before);
  const stale = {...revision, prior_decisions: [{dir: priorDir, file_sha256: '0'.repeat(64)}], output_dir: f.file('stale-package')};
  await json(revBindings, stale);
  const staleSpec = f.file('stale-spec'), staleSheet = f.file('stale-sheet');
  stopped(processRun(cli('review-prepare'), ['revision', revBindings, staleSpec, staleSheet]), 'COMPOSE', 0);
  await absent(staleSpec); await absent(stale.output_dir); await absent(staleSheet);
});

test('prepare-only preflight rejects occupied, linked and overlapping destinations', async t => {
  const f = await setup(t);
  for (const path of [f.spec, f.original.output_dir, f.worksheet]) {
    await fs.writeFile(path, 'keep');
    stopped(prepare(f), 'PREFLIGHT', 0);
    assert.equal(await fs.readFile(path, 'utf8'), 'keep');
    await fs.unlink(path);
  }
  for (const worksheet of [join(f.original.base_git_dir, 'new-sheet'), join(f.original.candidate_git_dir, 'new-sheet'), join(f.original.output_dir, 'sheet')]) {
    stopped(processRun(cli('review-prepare'), [...f.args.slice(0,3), worksheet]), 'PREFLIGHT', 0);
    await absent(worksheet);
  }
  await fs.symlink(f.original.result_file, f.worksheet);
  stopped(prepare(f), 'PREFLIGHT', 0);
  assert.equal((await fs.lstat(f.worksheet)).isSymbolicLink(), true);
  await absent(f.spec); await absent(f.original.output_dir);
});

test('prepare-only malformed bindings stop at composition and wrong physical identity retains spec', async t => {
  const f = await setup(t);
  await json(f.bindings, {...f.original, extra: true});
  stopped(prepare(f), 'COMPOSE', 0);
  await absent(f.spec); await absent(f.original.output_dir); await absent(f.worksheet);
  await json(f.bindings, {...f.original, base_git_identity: {dev: 1, ino: 1}});
  stopped(prepare(f), 'BUILD', 1);
  assert.equal((await fs.stat(f.spec)).mode & 0o777, 0o600);
  await absent(f.original.output_dir); await absent(f.worksheet);
});

test('prepare-only stops after lost build acknowledgement or rejected verification; no replay', async t => {
  for (const failure of ['lost-build-ack', 'wrong-digest', 'interrupted-worksheet']) {
    const f = await setup(t);
    const visited = [], stdout = [], stderr = [];
    const scripts = {compose:'review-spec',build:'candidate-review',verify:'candidate-review',worksheet:'review-worksheet'};
    const result = await runReviewPrepare(f.args, {
      run: async (stage, args) => {
        visited.push(stage);
        if (stage === 'worksheet' && failure === 'interrupted-worksheet') throw new Error('interrupted');
        const output = success(cli(scripts[stage]), args);
        if (stage === 'build' && failure === 'lost-build-ack') throw new Error('lost');
        if (stage === 'build' && failure === 'wrong-digest') return output.replace(digest(output), '0'.repeat(64));
        return output;
      },
      out: async s => stdout.push(s), err: async s => stderr.push(s),
    });
    assert.equal(result, 2);
    assert.equal((await fs.stat(f.spec)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.original.output_dir)).isDirectory(), true);
    await absent(f.worksheet);
    assert.deepEqual(visited, failure === 'lost-build-ack' ? ['compose','build'] :
      failure === 'wrong-digest' ? ['compose','build','verify'] : ['compose','build','verify','worksheet']);
    assert.match(stderr.join(''), failure === 'lost-build-ack' ? /stage=BUILD acknowledged_stages=1/ :
      failure === 'wrong-digest' ? /stage=VERIFY acknowledged_stages=2/ : /stage=WORKSHEET acknowledged_stages=3/);
    if (failure === 'lost-build-ack') assert.doesNotMatch(stdout.join(''), /Manifest SHA256/);
  }
});

test('prepare-only failed stdout acknowledgement leaves the spec and reports partial outcome on stderr', async t => {
  const f = await setup(t);
  const r = await artifactCliChild(new URL('../bin/squire-review-prepare.mjs', import.meta.url),
    f.args, {closed: 'stdout'});
  assert.equal(r.code, 2);
  assert.equal(r.signal, null);
  assert.match(r.stderr, /stage=COMPOSE acknowledged_stages=1/);
  assert.equal((await fs.stat(f.spec)).mode & 0o777, 0o600);
  await absent(f.original.output_dir);
  await absent(f.worksheet);
});

test('prepare-only exact help and import are inert', () => {
  assert.match(success(cli('review-prepare'), ['--help']), /^Usage:/);
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval',
    'const before=process.stdout.listenerCount("error"); await import('+JSON.stringify(new URL('../bin/squire-review-prepare.mjs', import.meta.url).href)+'); if(process.stdout.listenerCount("error")!==before)process.exit(1);'],
    {encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout,'');
});
