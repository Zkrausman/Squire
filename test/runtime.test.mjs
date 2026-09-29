import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { fixture } from './support.mjs';

const fakeCli = `import {readFile,writeFile} from 'node:fs/promises';
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
console.log(JSON.stringify({type:'audit',envSecretsPresent:['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','GH_TOKEN','GITHUB_TOKEN'].some(k=>process.env[k]),sandbox:value('--sandbox')}));
console.log(JSON.stringify({type:'thread.started',thread_id:'fresh-session'}));
if(process.env.SQUIRE_FAKE_RESULT==='quota'){console.log(JSON.stringify({type:'turn.failed',error:{message:'Usage limit reached; retry after reset'}}));process.exit(1);}
if(process.env.SQUIRE_FAKE_RESULT==='incomplete')process.exit(0);
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
test('read-only review uses structured schema; API-key login is rejected', async t => {
  const f = await runtimeFixture(t);
  const result = await f.runtime.execute({ id: 'job-2', role: 'review', workspace: f.seed, directory: path.join(f.runtimeRoot, 'job2'), instructions: 'Review', timeoutSeconds: 10, backoffSeconds: 60 });
  assert.equal(result.result.verdict, 'pass'); assert.ok(result.receipt.argv.includes('read-only')); assert.ok(result.receipt.argv.includes('--output-schema'));
  process.env.SQUIRE_FAKE_AUTH = 'api'; t.after(() => delete process.env.SQUIRE_FAKE_AUTH);
  await assert.rejects(() => f.runtime.preflight(), e => e.code === 'authentication');
});
test('quota failures checkpoint capacity; zero exit without completion fails closed', async t => {
  const f = await runtimeFixture(t); process.env.SQUIRE_FAKE_RESULT = 'quota'; t.after(() => delete process.env.SQUIRE_FAKE_RESULT);
  const job = { id: 'quota', role: 'implement', workspace: f.seed, directory: path.join(f.runtimeRoot, 'quota'), instructions: 'Implement', timeoutSeconds: 10, backoffSeconds: 60 };
  const result = await f.runtime.execute(job); assert.equal(result.outcome, 'waiting_capacity'); assert.ok(result.retryAt > Date.now());
  process.env.SQUIRE_FAKE_RESULT = 'incomplete'; await assert.rejects(() => f.runtime.execute({ ...job, directory: path.join(f.runtimeRoot, 'incomplete') }), e => e.code === 'runtime_failed');
});
