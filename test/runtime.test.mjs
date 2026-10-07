import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { readJobEvidence } from '../src/job-evidence.mjs';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { fixture } from './support.mjs';

const fakeCli = `import {readFile,writeFile,access} from 'node:fs/promises';
const args=process.argv.slice(2), value=k=>args[args.indexOf(k)+1];
if(!args.includes('forced_login_method="chatgpt"'))throw new Error('Missing forced subscription auth');
if(args.includes('login')){console.error(process.env.SQUIRE_FAKE_AUTH==='api'?'Logged in using an API key':'Logged in using ChatGPT');process.exit(0);}
if(args.includes('app-server')){
 const {createInterface}=await import('node:readline');
 for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line); if(request.id===undefined)continue;
  const result=request.method==='account/read'?{account:{type:'chatgpt',planType:'plus'}}:request.method==='model/list'?{data:[{model:'fixture-model',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}:{};
  console.log(JSON.stringify({id:request.id,result}));
 } process.exit(0);
}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const addDir=args.includes('--add-dir')?value('--add-dir'):null, tempPath=process.env.TEMP||process.env.TMP||process.env.TMPDIR;
let tempExists=false;if(tempPath){try{await access(tempPath);tempExists=true;}catch{}}
console.log(JSON.stringify({type:'audit',envSecretsPresent:['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','GH_TOKEN','GITHUB_TOKEN'].some(k=>process.env[k]),sandbox:value('--sandbox'),addDir,tempVars:{TEMP:process.env.TEMP??null,TMP:process.env.TMP??null,TMPDIR:process.env.TMPDIR??null},tempExists,authForced:args.includes('forced_login_method="chatgpt"')}));
console.log(JSON.stringify({type:'thread.started',thread_id:'fresh-session'}));
if(process.env.SQUIRE_FAKE_RESULT==='quota'){console.log(JSON.stringify({type:'turn.failed',error:{message:'Usage limit reached; retry after reset'}}));process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='status429'){console.log(JSON.stringify({type:'turn.failed',error:{message:'Request rejected',status:429}}));process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='stderrlimit'){console.error('Usage limit reached; retry after reset');process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='http429'){console.error('HTTP/2 429 Too Many Requests');process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='timestamp429'){console.error('2026-09-30T20:04:56.429098Z');process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='path429'){console.error('cache path C:/worker/jobs/429/run.log');process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='bare429'){console.error('diagnostic value 429 without an HTTP status');process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='timeout429'){console.error('Usage limit reached; HTTP/2 429 at 2026-09-30T20:04:56.429098Z');await new Promise(resolve=>setTimeout(resolve,5000));process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='stop429'){console.error('Quota exceeded; HTTP/2 429');await new Promise(resolve=>setTimeout(resolve,5000));process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='incomplete')process.exit(0);
if(process.env.SQUIRE_FAKE_RESULT==='schema'){console.log(JSON.stringify({type:'turn.failed',error:{message:'Invalid schema: checklist missing from required'}}));process.exit(1);}
const schema=args.includes('--output-schema')?JSON.parse(await readFile(value('--output-schema'),'utf8')):null;
const result=schema?JSON.stringify({headSha:'a'.repeat(40),verdict:'pass',summary:'fine',findings:[]}):'Implemented';
await writeFile(value('-o'),result);console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));`;

async function runtimeFixture(t) {
  const f = await fixture(t), cli = path.join(f.root, 'codex-fixture.mjs'); await writeFile(cli, fakeCli);
  const runtimeRoot = path.join(f.root, 'runtime'); await mkdir(runtimeRoot);
  const runtime = new CodexRuntime({ kind: 'codex', command: [process.execPath, cli] }, runtimeRoot);
  return { ...f, runtime, runtimeRoot };
}
test('explicit unavailable project model fails instead of substituting a catalog default', async t => {
  const f = await runtimeFixture(t); f.runtime.config.model = 'unavailable-model';
  await assert.rejects(() => f.runtime.preflight(), e => e.code === 'runtime_model');
});

