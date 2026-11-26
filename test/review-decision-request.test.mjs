import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProjectRevisionReviewPackage} from '../src/project-revision-review-package.mjs';
import {MAX_REVIEW_DECISION_BYTES} from '../src/project-review-decision-limits.mjs';
import {fixture, sha} from './helpers/revision-review-fixture.mjs';

function run(command, ...args) {
  const script = fileURLToPath(new URL(`../bin/${command}.mjs`, import.meta.url));
  const {status, stdout, stderr, error} = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  if (error) throw error;
  return {status, stdout, stderr};
}
const prepare = (...args) => run('squire-review-decision-request', ...args);
const success = {status: 0, stdout: 'PROJECT_REVIEW_DECISION_REQUEST_PREPARED\n', stderr: ''};
const rejected = {status: 2, stdout: '', stderr: 'PROJECT_REVIEW_DECISION_REQUEST_REJECTED\n'};
const missing = path => assert.rejects(fs.lstat(path), {code: 'ENOENT'});
const read = async path => JSON.parse(await fs.readFile(path));
const write = (path, doc) => fs.writeFile(path, JSON.stringify(doc, null, 2) + '\n', {mode: 0o600});

async function setup(t, max = false) {
  const f = await (max ? fixture(45, false, false, false, false, 900000, '', true) : fixture());
  t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  const rev = await buildProjectRevisionReviewPackage(f.spec);
  return {f, families: [
    {family: 'original', dir: f.spec.original_package.dir, expected: f.p1.manifest_sha256, route: 'record'},
    {family: 'revision', dir: f.spec.output_dir, expected: rev.manifest_sha256, route: 'record-revision'},
  ]};
}
async function worksheet(f, {family, dir, expected}, suffix = '') {
  const path = join(f.root, family + '-worksheet' + suffix + '.json');
  assert.equal(run('squire-review-worksheet', family, dir, expected, path).status, 0);
  return {path, doc: await read(path)};
}
function supplied(doc, choice) {
  doc.decision_id = 'synthetic-' + choice.toLowerCase();
  doc.reviewer_label = 'fixture-owner';
  doc.choice = choice;
  if (choice === 'ACCEPT') for (const view of doc.views) for (const row of view.paths) {
    row.attested = true;
    row.binary_inspected = row.binary_review_required;
  }
  if (choice === 'REVISE') {
    const binary = doc.views[0].paths.find(row => row.binary_review_required);
    binary.attested = true;
    binary.binary_inspected = false;
  }
  if (choice === 'REJECT') {
    doc.views[0].paths[0].attested = false;
    // Deliberately leave other responses blank rather than infer attestations.
  }
  return doc;
}
async function snapshot(path) {
  const rows = [];
  async function visit(dir, relative = '') {
    for (const name of (await fs.readdir(dir)).sort()) {
      const full = join(dir, name), rel = join(relative, name), s = await fs.lstat(full);
      rows.push([rel, s.mode, s.ino, s.isFile() ? sha(await fs.readFile(full)) : null]);
      if (s.isDirectory()) await visit(full, rel);
    }
  }
  await visit(path);
  return rows;
}

