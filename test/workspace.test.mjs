import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { GitWorkspace } from '../src/workspace.mjs';
import { fixture } from './support.mjs';

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
  await assert.rejects(() => workspace.checkpoint({ workspace: directory, baseSha: prepared.baseSha, beforeAgentHead: prepared.baseSha, spec: { id: 'a', title: 'Root replacement' } }, f.config.services.app), e => e.code === 'protected_path');
});
