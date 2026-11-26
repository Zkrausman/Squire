import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProjectRevisionReviewPackage} from '../src/project-revision-review-package.mjs';
import {fixture, sha} from './helpers/revision-review-fixture.mjs';

function run(command, ...args) {
  const script = fileURLToPath(new URL(`../bin/${command}.mjs`, import.meta.url));
  const {status, stdout, stderr, error} = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  if (error) throw error;
  return {status, stdout, stderr};
}
const prepare = (...args) => run('squire-review-worksheet', ...args);
const rejected = {status: 2, stdout: '', stderr: 'PROJECT_REVIEW_WORKSHEET_REJECTED\n'};

test('worksheet lists verified sides in contract order and keeps every human answer blank', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  const rev = await buildProjectRevisionReviewPackage(f.spec);
  for (const [family, dir, digest, manifestName] of [
    ['original', f.spec.original_package.dir, f.p1.manifest_sha256, 'review-manifest.json'],
    ['revision', f.spec.output_dir, rev.manifest_sha256, 'revision-review-manifest.json'],
  ]) {
    const destination = join(f.root, family + '.json');
    assert.deepEqual(prepare(family, dir, digest, destination),
      {status: 0, stdout: 'PROJECT_REVIEW_WORKSHEET_PREPARED\n', stderr: ''});
    assert.equal((await fs.stat(destination)).mode & 0o7777, 0o600);
    const doc = JSON.parse(await fs.readFile(destination, 'utf8'));
    const m = JSON.parse(await fs.readFile(join(dir, manifestName), 'utf8'));
    assert.equal(doc.schema, 'SQUIRE_PROJECT_REVIEW_WORKSHEET_V1');
    assert.equal(doc.family, family);
    assert.deepEqual([doc.reviewer_label, doc.choice, doc.decision_id], [null, null, null]);
    const original = family === 'original';
    assert.equal(doc.bindings[original ? 'review_package_sha256' : 'revision_package_sha256'], digest);
    for (const name of original ? ['base', 'candidate'] : ['base', 'original', 'revised']) {
      for (const field of ['commit', 'tree']) {
        const key = name + '_' + field;
        assert.equal(doc.bindings[key], m[key]);
      }
    }
    const viewNames = original ? ['base_to_candidate'] : ['base_to_revised', 'original_to_revised'];
    assert.deepEqual(doc.views.map(v => v.view), viewNames);
    for (const v of doc.views) {
      await fs.access(join(dir, v.display));
      const rows = original ? m.paths : m[v.view];
      assert.deepEqual(v.paths.map(p => p.path), rows.map(p => p.path));
      for (const [i, row] of rows.entries()) {
        const p = v.paths[i];
        assert.deepEqual([p.old_sha256, p.new_sha256, p.binary_review_required, p.attested, p.binary_inspected],
          [row.old?.sha256 ?? null, row.new.sha256, row.binary_review_required, null, null]);
        if (row.old) assert.equal(sha(await fs.readFile(join(dir, p.old_copy))), p.old_sha256);
        else assert.equal(p.old_copy, null);
        assert.equal(sha(await fs.readFile(join(dir, p.new_copy))), p.new_sha256);
      }
      assert.equal(v.paths.find(p => p.path === 'assets/icon.bin').binary_review_required, true);
    }
    if (!original) {
      assert.equal(doc.bindings.original_package_sha256, f.p1.manifest_sha256);
      assert.equal(doc.bindings.prior_revise_decision_sha256, f.prior.decision_sha256);
      const viewsOf = path => doc.views.filter(v => v.paths.some(p => p.path === path)).map(v => v.view);
      assert.deepEqual(viewsOf('src/restore.mjs'), ['original_to_revised']);
      assert.deepEqual(viewsOf('src/unchanged.mjs'), ['base_to_revised']);
    }
    const decisionDir = join(f.root, family + '-decision');
    assert.equal(run('squire-candidate-decision', original ? 'record' : 'record-revision',
      dir, destination, decisionDir).status, 2);
    await assert.rejects(fs.stat(decisionDir), {code: 'ENOENT'});
  }
});

test('worksheet rejects wrong identity, changed packages and unsafe or occupied destinations', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  const rev = await buildProjectRevisionReviewPackage(f.spec);
  for (const [family, dir, expected, other] of [
    ['original', f.spec.original_package.dir, f.p1.manifest_sha256, rev.manifest_sha256],
    ['revision', f.spec.output_dir, rev.manifest_sha256, f.p1.manifest_sha256],
  ]) {
    const destination = join(f.root, family + '.json');
    assert.deepEqual(prepare(family, dir, other, destination), rejected);
    assert.equal(prepare(family, dir, expected.slice(1), destination).status, 2);
    const inside = join(dir, 'worksheet.json');
    assert.equal(prepare(family, dir, expected, inside).status, 2);
    await assert.rejects(fs.stat(inside), {code: 'ENOENT'});
    await assert.rejects(fs.stat(destination), {code: 'ENOENT'});

    const occupied = join(f.root, family + '-occupied');
    await fs.writeFile(occupied, 'original bytes');
    const link = join(f.root, family + '-link');
    await fs.symlink(occupied, link);
    for (const path of [occupied, link]) assert.deepEqual(prepare(family, dir, expected, path), rejected);
    assert.equal(await fs.readFile(occupied, 'utf8'), 'original bytes');

    // A matching manifest still requires intact copied bytes and inventory.
    const side = join(dir, 'changes', family === 'original' ? 'assets/icon.bin.new' : 'assets/icon.bin.revised');
    await fs.unlink(side);
    await fs.writeFile(side, Buffer.from([7, 7, 7]), {mode: 0o400});
    assert.deepEqual(prepare(family, dir, expected, destination), rejected);
    await assert.rejects(fs.stat(destination), {code: 'ENOENT'});
  }
});

test('worksheet preserves all 50 original and 100 revision rows at the review limit', async t => {
  const f = await fixture(45, false, false, false, false, 900000, '', true);
  t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  const rev = await buildProjectRevisionReviewPackage(f.spec);
  for (const [family, dir, digest, counts] of [
    ['original', f.spec.original_package.dir, f.p1.manifest_sha256, [50]],
    ['revision', f.spec.output_dir, rev.manifest_sha256, [50, 50]],
  ]) {
    const destination = join(f.root, family + '-max.json');
    assert.equal(prepare(family, dir, digest, destination).status, 0);
    const doc = JSON.parse(await fs.readFile(destination));
    assert.deepEqual(doc.views.map(v => v.paths.length), counts);
    assert.ok(doc.views.every(v => v.paths.every(p => p.attested === null && p.binary_inspected === null)));
  }
});