test('role model routing reaches actual CLI argv and unsupported role effort fails closed', async t => {
  const f = await runtimeFixture(t);
  f.runtime.config.roles = { implement: { model: 'fixture-model', reasoning: 'high' }, review: { model: 'fixture-model', reasoning: 'low' } };
  const job = { id: 'routing', workspace: f.seed, instructions: 'Execute', timeoutSeconds: 10, backoffSeconds: 60 };
  const implementation = await f.runtime.execute({ ...job, role: 'implement', directory: path.join(f.runtimeRoot, 'routing-impl') });
  const review = await f.runtime.execute({ ...job, role: 'review', directory: path.join(f.runtimeRoot, 'routing-review') });
  assert.ok(implementation.receipt.argv.includes('model_reasoning_effort="high"'));
  assert.ok(review.receipt.argv.includes('model_reasoning_effort="low"'));
  assert.equal(implementation.receipt.argv[implementation.receipt.argv.indexOf('-m') + 1], 'fixture-model');
  f.runtime.config.roles.review.reasoning = 'max';
  await assert.rejects(() => f.runtime.preflight(), e => e.code === 'runtime_model');
  f.runtime.config.roles.review = { model: 'unavailable-model' };
  await assert.rejects(() => f.runtime.preflight(), e => e.code === 'runtime_model');
});
test('subscription adapter forces ChatGPT, strips paid API credentials, uses bounded fresh jobs', async t => {
  const f = await runtimeFixture(t);
  const original = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-secret';
  t.after(() => { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });
  const result = await f.runtime.execute({ id: 'job-1', role: 'implement', workspace: f.seed, directory: path.join(f.runtimeRoot, 'job1'), instructions: 'Implement fixture', timeoutSeconds: 10, backoffSeconds: 60 });
  assert.equal(result.outcome, 'completed'); assert.equal(result.result, 'Implemented'); assert.equal(result.sessionRef, 'fresh-session');
  const { readFile } = await import('node:fs/promises'); const log = await readFile(result.receipt.stdoutPath, 'utf8');
  assert.match(log, /"envSecretsPresent":false/); assert.match(log, /"sandbox":"workspace-write"/);
  assert.ok(result.receipt.argv.includes('--ephemeral'));
});
test('only implementation receives a task-owned test temp directory', async t => {
  const f = await runtimeFixture(t);
  const implJob = { id: 'temp-impl', role: 'implement', workspace: f.seed, directory: path.join(f.runtimeRoot, 'temp-impl'), instructions: 'Implement and test', timeoutSeconds: 10, backoffSeconds: 60 };
  const implementation = await f.runtime.execute(implJob);
  const workerTemp = path.join(implJob.directory, 'worker-temp');
  const implAudit = JSON.parse((await readFile(implementation.receipt.stdoutPath, 'utf8')).split('\n')[0]);
  assert.equal(implAudit.sandbox, 'workspace-write');
  assert.equal(implAudit.authForced, true); assert.equal(implAudit.envSecretsPresent, false);
  assert.equal(implAudit.addDir, workerTemp); assert.equal(implAudit.tempExists, true);
  assert.deepEqual(implAudit.tempVars, { TEMP: workerTemp, TMP: workerTemp, TMPDIR: workerTemp });
  assert.deepEqual(implementation.receipt.argv.slice(implementation.receipt.argv.indexOf('--add-dir'), implementation.receipt.argv.indexOf('--add-dir') + 2), ['--add-dir', workerTemp]);
  const implementationPrompt = await readFile(path.join(implJob.directory, 'prompt.txt'), 'utf8');
  assert.match(implementationPrompt, /meaningful non-GUI tests/);
  assert.match(implementationPrompt, /Do not change filesystem ACLs/);

  const reviewJob = { id: 'temp-review', role: 'review', workspace: f.seed, directory: path.join(f.runtimeRoot, 'temp-review'), instructions: 'Review', timeoutSeconds: 10, backoffSeconds: 60 };
  const review = await f.runtime.execute(reviewJob);
  const reviewAudit = JSON.parse((await readFile(review.receipt.stdoutPath, 'utf8')).split('\n')[0]);
  assert.equal(reviewAudit.sandbox, 'read-only'); assert.equal(reviewAudit.addDir, null);
  assert.ok(!review.receipt.argv.includes('--add-dir'));
  assert.ok(!Object.values(reviewAudit.tempVars).includes(path.join(reviewJob.directory, 'worker-temp')));
  await assert.rejects(() => access(path.join(reviewJob.directory, 'worker-temp')));

  const planJob = { id: 'temp-plan', role: 'plan', workspace: f.seed, directory: path.join(f.runtimeRoot, 'temp-plan'), instructions: 'Plan', timeoutSeconds: 10, backoffSeconds: 60 };
  const plan = await f.runtime.execute(planJob);
  const planAudit = JSON.parse((await readFile(plan.receipt.stdoutPath, 'utf8')).split('\n')[0]);
  assert.equal(planAudit.sandbox, 'read-only'); assert.equal(planAudit.addDir, null);
  assert.ok(!plan.receipt.argv.includes('--add-dir'));
  assert.ok(!Object.values(planAudit.tempVars).includes(path.join(planJob.directory, 'worker-temp')));
  await assert.rejects(() => access(path.join(planJob.directory, 'worker-temp')));
});
test('read-only review uses structured schema; API-key login is rejected', async t => {
  const f = await runtimeFixture(t);
  const result = await f.runtime.execute({ id: 'job-2', role: 'review', workspace: f.seed, directory: path.join(f.runtimeRoot, 'job2'), instructions: 'Review', timeoutSeconds: 10, backoffSeconds: 60 });
  assert.equal(result.result.verdict, 'pass'); assert.ok(result.receipt.argv.includes('read-only')); assert.ok(result.receipt.argv.includes('--output-schema'));
  process.env.SQUIRE_FAKE_AUTH = 'api'; t.after(() => delete process.env.SQUIRE_FAKE_AUTH);
  await assert.rejects(() => f.runtime.preflight(), e => e.code === 'authentication');
});
test('capacity failures require capacity context and local timeout takes precedence', async t => {
  const f = await runtimeFixture(t), original = process.env.SQUIRE_FAKE_RESULT;
  t.after(() => { if (original === undefined) delete process.env.SQUIRE_FAKE_RESULT; else process.env.SQUIRE_FAKE_RESULT = original; });
  const job = { id: 'capacity', role: 'implement', workspace: f.seed, directory: path.join(f.runtimeRoot, 'capacity'), instructions: 'Implement', timeoutSeconds: 10, backoffSeconds: 60 };
  for (const mode of ['quota', 'status429', 'stderrlimit', 'http429']) {
    process.env.SQUIRE_FAKE_RESULT = mode;
    const result = await f.runtime.execute({ ...job, id: mode, directory: path.join(f.runtimeRoot, mode) });
    assert.equal(result.outcome, 'waiting_capacity', mode); assert.ok(result.retryAt > Date.now(), mode);
  }
  for (const mode of ['timestamp429', 'path429', 'bare429']) {
    process.env.SQUIRE_FAKE_RESULT = mode;
    await assert.rejects(() => f.runtime.execute({ ...job, id: mode, directory: path.join(f.runtimeRoot, mode) }), error =>
      error.code === 'runtime_failed' && error.detail.receipt.timedOut === false, mode);
  }
  process.env.SQUIRE_FAKE_RESULT = 'timeout429';
  await assert.rejects(() => f.runtime.execute({ ...job, id: 'timeout429', directory: path.join(f.runtimeRoot, 'timeout429'), timeoutSeconds: 1 }), error =>
    error.code === 'runtime_failed' && error.detail.receipt.timedOut === true, 'local timeout outranks capacity-like output');
  process.env.SQUIRE_FAKE_RESULT = 'stop429';
  const cancellation = new AbortController();
  await assert.rejects(() => f.runtime.execute({ ...job, id: 'stop429', directory: path.join(f.runtimeRoot, 'stop429'), timeoutSeconds: 10,
    signal: cancellation.signal, onEvent: event => { if (event.type === 'thread.started') cancellation.abort(); } }), error =>
    error.code === 'runtime_failed' && error.detail.receipt.stopped === true && error.detail.receipt.timedOut === false,
  'local cancellation outranks capacity-like output');
  process.env.SQUIRE_FAKE_RESULT = 'incomplete';
  await assert.rejects(() => f.runtime.execute({ ...job, directory: path.join(f.runtimeRoot, 'incomplete') }), e => e.code === 'runtime_failed');
});

