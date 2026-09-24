import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(repoRoot, 'mvp', 'run.mjs');
const ticket = 'Add one small change and keep it scoped.\n';
const planText = '# Plan\n\n1. Update the tracked file.\n2. Add a new file.\n';
const agentsText = '# Fixture instructions\nFollow the scoped fixture convention.\n';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'squire-mvp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRepo = path.join(directory, 'source');
  await mkdir(sourceRepo);
  git(sourceRepo, ['init', '--quiet']);
  git(sourceRepo, ['config', 'user.name', 'Squire Fixture']);
  git(sourceRepo, ['config', 'user.email', 'squire-fixture@example.invalid']);
  await writeFile(path.join(sourceRepo, 'tracked.txt'), 'before\n');
  await writeFile(path.join(sourceRepo, 'AGENTS.md'), agentsText);
  git(sourceRepo, ['add', 'tracked.txt', 'AGENTS.md']);
  git(sourceRepo, ['commit', '--quiet', '-m', 'fixture base']);
  const baseSha = git(sourceRepo, ['rev-parse', 'HEAD']);
  const ticketFile = path.join(directory, 'ticket.md');
  const resultRoot = path.join(directory, 'results');
  const captureFile = path.join(directory, 'fake-prompts.jsonl');
  const fakePi = path.join(directory, 'fake-pi.mjs');
  const configFile = path.join(directory, 'config.json');
  await writeFile(ticketFile, ticket);
  await writeFile(fakePi, `
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2);
const toolIndex = args.indexOf('--tools');
const tools = args[toolIndex + 1];
const stage = tools === 'read,grep,find,ls' ? 'plan' : 'implementation';
const sessionDir = args[args.indexOf('--session-dir') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
const model = args[args.indexOf('--model') + 1];
const thinking = args[args.indexOf('--thinking') + 1];
const context = args.includes('--no-context-files') ? '' : await readFile(path.join(process.cwd(), 'AGENTS.md'), 'utf8').catch(() => '');
await appendFile(process.env.SQUIRE_FAKE_CAPTURE, JSON.stringify({stage, tools, model, thinking, args, prompt, context, cwd: process.cwd()}) + '\\n');
await mkdir(sessionDir, {recursive: true});
if (stage === 'plan' && process.env.SQUIRE_FAKE_MODE === 'descendant') {
  process.stdout.write('{"partial":true}\\n');
  process.stderr.write('fake Pi stderr before timeout\\n');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore', 'inherit', 'ignore']});
  await writeFile(process.env.SQUIRE_FAKE_DESCENDANT_PID, String(descendant.pid));
  await new Promise(() => {});
}
const text = stage === 'plan' ? ${JSON.stringify(planText)} : 'Implementation complete.\\n';
const events = [
  {type:'session', version:3, id:'fake-session', timestamp:new Date().toISOString(), cwd:process.cwd()},
  {type:'message_end', message:{role:'assistant', stopReason:'stop', content:[{type:'text', text}]}},
];
if (process.env.SQUIRE_FAKE_MODE !== 'unsettled-plan' || stage !== 'plan') events.push({type:'agent_settled'});
const jsonl = events.map(event => JSON.stringify(event)).join('\\n') + '\\n';
await writeFile(path.join(sessionDir, 'fake-session.jsonl'), jsonl);
if (stage === 'implementation' && process.env.SQUIRE_FAKE_MODE?.startsWith('tamper-')) {
  const runDirectory = path.resolve(process.cwd(), '..');
  if (process.env.SQUIRE_FAKE_MODE.includes('plan')) {
    const planPath = path.join(runDirectory, 'plan.md');
    await chmod(planPath, 0o600);
    await writeFile(planPath, 'tampered plan');
  }
  if (process.env.SQUIRE_FAKE_MODE.includes('ticket')) {
    await writeFile(path.join(runDirectory, 'ticket.md'), 'tampered ticket');
  }
  if (process.env.SQUIRE_FAKE_MODE.includes('evidence')) {
    await appendFile(path.join(runDirectory, 'plan.jsonl'), 'tampered evidence\\n');
    await writeFile(path.join(runDirectory, 'unrecorded-evidence.txt'), 'unexpected write');
  }
}
if (stage === 'implementation' && process.env.SQUIRE_FAKE_NO_CHANGES !== '1') {
  await writeFile(path.join(process.cwd(), 'tracked.txt'), 'after\\n');
  await writeFile(path.join(process.cwd(), 'new-file.txt'), 'untracked artifact\\n');
}
process.stdout.write(jsonl);
if ((process.env.SQUIRE_FAKE_MODE === 'nonzero-plan' && stage === 'plan')
  || (process.env.SQUIRE_FAKE_MODE === 'tamper-plan-nonzero' && stage === 'implementation')) process.exitCode = 7;
`);
  await writeFile(configFile, JSON.stringify({ sourceRepo, baseSha, ticketFile, resultRoot }));
  return { directory, sourceRepo, baseSha, ticketFile, resultRoot, captureFile, fakePi, configFile };
}

