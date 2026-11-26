import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {spawnSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = name => fileURLToPath(new URL(`../bin/squire-${name}.mjs`, import.meta.url));
const fixture = fileURLToPath(new URL('../examples/offline-review/fixture.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => fs.writeFile(path, JSON.stringify(value) + '\n', {mode: 0o600});
const read = async path => JSON.parse(await fs.readFile(path));
const missing = path => assert.rejects(fs.lstat(path), {code: 'ENOENT'});
function run(file, args = [], input) {
  const result = spawnSync(process.execPath, [file, ...args], {input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  assert.equal(result.error, undefined);
  return result;
}
function success(file, args = []) {
  const r = run(file, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const lines = args => args.join('\n') + '\n';
const promptCount = stdout => stdout.split('\n').filter(line => /^(Attest this|Binary inspected|Decision ID|Reviewer label|Choice \[|Optional note|Save a fresh)/.test(line)).length;
async function inventory(root) {
  const result = {};
  for (const entry of await fs.readdir(root, {recursive: true, withFileTypes: true})) {
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
  const before = await Promise.all(Object.values(stores).map(store => inventory(store.dir)));
  const inventories = () => Promise.all(Object.values(stores).map(store => inventory(store.dir)));
  const original = {
    result_file: file('original-result.json'),
    base_git_dir: stores.base.dir, base_git_identity: stores.base.identity,
    candidate_git_dir: stores.original.dir, candidate_git_identity: stores.original.identity,
    output_dir: file('original-package'),
  };
  async function prepare(family, bindings) {
    const path = file(`${family}-bindings.json`), spec = file(`${family}-spec.json`), blank = file(`${family}-blank.json`);
    await json(path, bindings);
    const stdout = success(cli('review-prepare'), [family, path, spec, blank]);
    const expected = stdout.match(/^Manifest SHA256: ([a-f0-9]{64})$/m)[1];
    const args = [family, bindings.output_dir, expected, blank];
    return {family, dir: bindings.output_dir, expected, blank, args, sheet: await read(blank)};
  }
  const first = await prepare('original', original);
  async function revision(prior, priorDigest) {
    return prepare('revision', {
      original_result_file: original.result_file, revised_result_file: file('revised-result.json'),
      base_git_dir: stores.base.dir, base_git_identity: stores.base.identity,
      original_git_dir: stores.original.dir, original_git_identity: stores.original.identity,
      revised_git_dir: stores.revised.dir, revised_git_identity: stores.revised.identity,
      output_dir: file('revision-package'), original_package: {dir: first.dir, manifest_sha256: first.expected},
      prior_decisions: [{dir: prior, file_sha256: priorDigest}], selected_decision_id: 'synthetic-revise',
    });
  }
  return {root, first, revision, file, before, inventories};
}
function form(v, destination, answers) {
  return run(cli('review-response'), [...v.args, destination], lines(answers));
}
function checkTranscript(v, stdout) {
  const references = v.sheet.views.flatMap(view => [
    `View: ${view.view}`, `Display: ${JSON.stringify(view.display)}`,
    ...view.paths.flatMap(row => [
      `Path: ${JSON.stringify(row.path)}`, `Old copy: ${JSON.stringify(row.old_copy)}`,
      `Old SHA-256: ${row.old_sha256}`, `New copy: ${JSON.stringify(row.new_copy)}`,
      `New SHA-256: ${row.new_sha256}`, `Binary review required: ${row.binary_review_required}`,
    ]),
  ]);
  const rendered = stdout.split('\n').filter(line => /^(View:|Display:|Path:|Old copy:|Old SHA-256:|New copy:|New SHA-256:|Binary review required:)/.test(line));
  assert.deepEqual(rendered, references);
}

test('fixed synthetic REVISE flows through existing request and recorder; first revision has independent ordered responses', async t => {
  const f = await setup(t), original = f.first;
  const blankBytes = await fs.readFile(original.blank), originalInventory = await inventory(original.dir);
  const out = f.file('original-completed.json'), request = f.file('original-request.json'), prior = f.file('prior-record');
  const answers = [...Array(10).fill(''), 'synthetic-revise', 'synthetic-test-operator', 'REVISE', '', 'yes'];
  const beforeForm = (await fs.readdir(f.root)).sort();
  const r = form(original, out, answers);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROJECT_REVIEW_RESPONSE_SAVED\n$/);
  assert.equal(promptCount(r.stdout), answers.length); // 15 prompts and explicit line inputs; no JSON edits by form.
  checkTranscript(original, r.stdout);
  assert.deepEqual((await fs.readdir(f.root)).sort(), [...beforeForm, 'original-completed.json'].sort());
  assert.equal((await fs.stat(out)).mode & 0o7777, 0o600);
  assert.deepEqual(await fs.readFile(original.blank), blankBytes);
  assert.deepEqual(await read(out), {...original.sheet, decision_id: 'synthetic-revise', reviewer_label: 'synthetic-test-operator', choice: 'REVISE'});
  await missing(request); await missing(prior);
  success(cli('review-decision-request'), [...original.args.slice(0, 3), out, request]);
  assert.deepEqual(await read(request), {schema: 'SQUIRE_PROJECT_CANDIDATE_DECISION_V1', decision_id: 'synthetic-revise',
    reviewer_label: 'synthetic-test-operator', ...original.sheet.bindings, choice: 'REVISE', attestations: []});
  success(cli('candidate-decision'), ['record', original.dir, request, prior]);
  const decisionBytes = await fs.readFile(join(prior, 'decision.json'));
  const priorDigest = sha(decisionBytes);
  success(cli('candidate-decision'), ['verify-decision', original.dir, prior, priorDigest]);
  const revision = await f.revision(prior, priorDigest);
  const revisionBytes = await fs.readFile(revision.blank), revisionInventory = await inventory(revision.dir);
  assert.deepEqual(revision.sheet.views.map(v => v.paths.length), [4, 3]);
  const rows = revision.sheet.views.flatMap(view => view.paths);
  assert.equal(rows.filter(row => row.binary_review_required).length, 2);
  const revised = f.file('revision-completed.json');
  // The same binary path occurs independently in the two views. Leave only
  // the later comparison's binary response blank despite explicit attestation.
  const missingBinary = rows.findLastIndex(row => row.binary_review_required);
  const revisedAnswers = [...rows.flatMap((row, i) => ['yes', i === missingBinary ? '' : row.binary_review_required ? 'yes' : 'no']),
    'synthetic-incomplete', 'synthetic-test-operator', 'ACCEPT', 'Synthetic note — café', 'yes'];
  const control = form(revision, revised, revisedAnswers);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(promptCount(control.stdout), revisedAnswers.length); // 19 prompts and inputs, not raw JSON editing.
  checkTranscript(revision, control.stdout);
  const response = await read(revised);
  const actual = response.views.flatMap(view => view.paths);
  assert.deepEqual(actual.filter(row => row.binary_review_required).map(row => row.binary_inspected), [true, null]);
  assert.ok(response.views[1].paths.some(row => row.path === 'src/restore.mjs'));
  assert.equal(response.note, 'Synthetic note — café');
  const rejectedRequest = f.file('rejected-request.json');
  assert.equal(run(cli('review-decision-request'), [...revision.args.slice(0,3), revised, rejectedRequest]).status, 2);
  await missing(rejectedRequest);
  assert.deepEqual(await fs.readFile(revision.blank), revisionBytes);
  assert.deepEqual(await fs.readFile(join(prior, 'decision.json')), decisionBytes);
  assert.deepEqual(await inventory(original.dir), originalInventory);
  assert.deepEqual(await inventory(revision.dir), revisionInventory);
  assert.deepEqual(await f.inventories(), f.before);
});

test('blank choices stay blank, invalid inputs re-prompt and EOF or explicit cancellation do not save', async t => {
  const f = await setup(t), v = f.first;
  const out = f.file('blank-copy.json');
  // 10 row answers, three blank metadata answers, blank note, save.
  const corrected = ['y', ...Array(12).fill(''), 'wrong choice', '', '', 'yes'];
  const r = form(v, out, corrected);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(promptCount(r.stdout), corrected.length);
  assert.deepEqual(await read(out), v.sheet);
  const aborted = f.file('aborted.json');
  assert.equal(form(v, aborted, ['yes']).status, 2);
  await missing(aborted);
  assert.equal(form(v, aborted, [...Array(14).fill(''), 'no']).status, 2);
  await missing(aborted);
  const request = f.file('missing-choice.json');
  assert.equal(run(cli('review-decision-request'), [...v.args.slice(0,3), out, request]).status, 2);
  await missing(request);
});

test('rejects stale digest, altered or nonprivate blanks and occupied/overlapping destinations before prompting', async t => {
  const f = await setup(t), v = f.first, dest = f.file('dest.json');
  const blankBytes = await fs.readFile(v.blank);
  const bad = f.file('changed.json');
  for (const change of [
    d => {d.views[0].paths.reverse();}, d => {d.views[0].paths[0].attested = false;},
    d => {d.views[0].paths[0].new_copy = 'elsewhere';}, d => {d.bindings.base_tree = 'a'.repeat(40);},
    d => {d.choice = 'REVISE';}, d => {d.note = '';},
  ]) {
    const sheet = structuredClone(v.sheet); change(sheet); await json(bad, sheet);
    const r = run(cli('review-response'), [...v.args.slice(0,3), bad, dest], '');
    assert.equal(r.status, 2); assert.equal(r.stdout, ''); await missing(dest);
  }
  await fs.writeFile(bad, blankBytes.toString().replace('"choice": null', '"choice": null, "choice": null'));
  const args = [...v.args.slice(0,3), bad, dest];
  assert.equal(run(cli('review-response'), args, '').status, 2);
  await fs.writeFile(bad, blankBytes); await fs.chmod(bad, 0o644);
  assert.equal(run(cli('review-response'), args, '').status, 2);
  await missing(dest);
  const link = f.file('link.json'); await fs.symlink(v.blank, link);
  const occupied = f.file('occupied.json'); await fs.writeFile(occupied, 'preserve');
  for (const args of [
    [v.family, v.dir, '0'.repeat(64), v.blank, dest], [...v.args.slice(0,3), link, dest],
    [...v.args, occupied], [...v.args, link], [...v.args, v.blank], [...v.args, join(v.dir, 'out.json')],
  ]) {
    const r = run(cli('review-response'), args, '');
    assert.equal(r.status, 2); assert.equal(r.stdout, '');
  }
  assert.equal(await fs.readFile(occupied, 'utf8'), 'preserve');
  assert.deepEqual(await fs.readFile(v.blank), blankBytes);
  await missing(dest);
});

test('package or blank changes during input stop saving; no inspection response is inferred', {timeout: 10000}, async t => {
  const f = await setup(t), v = f.first;
  const original = await fs.readFile(v.blank);
  for (const change of ['blank', 'copy']) {
    const dest = f.file(`${change}-interrupted.json`);
    const proc = spawn(process.execPath, [cli('review-response'), ...v.args, dest], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '', triggered = false;
    proc.stderr.on('data', bytes => stderr += bytes);
    const finish = new Promise(resolve => proc.once('close', resolve));
    t.after(() => proc.kill());
    proc.stdout.on('data', async bytes => {
      stdout += bytes;
      if (!triggered && stdout.includes('Attest this exact comparison?')) {
        triggered = true;
        if (change === 'blank') await json(v.blank, {...v.sheet, choice: 'REVISE'});
        else {
          const path = join(v.dir, v.sheet.views[0].paths[0].new_copy);
          await fs.chmod(path, 0o600);
          await fs.writeFile(path, Buffer.from([1, 2, 3]));
          await fs.chmod(path, 0o400);
        }
        proc.stdin.end(lines([...Array(14).fill(''), 'yes']));
      }
    });
    assert.equal(await finish, 2, stderr);
    assert.equal(triggered, true);
    assert.doesNotMatch(stdout, /PROJECT_REVIEW_RESPONSE_SAVED/);
    await missing(dest);
    if (change === 'blank') await fs.writeFile(v.blank, original);
  }
});

test('help and inert import do not read or write worksheets', () => {
  assert.match(success(cli('review-response'), ['--help']), /^Usage: /);
  assert.equal(run(cli('review-response')).status, 2);
  const r = run('--input-type=module', ['-e', `await import(${JSON.stringify(new URL('../bin/squire-review-response.mjs', import.meta.url).href)})`]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});
