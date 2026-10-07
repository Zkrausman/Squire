import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { GitWorkspace } from '../src/workspace.mjs';
import { checkpointFixtureCandidate, fixture, git, ticket } from './support.mjs';

test('repository aliases share the same target-branch lease identity', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  await symlink(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const workspace = new GitWorkspace(f.stateDir);
  assert.equal(workspace.key({ source: f.source, branch: 'main' }), workspace.key({ source: alias, branch: 'main' }));
  assert.notEqual(workspace.key({ source: f.source, branch: 'main' }), workspace.key({ source: alias, branch: 'other' }));
});

test('protected directory root cannot be replaced with a file', async t => {
  const f = await fixture(t), root = path.join(f.stateDir, 'projects', 'fixture'); await mkdir(root, { recursive: true });
  const workspace = new GitWorkspace(root), directory = path.join(root, 'candidate');
  const prepared = await workspace.prepare(f.config.services.app, directory, 'squire/test');
  await writeFile(path.join(directory, '.github'), 'replacement');
  const ticketState = { ...f.store.get(f.config.id).tickets[0], workspace: directory, branch: prepared.branch, generation: 1, baseSha: prepared.baseSha };
  await assert.rejects(() => checkpointFixtureCandidate(f, workspace, ticketState, f.config.services.app), e => e.code === 'protected_path');
});

test('renaming a protected path remains blocked by its source name', async t => {
  const f = await fixture(t, [ticket('a')], async ({ seed, source, check }) => {
    const policy = path.join(seed, 'secret', 'policy.txt');
    await mkdir(path.dirname(policy), { recursive: true });
    await writeFile(policy, 'protected policy\n');
    git(seed, 'add', 'secret/policy.txt'); git(seed, 'commit', '-m', 'Add protected policy'); git(seed, 'push', source, 'main');
    return { services: { app: { source, branch: 'main', delivery: { kind: 'local' },
      checks: [{ name: 'behavior', argv: [process.execPath, check], timeoutSeconds: 10 }], protectedPaths: ['secret/'] } } };
  });
  const root = path.join(f.stateDir, 'projects', 'fixture'); await mkdir(root, { recursive: true });
  const workspace = new GitWorkspace(root), directory = path.join(root, 'workspaces', 'a-1');
  const prepared = await workspace.prepare(f.config.services.app, directory, 'squire/rename-fixture');
  git(directory, 'mv', 'secret/policy.txt', 'renamed-policy.txt');
  const ticketState = { ...f.store.get(f.config.id).tickets[0], workspace: directory, branch: prepared.branch,
    generation: 1, baseSha: prepared.baseSha };
  await assert.rejects(() => checkpointFixtureCandidate(f, workspace, ticketState, f.config.services.app), error => error.code === 'protected_path');
  assert.equal(git(directory, 'rev-parse', 'HEAD'), prepared.baseSha);
});

