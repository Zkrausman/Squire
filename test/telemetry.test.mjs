import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeTrace } from '../src/benchmark-report.mjs';
import { runProcess } from '../src/process.mjs';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { Controller } from '../src/controller.mjs';
import { Blocker } from '../src/contracts.mjs';
import { fixture } from './support.mjs';

test('summarizeTrace handles key reordering, explicit zero vs missing cache, cache > input, conflicts, and retry session sharing', () => {
  const base = {
    'ticket.transition': [{ type: 'ticket.transition', status: 'ready' }],
    job1: [
      { type: 'runtime.configured', jobId: 'j1', role: 'plan', requestedModel: 'gpt-5', requestedReasoning: 'high', reportedModel: null, reportedReasoning: null },
      { type: 'job.event', jobId: 'j1', role: 'plan', usage: { input_tokens: 100, output_tokens: 20 } },
      { type: 'job.event', jobId: 'j1', role: 'plan', usage: { output_tokens: 20, input_tokens: 100 } },
      { type: 'job.finished', jobId: 'j1', role: 'plan', outcome: 'completed' },
    ],
    job2: [
      { type: 'job.event', jobId: 'j2', role: 'implement', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10 } },
      { type: 'job.finished', jobId: 'j2', role: 'implement', outcome: 'completed' },
    ],
    job3: [
      { type: 'job.event', jobId: 'j3', role: 'review', usage: { input_tokens: 40, cached_input_tokens: 50, output_tokens: 5 } },
      { type: 'job.finished', jobId: 'j3', role: 'review', outcome: 'completed' },
    ],
    job4: [
      { type: 'job.event', jobId: 'j4', role: 'implement', usage: { input_tokens: 30, output_tokens: 10 } },
      { type: 'job.event', jobId: 'j4', role: 'implement', usage: { input_tokens: 35, output_tokens: 10 } },
      { type: 'job.finished', jobId: 'j4', role: 'implement', outcome: 'completed' },
    ],
    job5a: [
      { type: 'job.event', jobId: 'j5a', role: 'implement', sessionRef: 'sess-retry', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 5 } },
      { type: 'job.finished', jobId: 'j5a', role: 'implement', outcome: 'waiting_capacity', sessionRef: 'sess-retry' },
    ],
    job5b: [
      { type: 'job.event', jobId: 'j5b', role: 'implement', sessionRef: 'sess-retry', usage: { input_tokens: 25, cached_input_tokens: 5, output_tokens: 8 } },
      { type: 'job.finished', jobId: 'j5b', role: 'implement', outcome: 'completed', sessionRef: 'sess-retry' },
    ],
    jobPending: [
      { type: 'job.event', jobId: 'jp', role: 'implement', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 2 } },
    ],
  };

  const events = Object.values(base).flat();
  const summary = summarizeTrace(events, { startedAt: 1000, endedAt: 2000 });

  assert.equal(summary.sessions, 7);
  assert.equal(summary.pendingSessions, 1);
  assert.equal(summary.unknownUsageSessions, 3); // missing cache, invalid cache subset, real conflict
  assert.equal(summary.tokenTotalsComplete, false); // job1 has missing cache, job3/4 invalid, jp pending
  assert.equal(summary.cacheUsageIncomplete, true);
  assert.equal(summary.tokens.input, 245); // known inputs include partial cache and pending jobs
  assert.equal(summary.tokens.cachedInput, 12); // known valid cache counts only
  assert.equal(summary.tokens.noncachedInput, 93); // cannot derive noncached input when cache is unknown or invalid
  assert.equal(summary.tokens.output, 50); // retain known output even when cache is unknown or invalid

  const j1 = summary.jobs.find(j => j.id === 'j1');
  assert.equal(j1.conflictingUsage, undefined);
  assert.equal(j1.requestedModel, 'gpt-5');
  assert.equal(j1.requestedReasoning, 'high');
  assert.equal(j1.reportedModel, null);
  assert.equal(j1.reportedReasoning, null);

  const j4 = summary.jobs.find(j => j.id === 'j4');
  assert.equal(j4.conflictingUsage, true);
});

