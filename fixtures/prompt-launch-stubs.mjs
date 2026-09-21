import { piJson } from "../dist/test/helpers/pi-json.js";
// Test-only Node preloader: real CLI + detached bootstrap, external services
// stubbed below the controller. No production environment injection surface.
import { appendFile, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
// Completed state precedes reservation/outbox cleanup. Signal actual child
// exit so the test does not remove its state directory while it is still used.
if (process.argv.includes('--reserved-run-id')) process.once('exit', code => writeFileSync(process.env.SQUIRE_FIXTURE_EXIT, String(code)));
import { NodeCommandRunner } from '../dist/src/personal/command.js';
import { DockerSandboxWorkspace } from '../dist/src/personal/docker-sandbox.js';
import { GitHubPublisher } from '../dist/src/personal/github-publisher.js';
import { NodeBackgroundLauncher } from '../dist/src/personal/background-launcher.js';
const head = 'a'.repeat(40);
const removeSources = async () => {
  await rm(process.env.SQUIRE_FIXTURE_CONFIG, { force: true });
  await rm(process.env.SQUIRE_FIXTURE_PROMPTS, { recursive: true, force: true });
};
// Exercise the real Linear adapter against the test's loopback HTTP server.
// A process-wide fetch fence prevents any missed prototype stub / accidental
// module duplicate from contacting a real service (notably on Windows URLs).
const fetch = globalThis.fetch;
globalThis.fetch = async function(url, options) {
  if (String(url) !== process.env.SQUIRE_FIXTURE_LINEAR) throw new Error('unexpected fixture external request');
  await appendFile(process.env.SQUIRE_FIXTURE_REQUESTS, JSON.stringify({ purpose: 'initial-ticket-fetch', pid: process.pid }) + '\n');
  return fetch(url, options);
};
DockerSandboxWorkspace.prototype.resolveSource = async () => head;
DockerSandboxWorkspace.prototype.prepare = async ({sandbox}) => ({ sandbox, baseSha: head, head });
DockerSandboxWorkspace.prototype.currentHead = async () => head;
DockerSandboxWorkspace.prototype.assertClean = async () => {};
DockerSandboxWorkspace.prototype.committedProjectWikiPaths = async () => [];
DockerSandboxWorkspace.prototype.exportBundle = async ({branch}) => ({ path: '/tmp/bundle', sha256: 'b'.repeat(64), byteLength: 1, baseSha: head, head, branch });
GitHubPublisher.prototype.publish = async () => ({ url: 'https://github.com/example/repo/pull/1', reused: false });
const launch = NodeBackgroundLauncher.prototype.launch;
NodeBackgroundLauncher.prototype.launch = async function(request) {
  await removeSources();
  // Deliberately change the child's environment after once-normalized capture.
  return launch.call(this, { ...request, env: { ...request.env, SQUIRE_DATA_DIR: '/wrong-child-root', SQUIRE_CONFIG: '/missing-child-config' } });
};
let input;
let stagingPath;
NodeCommandRunner.prototype.run = async function(request) {
  if (request.command === 'sbx' && request.args.some(argument => argument === '')) throw new Error('sandbox argv contains an empty element');
  if (request.args[0] === 'cp') {
    stagingPath = request.args[1];
    if (process.platform === 'win32') {
      const { assertProtectedAcl } = await import('../dist/test/helpers/windows-launch.js');
      assertProtectedAcl(stagingPath);
    }
    input = JSON.parse(await readFile(stagingPath, 'utf8'));
  }
  if (!request.args.includes('--print')) return { stdout: '', stderr: '' };
  const prompt = request.args[request.args.indexOf('--system-prompt') + 1];
  await appendFile(process.env.SQUIRE_FIXTURE_RECORD, JSON.stringify({ phase: input.phase, prompt, digest: input.launchDigest, promptDigest: input.systemPromptDigest, args: request.args, data: input, stagingPath }) + '\n');
  const details = {
    plan: { steps: ['implement'] },
    implement: { changes: ['no-op fixture'], projectWiki: { status: 'not_required', reason: 'fixture adds no knowledge' } },
    review: { findings: [] }, test: { commands: [{ command: 'npm test', exitCode: 0, summary: 'fixture passed' }] },
    retro: { lessons: ['fixture'], followUps: [] },
  }[input.phase];
  const stdout = JSON.stringify({ outputHead: head, status: 'passed', summary: 'fixture passed', details });
  const bytes = piJson(stdout, input.sessionId, input.profile);
  // Deliberately incomplete accounting, still a valid phase handoff. Its
  // terminal warning must never re-enter launch/ticket/controller execution.
  const stream = input.phase === 'review' ? Buffer.from(bytes.toString().split('\n').filter(Boolean).map(line => {
    const event = JSON.parse(line);
    if (event.message?.role === 'assistant' && event.message.usage) delete event.message.usage.cost;
    if (event.messages) for (const message of event.messages) if (message.role === 'assistant' && message.usage) delete message.usage.cost;
    return JSON.stringify(event);
  }).join('\n') + '\n') : bytes;
  return { stdout: stream.toString(), stdoutBytes: stream, stderr: '' };
};