test('invalid response schema is infrastructure failure rather than application repair', async t => {
  const f = await runtimeFixture(t); process.env.SQUIRE_FAKE_RESULT = 'schema'; t.after(() => delete process.env.SQUIRE_FAKE_RESULT);
  await assert.rejects(() => f.runtime.execute({ id: 'schema', role: 'review', workspace: f.seed, directory: path.join(f.runtimeRoot, 'schema'), instructions: 'Review', timeoutSeconds: 10, backoffSeconds: 60 }), e => e.code === 'runtime_schema');
});

test('controller retains immutable Codex artifact and process provenance using only the fake CLI', async t => {
  const f = await runtimeFixture(t);
  const controller = new Controller(f.store, f.config.id, { runtime: f.runtime });
  const result = await controller.callAgent('implement', f.seed, path.join(f.root, 'logical-job'), 'Fixture task', undefined);
  const terminal = await readJobEvidence(result.evidence.directory, result.jobId);
  assert.equal(terminal.outcome, 'completed');
  assert.ok(terminal.artifacts.some(item => item.file === 'prompt.txt'));
  assert.ok(terminal.artifacts.some(item => item.file === 'result.txt'));
  assert.equal(terminal.process.operationId, result.receipt.operationId);
  assert.ok(terminal.spool.records >= 2);
  const before = await readFile(path.join(result.evidence.directory, 'prompt.txt'));
  await assert.rejects(() => f.runtime.execute({ id: result.jobId, role: 'implement', workspace: f.seed, directory: result.evidence.directory, instructions: 'replacement', timeoutSeconds: 10 }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path.join(result.evidence.directory, 'prompt.txt')), before);
});