test('runProcess captures final stdout line without trailing newline alongside regular lines', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'proc-test-'));
  try {
    const lines = [];
    const script = 'process.stdout.write("line1\\n"); process.stdout.write("{\\"final\\":true}");';
    const res = await runProcess({
      argv: [process.execPath, '-e', script],
      cwd: dir,
      directory: dir,
      timeoutSeconds: 5,
      onLine: l => lines.push(l),
    });
    assert.deepEqual(lines, ['line1', '{"final":true}']);
    assert.equal(res.exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Controller preserves metadata and raw usage across success and timeout blocker', async (t) => {
  const f = await fixture(t);
  const controller = new Controller(f.store, f.config.id);

  // Success case
  controller.runtime = {
    async execute(job) {
      job.onEvent?.({ version: 1, jobId: job.id, type: 'runtime.configured', requestedModel: 'gpt-5-preview', requestedReasoning: 'medium', reportedModel: null, reportedReasoning: null });
      job.onEvent?.({ version: 1, jobId: job.id, type: 'thread.started', sessionRef: 'sess-1' });
      job.onEvent?.({ version: 1, jobId: job.id, type: 'turn.completed', usage: { input_tokens: 60, cached_input_tokens: 10, output_tokens: 15 } });
      return {
        outcome: 'completed',
        sessionRef: 'sess-1',
        usage: { input_tokens: 60, cached_input_tokens: 10, output_tokens: 15 },
        result: 'ok',
        requestedModel: 'gpt-5-preview',
        requestedReasoning: 'medium',
        reportedModel: null,
        reportedReasoning: null,
      };
    },
  };

  const completed = await controller.callAgent('implement', f.seed, f.root, 'inst-1');
  assert.equal(completed.outcome, 'completed');
  assert.equal(completed.requestedModel, 'gpt-5-preview');
  assert.equal(completed.reportedModel, null);

  // Failure / Timeout case
  controller.runtime = {
    async execute(job) {
      job.onEvent?.({ version: 1, jobId: job.id, type: 'runtime.configured', requestedModel: 'gpt-5-fail', requestedReasoning: 'low', reportedModel: null, reportedReasoning: null });
      job.onEvent?.({ version: 1, jobId: job.id, type: 'thread.started', sessionRef: 'sess-fail' });
      job.onEvent?.({ version: 1, jobId: job.id, type: 'turn.completed', usage: { input_tokens: 70, output_tokens: 25 } });
      throw new Blocker('runtime_failed', 'timeout', { receipt: { startedAt: 10, endedAt: 20, exitCode: 1, timedOut: true } });
    },
  };

  await assert.rejects(
    () => controller.callAgent('implement', f.seed, f.root, 'inst-2'),
    /timeout/
  );

  const events = f.store.events(controller.id);
  const finEvents = events.filter(e => e.type === 'job.finished');
  assert.equal(finEvents.length, 2);

  const [successFin, failFin] = finEvents;
  assert.equal(successFin.outcome, 'completed');
  assert.equal(successFin.requestedModel, 'gpt-5-preview');
  assert.equal(successFin.reportedModel, null);
  assert.deepEqual(successFin.usage, { input_tokens: 60, cached_input_tokens: 10, output_tokens: 15 });

  assert.equal(failFin.outcome, 'failed');
  assert.equal(failFin.requestedModel, 'gpt-5-fail');
  assert.equal(failFin.reportedModel, null);
  assert.deepEqual(failFin.usage, { input_tokens: 70, output_tokens: 25 });
});