test('explicit ACCEPT, REVISE and REJECT responses round-trip through both existing recorders without preparing a decision', async t => {
  const {f, families} = await setup(t);
  const packageBefore = await Promise.all(families.map(v => snapshot(v.dir)));
  const priorBefore = await snapshot(f.spec.prior_decisions[0].dir);
  const storePaths = [f.spec.base_git_dir, f.spec.original_git_dir, f.spec.revised_git_dir];
  const storeBefore = await Promise.all(storePaths.map(snapshot));
  for (const v of families) for (const choice of ['ACCEPT', 'REVISE', 'REJECT']) {
    const {family, dir, expected, route} = v;
    const {path, doc} = await worksheet(f, v, choice);
    supplied(doc, choice);
    if (choice === 'ACCEPT') doc.note = 'Synthetic "choice" — explicit café\n';
    if (family === 'revision' && choice === 'REJECT') doc.note = null;
    await write(path, doc);
    const worksheetBytes = await fs.readFile(path);
    const out = join(f.root, `${family}-${choice}-request.json`);
    const decision = join(f.root, `${family}-${choice}-record`);
    const before = (await fs.readdir(f.root)).sort();
    assert.deepEqual(prepare(family, dir, expected, path, out), success);
    assert.deepEqual((await fs.readdir(f.root)).sort(), [...before, `${family}-${choice}-request.json`].sort());
    await missing(decision);
    assert.deepEqual(await fs.readFile(path), worksheetBytes);
    assert.equal((await fs.stat(out)).mode & 0o7777, 0o600);
    const request = await read(out);
    const wanted = doc.views.flatMap(view => view.paths.filter(row => row.attested === true).map(row => ({
      ...(family === 'revision' && {view: view.view}), path: row.path,
      old_sha256: row.old_sha256, new_sha256: row.new_sha256, binary_inspected: row.binary_inspected,
    })));
    assert.deepEqual(request, {
      schema: family === 'original' ? 'SQUIRE_PROJECT_CANDIDATE_DECISION_V1' : 'SQUIRE_PROJECT_REVISION_DECISION_V1',
      decision_id: doc.decision_id, reviewer_label: doc.reviewer_label, ...doc.bindings, choice, attestations: wanted,
      ...(Object.hasOwn(doc, 'note') && {note: doc.note}),
    });
    const result = run('squire-candidate-decision', route, dir, out, decision);
    assert.equal(result.status, 0, result.stderr);
    const storedBytes = await fs.readFile(join(decision, 'decision.json'));
    const stored = JSON.parse(storedBytes);
    assert.equal(stored.choice, choice);
    assert.deepEqual(stored.attestations, wanted);
    assert.equal(stored.note, doc.note ?? null);
    assert.equal(run('squire-candidate-decision', family === 'original' ? 'verify-decision' : 'verify-revision-decision',
      dir, decision, sha(storedBytes)).status, 0);
    if (family === 'revision' && choice === 'ACCEPT') {
      assert.deepEqual(wanted.filter(row => row.path === 'src/restore.mjs').map(row => row.view), ['original_to_revised']);
      assert.deepEqual(wanted.filter(row => row.path === 'assets/icon.bin').map(row => row.binary_inspected), [true, true]);
    }
  }
  assert.deepEqual(await Promise.all(families.map(v => snapshot(v.dir))), packageBefore);
  assert.deepEqual(await snapshot(f.spec.prior_decisions[0].dir), priorBefore);
  assert.deepEqual(await Promise.all(storePaths.map(snapshot)), storeBefore);
});

test('rejects uncompleted, inconsistent, malformed and altered worksheets without creating output', async t => {
  const {f, families} = await setup(t);
  for (const v of families) {
    const {family, dir, expected} = v;
    const {path, doc} = await worksheet(f, v);
    const out = join(f.root, family + '-out.json');
    assert.deepEqual(prepare(family, dir, expected, path, out), rejected);
    await missing(out);
    const binary = d => d.views[0].paths.find(row => row.binary_review_required);
    const changes = [
      d => {d.choice = null;}, d => {d.choice = 'accept';}, d => {d.reviewer_label = null;},
      d => {d.decision_id = 123;}, d => {d.decision_id = ' ' ;},
      d => {d.views[0].paths[0].attested = null;}, d => {binary(d).binary_inspected = false;},
      d => {d.views[0].paths[0].binary_inspected = null;}, d => {d.views[0].paths[0].attested = 'true';},
      d => {d.choice = 'REVISE'; binary(d).attested = false; binary(d).binary_inspected = true;},
      d => {d.choice = 'REJECT'; binary(d).attested = null; binary(d).binary_inspected = true;},
      d => {d.views[0].paths.reverse();}, d => {d.views[0].paths.pop();},
      d => {d.views[0].paths.push(d.views[0].paths[0]);}, d => {d.views[0].display = 'other.txt';},
      d => {d.views[0].view = 'other';}, d => {d.views[0].paths[0].path = 'other';},
      d => {d.views[0].paths[0].old_sha256 = 'a'.repeat(64);}, d => {d.views[0].paths[0].new_sha256 = 'a'.repeat(64);},
      d => {d.views[0].paths[0].old_copy = 'other';}, d => {d.views[0].paths[0].new_copy = 'other';},
      d => {binary(d).binary_review_required = false;}, d => {d.bindings.base_commit = 'a'.repeat(40);},
      d => {d.bindings.other = true;}, d => {d.schema = 'other';}, d => {d.family = 'other';},
      d => {d.views[0].paths[0].extra = true;}, d => {delete d.views[0].paths[0].binary_inspected;},
      d => {d.note = 'é'.repeat(2049);}, d => {d.note = false;}, d => {d.extra = true;},
      ...(family === 'original' ? [d => {d.note = null;}, d => {d.bindings.candidate_tree = 'b'.repeat(40);}] : [
        d => {d.views.reverse();}, d => {d.views.pop();},
        d => {d.bindings.prior_revise_decision_sha256 = 'a'.repeat(64);},
        d => {d.bindings.original_package_sha256 = 'a'.repeat(64);},
        d => {d.views[1].paths[0].attested = null;},
      ]),
    ];
    for (const mutate of changes) {
      const changed = supplied(structuredClone(doc), 'ACCEPT');
      mutate(changed);
      await write(path, changed);
      assert.deepEqual(prepare(family, dir, expected, path, out), rejected, String(mutate));
      await missing(out);
    }
    const good = JSON.stringify(supplied(structuredClone(doc), 'ACCEPT'));
    // Duplicate decoded key, invalid UTF8, truncated JSON and beyond the input ceiling.
    for (const bytes of [good.replace('"choice":"ACCEPT"', '"choice":"REJECT","choic\\u0065":"ACCEPT"'),
      Buffer.from([0xff]), good.slice(0, -1), good + ' '.repeat(256 * 1024)]) {
      await fs.writeFile(path, bytes);
      assert.deepEqual(prepare(family, dir, expected, path, out), rejected);
      await missing(out);
    }
  }
});

