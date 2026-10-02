// Optional real subscription smoke check; never runs in the offline test suite.
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { runProcess } from '../src/process.mjs';

const root = path.resolve('.squire', `subscription-smoke-${randomUUID()}`), workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true, mode: 0o700 });
await writeFile(path.join(workspace, 'README.md'), '# Isolated Codex readiness probe\n');
const initialized = await runProcess({ argv: ['git', 'init', '-b', 'main'], cwd: workspace, directory: path.join(root, 'git'), timeoutSeconds: 30 });
if (initialized.exitCode !== 0) throw new Error('Could not initialize probe repository');
const runtime = new CodexRuntime({ kind: 'codex' }, root);
const result = await runtime.execute({ version: 1, id: randomUUID(), role: 'implement', workspace, directory: path.join(root, 'job'), timeoutSeconds: 180, backoffSeconds: 600,
  instructions: 'This is an isolated runtime readiness probe, not a software delivery ticket. Use a shell command to print the Node version and create readiness.txt in the current workspace containing exactly ready followed by a newline. Do not commit or touch other directories. Return a brief factual completion message.' });
if (result.outcome !== 'completed') { console.log(JSON.stringify({ ready: false, outcome: result.outcome, retryAt: result.retryAt, root })); process.exitCode = 2; }
else {
  const marker = await readFile(path.join(workspace, 'readiness.txt'), 'utf8').catch(() => '');
  const events = (await readFile(result.receipt.stdoutPath, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  const commandSucceeded = events.some(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code === 0);
  const ready = marker === 'ready\n' && commandSucceeded;
  const receipt = { ready, authentication: 'chatgpt', sessionRef: result.sessionRef, commandSucceeded, markerVerified: marker === 'ready\n', usage: result.usage, root };
  await writeFile(path.join(root, 'readiness.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt)); process.exitCode = ready ? 0 : 2;
}
