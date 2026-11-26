// A disposable, fixed synthetic witness for the offline review quickstart.
// This creates only inert Git objects and supplied test records. It is NOT a
// candidate importer, producer receipt, stage receipt or owner decision.
import * as fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

if (process.argv.length !== 2) throw new Error('Usage: node fixture.mjs (no arguments)');
const root = await fs.mkdtemp(join(tmpdir(), 'squire-synthetic-review-'));
await fs.chmod(root, 0o700);
const GIT = '/usr/bin/git';
const env = {
  PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
  GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
const git = (dir, args, input) => execFileSync(GIT, [
  '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never',
  `--git-dir=${dir}`, ...args,
], {cwd: dir, env, input, encoding: 'ascii'}).trim();
const digest = data => createHash('sha256').update(data).digest('hex');
const paths = {
  'assets/icon.bin': [null, Buffer.from([0, 255, 1]), Buffer.from([0, 255, 2])],
  'docs/added.md': [null, '# Synthetic note\n', '# Synthetic note\n'],
  'src/app.mjs': ['export const label = "base";\n', 'export const label = "draft";\n',
    'export const label = "revised";\n'],
  'src/restore.mjs': ['export const color = "blue";\n', 'export const color = "red";\n',
    'export const color = "blue";\n'],
  'src/unchanged.mjs': ['export const count = 1;\n', 'export const count = 2;\n',
    'export const count = 2;\n'],
};
const stores = ['base', 'original', 'revised'].map(name => join(root, name + '.git'));
for (const dir of stores) execFileSync(GIT, [
  'init', '--bare', '--shared=0600', '--quiet', '--template=/dev/null', dir,
], {env});
for (const dir of stores.slice(1)) {
  await fs.writeFile(join(dir, 'objects', 'info', 'alternates'),
    join(stores[0], 'objects') + '\n', {mode: 0o600, flag: 'wx'});
}
const rows = stores.map((dir, side) => Object.entries(paths).flatMap(([path, values]) => {
  if (values[side] === null) return [];
  const data = Buffer.from(values[side]);
  const oid = git(dir, ['hash-object', '-w', '--stdin', '--no-filters'], data);
  return [{path, oid, bytes: data.length, sha256: digest(data)}];
}));
function makeTree(dir, files) {
  const entries = [];
  for (const folder of [...new Set(files.map(row => row.path.split('/')[0]))].sort()) {
    const leaves = files.filter(row => row.path.startsWith(folder + '/'));
    const oid = git(dir, ['mktree', '-z'], Buffer.from(leaves.map(row =>
      `100644 blob ${row.oid}\t${row.path.split('/')[1]}\0`).join('')));
    entries.push(`040000 tree ${oid}\t${folder}\0`);
  }
  return git(dir, ['mktree', '-z'], Buffer.from(entries.join('')));
}
const trees = stores.map((dir, n) => makeTree(dir, rows[n]));
const commits = [git(stores[0], ['commit-tree', trees[0], '-m', 'Synthetic base'])];
for (let n = 1; n <= 2; n++) {
  commits.push(git(stores[n], ['commit-tree', trees[n], '-p', commits[0], '-m', 'Synthetic test witness']));
}
git(stores[1], ['update-ref', 'refs/heads/candidate-original', commits[1]]);
git(stores[2], ['update-ref', 'refs/heads/candidate-revised', commits[2]]);
const common = {
  base_commit: commits[0], base_tree: trees[0],
  // Deliberately artificial test tokens, not digests of actual receipts/stages.
  receipt_sha256: 'a'.repeat(64), stage_manifest_sha256: 'b'.repeat(64),
  task_correctness: 'NOT_EVALUATED', human_review: 'PENDING',
  native_acceptance: 'NOT_ESTABLISHED', benchmark_acceptance: 'NOT_ESTABLISHED',
  origin_authenticity: 'SUPPLIED_NOT_AUTHENTICATED',
  base_alternate_dependency: 'READ_ONLY_BASE_OBJECT_ALTERNATE',
};
const original = {
  ...common, schema: 'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',
  status: 'SOURCE_CANDIDATE_CREATED', operation_id: 'original',
  candidate_ref: 'refs/heads/candidate-original', candidate_commit: commits[1],
  candidate_tree: trees[1], changed_paths: Object.keys(paths),
};
const corrected = ['assets/icon.bin', 'src/app.mjs', 'src/restore.mjs'];
const revised = {
  ...common, schema: 'SQUIRE_PROJECT_REVISION_CANDIDATE_V1',
  status: 'SOURCE_REVISION_CANDIDATE_CREATED', operation_id: 'revised',
  candidate_ref: 'refs/heads/candidate-revised', candidate_commit: commits[2],
  candidate_tree: trees[2], changed_paths: Object.keys(paths).filter(p => p !== 'src/restore.mjs'),
  correction_origin: 'OPERATOR_SUPPLIED',
  revision_of: {commit: commits[1], tree: trees[1]},
  revised_blobs: corrected.map(path => {
    const old = rows[1].find(r => r.path === path);
    const next = rows[2].find(r => r.path === path);
    return {path, previous_blob: old.oid, previous_bytes: old.bytes,
      previous_sha256: old.sha256, blob: next.oid, bytes: next.bytes, sha256: next.sha256};
  }),
};
const identities = {};
for (const [n, key] of ['base', 'original', 'revised'].entries()) {
  const {dev, ino} = await fs.stat(stores[n]);
  identities[key] = {dir: stores[n], identity: {dev, ino}};
}
for (const [file, value] of [
  ['original-result.json', original], ['revised-result.json', revised], ['stores.json', identities],
]) {
  await fs.writeFile(join(root, file), JSON.stringify(value, null, 2) + '\n',
    {mode: 0o600, flag: 'wx'});
}
process.stdout.write(root + '\n');