test('rejects swapped valid packages, stale digests, changed side copies, and nonfresh or nonprivate paths', async t => {
  const {f, families} = await setup(t);
  const other = await fixture(1);
  t.after(() => fs.rm(other.root, {recursive: true, force: true}));
  const otherRevision = await buildProjectRevisionReviewPackage(other.spec);
  const otherPackages = [[other.spec.original_package.dir, other.p1.manifest_sha256], [other.spec.output_dir, otherRevision.manifest_sha256]];
  for (const [i, v] of families.entries()) {
    const {family, dir, expected} = v;
    const {path, doc} = await worksheet(f, v);
    await write(path, supplied(doc, 'ACCEPT'));
    const out = join(f.root, family + '-out');
    const [otherDir, otherDigest] = otherPackages[i];
    assert.notEqual(expected, otherDigest);
    for (const args of [[otherDir, expected], [otherDir, otherDigest], [dir, otherDigest]]) {
      assert.deepEqual(prepare(family, ...args, path, out), rejected);
      await missing(out);
    }
    const occupied = join(f.root, family + '-occupied');
    await fs.writeFile(occupied, 'preserve');
    const link = join(f.root, family + '-link');
    await fs.symlink(occupied, link);
    for (const dest of [occupied, link]) assert.deepEqual(prepare(family, dir, expected, path, dest), rejected);
    assert.equal(await fs.readFile(occupied, 'utf8'), 'preserve');
    assert.equal(await fs.readlink(link), occupied);
    assert.equal(prepare(family, dir, expected, path, path).status, 2);
    assert.equal(prepare(family, dir, expected, path, join(dir, 'request.json')).status, 2);
    const hard = join(f.root, family + '-hard');
    await fs.link(path, hard);
    assert.deepEqual(prepare(family, dir, expected, path, out), rejected);
    await fs.unlink(hard);
    const symlink = join(f.root, family + '-worksheet-link');
    await fs.symlink(path, symlink);
    assert.deepEqual(prepare(family, dir, expected, symlink, out), rejected);
    await fs.chmod(path, 0o644);
    assert.deepEqual(prepare(family, dir, expected, path, out), rejected);
    await fs.chmod(path, 0o600);
    const side = join(dir, 'changes', family === 'original' ? 'assets/icon.bin.new' : 'assets/icon.bin.revised');
    await fs.unlink(side);
    await fs.writeFile(side, Buffer.from([7, 7, 7]), {mode: 0o400});
    assert.deepEqual(prepare(family, dir, expected, path, out), rejected);
    await missing(out);
  }
});

test('maximum 50/100 row worksheets and maximum escaped notes fit the existing 96 KiB decision consumer', async t => {
  const {f, families} = await setup(t, true);
  for (const v of families) {
    const {family, dir, expected, route} = v;
    const {path, doc} = await worksheet(f, v);
    supplied(doc, 'ACCEPT');
    doc.note = '\u0001'.repeat(4096);
    await write(path, doc);
    const out = join(f.root, family + '-maximum-request');
    assert.deepEqual(prepare(family, dir, expected, path, out), success);
    assert.ok((await fs.stat(out)).size <= MAX_REVIEW_DECISION_BYTES);
    const request = await read(out);
    assert.equal(request.note, doc.note);
    assert.equal(request.attestations.length, family === 'original' ? 50 : 100);
    assert.equal(run('squire-candidate-decision', route, dir, out, join(f.root, family + '-maximum-record')).status, 0);
  }
});

test('help, missing arguments and module import do not read or write a worksheet', () => {
  assert.match(prepare('--help').stdout, /^Usage: /);
  assert.equal(prepare('--help').status, 0);
  assert.equal(prepare().status, 2);
  const script = new URL('../bin/squire-review-decision-request.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(script)})`], {encoding: 'utf8'});
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});