async function invoke(f, extraEnv = {}, timeout = 30_000) {
  try {
    const result = await execFileAsync(process.execPath, [runner, f.configFile], {
      cwd: repoRoot,
      env: { ...process.env, PI_CLI_PATH: f.fakePi, SQUIRE_FAKE_CAPTURE: f.captureFile, ...extraEnv },
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function summary(result) {
  const text = result.stdout || result.stderr;
  const line = text.trim().split(/\r?\n/).at(-1);
  return JSON.parse(line);
}

async function runState(summaryRecord) {
  return JSON.parse(await readFile(path.join(summaryRecord.stateDir, 'state.json'), 'utf8'));
}

test('runs distinct constrained Pi sessions and retains an UNVERIFIED patch with untracked files', async t => {
  const f = await fixture(t);
  const result = await invoke(f);
  assert.equal(result.code, 0, JSON.stringify(await runState(summary(result))));
  const report = summary(result);
  assert.equal(report.phase, 'candidate');
  assert.equal(report.candidate.status, 'UNVERIFIED');

  const state = await runState(report);
  assert.equal(state.phase, 'candidate');
  assert.equal(state.candidate.status, 'UNVERIFIED');
  assert.equal(await readFile(path.join(report.stateDir, 'plan.md'), 'utf8'), planText);
  assert.equal(await readFile(path.join(report.stateDir, 'implementation-response.txt'), 'utf8'), 'Implementation complete.\n');
  const patch = await readFile(path.join(report.stateDir, 'candidate.patch'), 'utf8');
  assert.match(patch, /-before/);
  assert.match(patch, /\+after/);
  assert.match(patch, /new-file\.txt/);
  assert.match(patch, /untracked artifact/);
  assert.equal(await readFile(path.join(report.stateDir, 'candidate', 'tracked.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(path.join(report.stateDir, 'candidate', 'new-file.txt'), 'utf8'), 'untracked artifact\n');
  assert.equal(git(f.sourceRepo, ['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(f.sourceRepo, 'tracked.txt'), 'utf8'), 'before\n');

  const sessions = (await readFile(f.captureFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(x => [x.stage, x.tools, x.model, x.thinking]), [
    ['plan', 'read,grep,find,ls', 'gpt-6-sol', 'medium'],
    ['implementation', 'read,bash,edit,write', 'gpt-6-luna', 'max'],
  ]);
  for (const session of sessions) {
    for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve']) {
      assert.ok(session.args.includes(flag), `missing ${flag}`);
    }
    assert.equal(session.args.includes('--no-tools'), false);
  }
  assert.ok(sessions[0].prompt.includes(ticket));
  assert.ok(sessions[1].prompt.includes(ticket));
  assert.ok(sessions[1].prompt.includes(planText));
  for (const session of sessions) {
    assert.equal(session.args.includes('--no-context-files'), false);
    assert.match(session.prompt, /read and follow applicable AGENTS\.md/i);
    assert.equal(session.context.replace(/\r\n/g, '\n'), agentsText);
  }
  const manifest = JSON.parse(await readFile(path.join(report.stateDir, 'evidence-manifest.json'), 'utf8'));
  assert.ok(manifest.entries.some(entry => entry.path === 'plan.md' && entry.sha256));
  assert.ok(manifest.entries.some(entry => entry.path === 'ticket.md' && entry.sha256));
  assert.ok(manifest.entries.some(entry => entry.path === 'plan.jsonl' && entry.sha256));
  assert.equal((await readFile(path.join(report.stateDir, 'plan.jsonl'), 'utf8')).includes('agent_settled'), true);
  for (const directory of ['plan-session', 'implementation-session']) {
    assert.ok((await readdir(path.join(report.stateDir, directory))).includes('fake-session.jsonl'));
  }
});

test('rejects a nominally successful Pi process without settled final-stop evidence and retains logs', async t => {
  const f = await fixture(t);
  const result = await invoke(f, { SQUIRE_FAKE_MODE: 'unsettled-plan' });
  assert.equal(result.code, 1);
  const report = summary(result);
  assert.equal(report.phase, 'failed');
  const state = await runState(report);
  assert.equal(state.phase, 'failed');
  assert.match(state.error, /settle/);
  assert.ok((await readFile(path.join(report.stateDir, 'plan.jsonl'), 'utf8')).includes('stopReason'));
  assert.ok(await stat(path.join(report.stateDir, 'plan.stderr.log')));
  assert.ok(await stat(path.join(report.stateDir, 'plan-session', 'fake-session.jsonl')));
  assert.equal((await readFile(f.captureFile, 'utf8')).trim().split('\n').length, 1);
});

test('requires a zero process exit even when Pi emits a settled stop', async t => {
  const f = await fixture(t);
  const result = await invoke(f, { SQUIRE_FAKE_MODE: 'nonzero-plan' });
  assert.equal(result.code, 1);
  const report = summary(result);
  const state = await runState(report);
  assert.match(state.error, /exited with code 7/);
  assert.ok((await readFile(path.join(report.stateDir, 'plan.jsonl'), 'utf8')).includes('agent_settled'));
  assert.ok(await stat(path.join(report.stateDir, 'plan.stderr.log')));
});

test('restores the write-once plan and fails if the implementation session changes it', async t => {
  const f = await fixture(t);
  const result = await invoke(f, { SQUIRE_FAKE_MODE: 'tamper-plan' });
  assert.equal(result.code, 1);
  const report = summary(result);
  const state = await runState(report);
  assert.match(state.error, /plan.md changed/);
  assert.equal(await readFile(path.join(report.stateDir, 'plan.md'), 'utf8'), planText);
  assert.ok((await readFile(path.join(report.stateDir, 'implementation.jsonl'), 'utf8')).includes('agent_settled'));
});

test('checks and restores plan tampering even when Implement exits nonzero', async t => {
  const f = await fixture(t);
  const result = await invoke(f, { SQUIRE_FAKE_MODE: 'tamper-plan-nonzero' });
  assert.equal(result.code, 1);
  const report = summary(result);
  const state = await runState(report);
  assert.match(state.error, /plan\.md changed/);
  assert.equal(await readFile(path.join(report.stateDir, 'plan.md'), 'utf8'), planText);
  assert.ok((await readFile(path.join(report.stateDir, 'implementation.jsonl'), 'utf8')).includes('agent_settled'));
});

test('detects ticket and plan-evidence tampering and restores the ticket snapshot', async t => {
  const f = await fixture(t);
  const result = await invoke(f, { SQUIRE_FAKE_MODE: 'tamper-ticket-evidence' });
  assert.equal(result.code, 1);
  const report = summary(result);
  const state = await runState(report);
  assert.match(state.error, /ticket\.md/);
  assert.match(state.error, /plan\.jsonl/);
  assert.match(state.error, /unrecorded-evidence\.txt/);
  assert.equal(await readFile(path.join(report.stateDir, 'ticket.md'), 'utf8'), ticket);
});

test('times out without waiting for a descendant that inherited stdout and kills the process tree', { timeout: 12_000 }, async t => {
  const f = await fixture(t);
  const pidFile = path.join(f.directory, 'descendant.pid');
  const startedAt = Date.now();
  const result = await invoke(f, {
    SQUIRE_FAKE_MODE: 'descendant',
    SQUIRE_FAKE_DESCENDANT_PID: pidFile,
    SQUIRE_TEST_TIMEOUT_MS: '300',
  }, 6_000);
  assert.equal(result.code, 1);
  const report = summary(result);
  const state = await runState(report);
  assert.match(state.error, /plan Pi timed out/);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.match(await readFile(path.join(report.stateDir, 'plan.jsonl'), 'utf8'), /partial/);
  assert.match(await readFile(path.join(report.stateDir, 'plan.stderr.log'), 'utf8'), /fake Pi stderr before timeout/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  let running = true;
  const deadline = Date.now() + 2_000;
  while (running && Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
    if (running) await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(running, false, `descendant ${pid} survived timeout`);
});

test('reports no-candidate separately and does not call it success', async t => {
  const f = await fixture(t);
  const result = await invoke(f, { SQUIRE_FAKE_NO_CHANGES: '1' });
  assert.equal(result.code, 2, JSON.stringify(await runState(summary(result))));
  const report = summary(result);
  assert.equal(report.phase, 'no-candidate');
  assert.equal(report.candidate, null);
  const state = await runState(report);
  assert.equal(state.phase, 'no-candidate');
  assert.equal(state.candidate, null);
  await assert.rejects(stat(path.join(report.stateDir, 'candidate.patch')));
  assert.equal((await readFile(path.join(report.stateDir, 'candidate', 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'before\n');
});