test('managed workspaces preserve pinned asset bytes across checkpoint, delivery, and safe autocrlf migration', { timeout: 90000 }, async t => {
  const f = await fixture(t), manifest = 'public/tldraw/manifest.json';
  const canonical = Buffer.from('{"asset":"fixture"}\n', 'utf8');
  git(f.seed, 'config', 'core.autocrlf', 'false');
  await mkdir(path.dirname(path.join(f.seed, manifest)), { recursive: true });
  await writeFile(path.join(f.seed, manifest), canonical);
  git(f.seed, 'add', '-A'); git(f.seed, 'commit', '-m', 'Add byte-sensitive pinned manifest'); git(f.seed, 'push', f.source, 'main');

  const root = path.join(f.stateDir, 'projects', 'fixture'), workspace = new GitWorkspace(root);
  const directory = path.join(root, 'workspaces', 'a-1');
  const prepared = await workspace.prepare(f.config.services.app, directory, 'squire/byte-fixture');
  assert.equal(await workspace.localAutocrlf(directory), 'false');
  assert.equal(await workspace.localEol(directory), 'lf');
  assert.deepEqual(await readFile(path.join(directory, manifest)), canonical);
  const blob = sha => execFileSync('git', ['show', `${sha}:${manifest}`], { cwd: directory, encoding: null, windowsHide: true });
  assert.deepEqual(blob(prepared.baseSha), canonical);

  await writeFile(path.join(directory, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n');
  const ticketState = { ...f.store.get(f.config.id).tickets[0], workspace: directory, branch: 'squire/byte-fixture', generation: 1,
    baseSha: prepared.baseSha, spec: { ...f.store.get(f.config.id).tickets[0].spec, execution: { ownedPaths: ['feature-a.mjs'] } } };
  const candidate = await checkpointFixtureCandidate(f, workspace, ticketState, f.config.services.app);
  assert.deepEqual(await readFile(path.join(directory, manifest)), canonical);
  assert.deepEqual(blob(candidate.headSha), canonical);
  git(directory, 'push', 'origin', `${candidate.headSha}:refs/heads/main`);

  const delivered = path.join(root, 'delivered', candidate.headSha);
  const identity = await workspace.mergeWorkspace(f.config.services.app, candidate.headSha, delivered);
  assert.equal(identity.headSha, candidate.headSha);
  assert.deepEqual(await readFile(path.join(delivered, manifest)), canonical);
  assert.deepEqual(execFileSync('git', ['show', `${candidate.headSha}:${manifest}`], { cwd: delivered, encoding: null, windowsHide: true }), canonical);

  // Model a previously managed checkout created under Windows native EOL rules.
  const legacyDirectory = path.join(root, 'legacy', 'a-candidate');
  await workspace.git(root, ['clone', '--config', 'core.autocrlf=true', '--config', 'core.eol=crlf', '--quiet', '--no-hardlinks', '--', f.config.services.app.source, legacyDirectory]);
  assert.equal(await workspace.localAutocrlf(legacyDirectory), 'true');
  const oldBytes = await readFile(path.join(legacyDirectory, manifest));
  assert.notDeepEqual(oldBytes, canonical);
  assert.equal(git(legacyDirectory, 'status', '--porcelain'), '');
  const migrated = await workspace.assertCandidate({ workspace: legacyDirectory, headSha: candidate.headSha, treeSha: candidate.treeSha });
  assert.equal(migrated.normalized, true);
  assert.equal(migrated.headSha, candidate.headSha); assert.equal(migrated.treeSha, candidate.treeSha);
  assert.equal(await workspace.localAutocrlf(legacyDirectory), 'false');
  assert.equal(await workspace.localEol(legacyDirectory), 'lf');
  const migratedBytes = await readFile(path.join(legacyDirectory, manifest));
  assert.deepEqual(migratedBytes, canonical, `${git(legacyDirectory, 'config', '--local', '--list')}\n${git(legacyDirectory, 'ls-files', '--eol', '--', manifest)}\n${git(legacyDirectory, 'check-attr', 'text', 'eol', '--', manifest)}\n${git(legacyDirectory, 'status', '--porcelain')}\n${JSON.stringify([...migratedBytes])}`);

  // A dirty partial workspace must not be reset as part of migration.
  git(delivered, 'config', '--local', 'core.autocrlf', 'true');
  git(delivered, 'config', '--local', 'core.eol', 'crlf');
  const partial = path.join(delivered, 'partial-agent-work.txt');
  await writeFile(partial, 'Preserve this interrupted work.\n');
  await assert.rejects(() => workspace.assertCandidate({ workspace: delivered, headSha: candidate.headSha, treeSha: candidate.treeSha }), e => e.code === 'candidate_changed');
  assert.equal(await workspace.localAutocrlf(delivered), 'true');
  assert.equal(await readFile(partial, 'utf8'), 'Preserve this interrupted work.\n');
});