test('all-zero usage is observed, absent usage and absent individual counts stay unknown', () => {
 const zero = { input_tokens:0, cached_input_tokens:0, output_tokens:0, reasoning_output_tokens:0 };
 const known = summarizeTrace([{type:'job.finished',jobId:'zero',outcome:'completed',usage:zero}]);
 assert.equal(known.unknownUsageSessions,0); assert.equal(known.tokenTotalsComplete,true);
 assert.deepEqual(known.jobs[0].usage,zero);
 const absent=summarizeTrace([{type:'job.finished',jobId:'missing',outcome:'failed'}]);
 assert.equal(absent.unknownUsageSessions,1); assert.equal(absent.tokenTotalsComplete,false); assert.equal(absent.jobs[0].usage,null);
 const partial=summarizeTrace([{type:'job.finished',jobId:'partial',outcome:'failed',usage:{input_tokens:7}}]);
 assert.equal(partial.tokens.input,7); assert.equal(partial.tokens.output,0); assert.equal(partial.unknownUsageSessions,1);
 assert.equal(partial.jobs[0].usage.output_tokens,undefined);
});

test('reasoning output must be a subset and malformed cached counts are unknown', () => {
 const r=summarizeTrace([{type:'job.finished',jobId:'bad',outcome:'completed',usage:{input_tokens:10,cached_input_tokens:-1,output_tokens:3,reasoning_output_tokens:4}}]);
 assert.equal(r.tokens.input,10); assert.equal(r.tokens.output,3); assert.equal(r.tokens.cachedInput,0); assert.equal(r.tokens.noncachedInput,0);
 assert.equal(r.tokens.reasoningOutput,0); assert.equal(r.cacheUsageIncomplete,true); assert.equal(r.reasoningUsageIncomplete,true);
});

test('actual Codex adapter with synthetic CLI retains exact selected model through success, failure, capacity, timeout and interruption', async t => {
 const root=await mkdtemp(path.join(tmpdir(),'telemetry-adapter-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const cli=path.join(root,'fake-cli.mjs');
 await writeFile(cli, `import {writeFile} from 'node:fs/promises';
const args=process.argv.slice(2),mode=args[0],value=k=>args[args.indexOf(k)+1];
let input='';for await(const chunk of process.stdin)input+=chunk;
await writeFile(value('-o'),'Synthetic implementation');
console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-session'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:80,cached_input_tokens:60,output_tokens:10}}));
if(mode==='capacity'){console.log(JSON.stringify({type:'turn.failed',error:{message:'quota exceeded',status:429}}));process.exitCode=1;}
if(mode==='failure')process.exitCode=1;
if(mode==='timeout'||mode==='interruption')setInterval(()=>{},1000);
`);
 for(const mode of ['success','failure','capacity','timeout','interruption']){
  await t.test(mode,async()=>{
   const runtime=new CodexRuntime({},root),events=[],abort=new AbortController();
   // Replace all catalog/auth/settings I/O; only the actual execute/parse path runs.
   runtime.preflight=async()=>{};
   runtime.settings=async()=>({model:'fixture-exact-model-tag',reasoning:'medium'});
   runtime.command=async()=>[process.execPath,cli,mode];
   const job={id:mode,role:'implement',workspace:root,directory:path.join(root,mode),instructions:'Synthetic fixture only',timeoutSeconds:mode==='timeout'?1:5,backoffSeconds:1,signal:abort.signal,onEvent:e=>{events.push(e);if(mode==='interruption'&&e.type==='turn.completed')abort.abort();}};
   let result,error;try{result=await runtime.execute(job);}catch(e){error=e;}
   const config=events.find(e=>e.type==='runtime.configured');
   assert.ok(config);assert.equal(config.requestedModel,'fixture-exact-model-tag');assert.equal(config.requestedReasoning,'medium');assert.equal(config.reportedModel,null);assert.equal(config.reportedReasoning,null);
   assert.deepEqual(events.find(e=>e.type==='turn.completed').usage,{input_tokens:80,cached_input_tokens:60,output_tokens:10});
   if(mode==='success'||mode==='capacity'){
    assert.equal(result.outcome,mode==='capacity'?'waiting_capacity':'completed');
    assert.equal(result.requestedModel,config.requestedModel);assert.equal(result.requestedReasoning,config.requestedReasoning);assert.equal(result.reportedModel,null);assert.equal(result.reportedReasoning,null);
    assert.equal(result.receipt.argv[result.receipt.argv.indexOf('-m')+1],config.requestedModel);
   }else{
    assert.equal(error.code,'runtime_failed');
    assert.equal(error.detail.receipt.timedOut,mode==='timeout');
    assert.equal(error.detail.receipt.stopped,mode==='timeout'||mode==='interruption');
   }
  });
 }
});

test('controller interruption retains streamed usage, model provenance and stopped receipt; retries use distinct job IDs', async t => {
 const f=await fixture(t),abort=new AbortController();
 const runtime={version:1,capabilities:{roles:['plan','implement','review'],freshSession:true,subscription:true,artifacts:'workspace',resume:false},async execute(job){
  job.onEvent({type:'runtime.configured',requestedModel:'fixture-interrupted',requestedReasoning:'medium',reportedModel:null,reportedReasoning:null});
  job.onEvent({type:'thread.started',sessionRef:'same-resumed-session'});
  job.onEvent({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}});
  abort.abort();assert.equal(job.signal.aborted,true);
  throw new Blocker('runtime_failed','Interrupted',{receipt:{startedAt:1,endedAt:2,exitCode:null,stopped:true,timedOut:false}});
 }};
 const controller=new Controller(f.store,f.config.id,{runtime});
 await assert.rejects(controller.callAgent('implement',f.seed,f.root,'synthetic',abort.signal),e=>e.code==='runtime_failed');
 runtime.execute=async job=>{
  job.onEvent({type:'runtime.configured',requestedModel:'fixture-retry',requestedReasoning:'low',reportedModel:null,reportedReasoning:null});
  return {outcome:'completed',sessionRef:'same-resumed-session',usage:{input_tokens:8,cached_input_tokens:2,output_tokens:1},result:'synthetic'};
 };
 await controller.callAgent('implement',f.seed,f.root,'retry');
 const events=f.store.events(f.config.id,0,1000),finished=events.filter(e=>e.type==='job.finished');
 assert.equal(finished.length,2);assert.notEqual(finished[0].jobId,finished[1].jobId);
 assert.equal(finished[0].receipt.stopped,true);assert.equal(finished[0].receipt.timedOut,false);assert.equal(finished[0].requestedModel,'fixture-interrupted');assert.equal(finished[0].reportedModel,null);
 assert.deepEqual(finished[0].usage,{input_tokens:12,output_tokens:3});assert.equal(finished[1].requestedModel,'fixture-retry');
 const summary=summarizeTrace(events);assert.equal(summary.sessions,2);assert.equal(summary.tokens.input,20);assert.equal(summary.tokens.output,4);assert.equal(summary.timeouts,0);assert.equal(summary.unknownUsageSessions,1);
 assert.ok(events.some(e=>e.type==='job.event'&&e.eventType==='runtime.configured'));
});

test('identical replayed complete usage snapshots deduplicate regardless of key order', () => {
 const usage={input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:10};
 const reordered={reasoning_output_tokens:10,output_tokens:20,cached_input_tokens:80,input_tokens:100};
 const summary=summarizeTrace([{type:'job.event',jobId:'one',usage},{type:'job.finished',jobId:'one',outcome:'completed',usage:reordered},{type:'job.finished',jobId:'one',outcome:'completed',usage}]);
 assert.equal(summary.sessions,1);assert.equal(summary.unknownUsageSessions,0);assert.equal(summary.tokens.input,100);assert.equal(summary.tokens.cachedInput,80);assert.equal(summary.tokens.noncachedInput,20);assert.equal(summary.tokens.output,20);assert.equal(summary.tokenTotalsComplete,true);
});
