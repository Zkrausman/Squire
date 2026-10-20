import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runForeground} from '../src/internal/limited-core.mjs';
import {createLimitedStreamCollector, validateTaskPayloadJson} from '../src/limited-stream-collector.mjs';
import {admitLimitedAgyTask} from '../src/limited-runner.mjs';
import {validateLimitedJobRecord} from '../src/limited-job-record.mjs';
const enc = x => new TextEncoder().encode(typeof x === 'string' ? x : JSON.stringify(x));
const payload = {summary: 'Limited runner', enforced_limits: ['bounded bytes'], known_limitations: ['no descendants'], containment_guarantee: 'none'};
const envelope = enc({status: 'SUCCESS', response: JSON.stringify(payload), usage: {input_tokens: 0, output_tokens: 4}});
const spec = {job_id: '12345678-1234-4abc-8def-123456789abc', task_scope: '/synthetic', requested_model: 'gemini-3.8-flash-high',
  effort: 'high', max_wall_clock_sec: 120, prompt_bytes: enc('Public text')};
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
function fixture({persist, noSpawn = false, killExits = false, scheduleHook} = {}) {
  let time = 0, badClock = false; const timers = [], kills = [], calls = [];
  const clock = {now() {if (badClock) throw Error('clock'); return time;}, schedule(delay, callback) {
    const timer = {at: time + delay, callback, active: true}; timers.push(timer); scheduleHook?.(delay,child); return () => {timer.active = false;};}};
  const child = new EventEmitter(); child.pid = 123; child.unref = () => calls.push('unref');
  for (const name of ['stdout', 'stderr']) {child[name] = new EventEmitter(); child[name].destroy = () => {child[name].emit('close');};}
  child.kill = signal => {kills.push(signal); if (killExits) child.emit('exit', null, signal); return true;};
  const shutdown = {term_grace_ms: 30, kill_grace_ms: 20, poll_interval_ms: 10, stream_drain_timeout_ms: 10, persistence_timeout_ms: 20};
  const controller = new AbortController();
  const result = runForeground({...spec, max_wall_clock_sec: 1, task_class: 'PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND'},
    {executable: '/synthetic/agy', args: ['closed']}, {shutdown, output_path: '/synthetic/output.json', abortSignal: controller.signal},
    {clock, spawn(exe, args, opts) {calls.push({exe, args, opts}); if (!noSpawn) queueMicrotask(() => child.emit('spawn')); return child;},
      persist: persist ?? (async () => {}), environment: {TMPDIR: '/synthetic/.tmp'}});
  return {child, result, kills, calls, controller,
    async advance(to) {time = to; for (const t of [...timers].sort((a,b) => a.at-b.at)) if (t.active && t.at <= time) {t.active = false; t.callback();} await flush();},
    failClock() {badClock = true;},
    earlyBudget() {const t=timers.find(t=>t.active&&t.at===1000);t.active=false;t.callback();},
    output(bytes = envelope) {child.stdout.emit('data', bytes); child.stdout.emit('end'); child.stderr.emit('end');},
    active: () => timers.filter(t => t.active).length};
}
test('limited child success preserves raw metrics, persists envelope, and claims no descendant cleanup', async () => {
  let saved; const f = fixture({persist: async bytes => {saved = new Uint8Array(bytes);}}); await flush();
  f.output(); f.child.emit('exit', 0, null); const r = await f.result;
  assert.equal(r.record.lifecycle_status, 'LIMITED_SUCCESS'); assert.equal(r.record.process_exit.observed_termination, true);
  assert.equal(r.record.provider_metadata.usage_tokens.input, 0); assert.equal(r.record.provider_metadata.usage_tokens.total, 'UNKNOWN');
  assert.equal(r.record.containment_evidence.descendant_guarantee, 'NONE'); assert.deepEqual(saved, envelope);
  assert.equal(r.record.task_outcome_evaluated, false); assert.equal(f.active(), 0); assert.deepEqual(f.kills, []);
  assert.deepEqual(f.calls[0].opts.stdio, ['ignore','pipe','pipe']); assert.equal(f.calls[0].opts.detached, false);
});
test('timeout attempts direct TERM then KILL and returns unsettled with passive late observation', async () => {
  const f = fixture(); await flush(); await f.advance(1000); assert.deepEqual(f.kills, ['SIGTERM']);
  await f.advance(1030); assert.deepEqual(f.kills, ['SIGTERM','SIGKILL']); await f.advance(1050);
  const r = await f.result; assert.equal(r.record.lifecycle_status, 'LIMITED_TIMEOUT');
  assert.equal(r.record.containment_evidence.settlement_status, 'ABANDONED_UNSETTLED'); assert.equal(r.record.process_exit.observed_termination, false);
  f.child.emit('error', Error('late')); f.child.stdout.emit('error', Error('late stream'));
  f.child.emit('exit', null, 'SIGKILL'); assert.equal(r.late_observations().length, 1);
  assert.equal(r.record.process_exit.observed_termination, false); assert.equal(f.active(), 0);
});
test('timeout raw exit cancels escalation; incomplete inherited pipes have a separate bounded drain', async () => {
  const f = fixture({killExits: true}); await flush(); await f.advance(1000); await f.advance(1010);
  const r = await f.result; assert.equal(r.record.lifecycle_status, 'LIMITED_TIMEOUT'); assert.equal(r.record.process_exit.exit_signal, 'SIGTERM');
  assert.equal(r.record.containment_evidence.settlement_status, 'SETTLED_DIRECT_CHILD_EXIT'); assert.equal(r.record.io_state.io_drained, false);
  await f.advance(1100); assert.deepEqual(f.kills, ['SIGTERM']);
});
test('abort remains user cancellation when later deadline expires', async () => {
  const f = fixture({killExits:true}); await flush(); f.controller.abort(); f.output(); await flush();
  assert.equal((await f.result).record.lifecycle_status, 'LIMITED_USER_ABORT'); assert.deepEqual(f.kills, ['SIGTERM']);
});
test('exit captured before clock failure retains integer and unknown wall', async () => {
  const f = fixture(); await flush(); f.output(); f.failClock(); f.child.emit('exit', 7, null);
  const r = await f.result; assert.equal(r.record.process_exit.exit_code, 7); assert.equal(r.record.process_exit.process_wall_ms, null);
  assert.equal(r.record.lifecycle_status, 'LIMITED_INTERNAL_ERROR'); assert.deepEqual(f.kills, []);
});
test('oversize stderr is counted/discarded and capacity remains distinct from termination', async () => {
  const f = fixture({killExits:true}); await flush(); f.child.stderr.emit('data', new Uint8Array(65537)); await f.advance(10);
  const r = await f.result; assert.equal(r.record.lifecycle_status, 'LIMITED_CAPACITY_EXCEEDED'); assert.equal(r.record.io_state.stderr_bytes_observed,65537);
});
test('nonzero provider wrapper fails without persistence or payload promotion', async () => {
  let writes = 0; const f = fixture({persist:async()=>{writes++;}}); await flush(); f.output(); f.child.emit('exit', 7, null);
  const r = await f.result; assert.equal(r.record.lifecycle_status, 'LIMITED_PROCESS_FAILED'); assert.equal(writes,0);
});
test('bounded persistence failure and user abort during persistence never become success', async () => {
  const f = fixture({persist:()=>new Promise(()=>{})}); await flush(); f.output(); f.child.emit('exit',0,null); await flush();
  await f.advance(20); assert.equal((await f.result).record.lifecycle_status,'LIMITED_PERSISTENCE_FAILED');
  let reject; const g = fixture({persist:(_,signal)=>new Promise((_,no)=>{reject=no;signal.addEventListener('abort',()=>no(Error('abort')));})});
  await flush(); g.output(); g.child.emit('exit',0,null); await flush(); g.controller.abort(); reject(Error('abort')); await flush();
  assert.equal((await g.result).record.lifecycle_status,'LIMITED_USER_ABORT');
});
test('missing spawn observation is bounded after abort and never reported as settled', async () => {
  const f = fixture({noSpawn:true}); f.controller.abort(); await f.advance(50);
  const r = await f.result; assert.equal(r.record.lifecycle_status,'LIMITED_USER_ABORT'); assert.equal(r.record.process_exit.observed_termination,false);
  assert.deepEqual(f.kills,[]);assert.ok(f.calls.includes('unref'));
  f.child.emit('spawn');f.child.emit('exit',0,null);assert.equal(r.late_observations().length,1);
  assert.equal(r.record.process_exit.observed_termination,false);assert.deepEqual(f.kills,[]);
});
test('collector exact cap, duplicate decoded keys, poison keys and invalid payload types', () => {
  const c=createLimitedStreamCollector(); assert.equal(c.chunk('stdout',new Uint8Array(1048576)),true);
  assert.equal(c.chunk('stdout',new Uint8Array(1)),false); c.close();
  for(const value of ['{"summary":"x","summary":"y"}', '{"constructor":{}}', JSON.stringify({...payload,known_limitations:[3]}), '\uFEFF{}'])
    assert.throws(()=>validateTaskPayloadJson(enc(value)));
  assert.deepEqual(validateTaskPayloadJson(enc(payload)),payload);
});
test('admission is AGY pinned, excludes arbitrary args/max_steps, and record rejects old cleanup claims', async () => {
  assert.equal(admitLimitedAgyTask(spec).requested_model,spec.requested_model);
  for(const bad of [{...spec,args:['x']},{...spec,max_steps:1},{...spec,requested_model:'other'}]) assert.throws(()=>admitLimitedAgyTask(bad));
  const f=fixture(); await flush();f.output();f.child.emit('exit',0,null);const {record}=await f.result;
  assert.throws(()=>validateLimitedJobRecord({...record,containment_evidence:{...record.containment_evidence,settlement_status:'CLEAN'}}));
});

test('deadline during persistence aborts publication and retains timeout outcome', async () => {
  let committed=false;
  const f=fixture({persist:(_,signal)=>new Promise((yes,no)=>{
    signal.addEventListener('abort',()=>{if(!signal.aborted) committed=true;no(Error('stopped'));});
  })});
  await flush();await f.advance(990);f.output();f.child.emit('exit',0,null);await flush();await f.advance(1000);
  const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_TIMEOUT');assert.equal(committed,false);
  assert.equal(r.record.output_custody.persisted,false);
});
test('job identity validation never invokes coercion hooks', async () => {
  let calls=0;const job_id={toString(){calls++;return spec.job_id;}};
  assert.throws(()=>admitLimitedAgyTask({...spec,job_id}));
  const f=fixture();await flush();f.output();f.child.emit('exit',0,null);const {record}=await f.result;
  assert.throws(()=>validateLimitedJobRecord({...record,job_id}));assert.equal(calls,0);
});

test('clock/scheduler initialization failures are INTERNAL rather than fabricated spawn failures', async () => {
  for (const kind of ['clock','scheduler','inline']) {
    let calls=0,canceled=0;
    const clock={now(){if(kind==='clock')throw Error('clock');return 0;},schedule(_,callback){if(kind==='scheduler')throw Error('timer');callback();return()=>{canceled++;};}};
    const r=await runForeground({...spec,task_class:'PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND'}, {executable:'/synthetic',args:[]},
      {shutdown:{term_grace_ms:30,kill_grace_ms:20,stream_drain_timeout_ms:10,persistence_timeout_ms:20}},
      {clock,spawn(){calls++;},persist:async()=>{},environment:{}});
    assert.equal(r.record.lifecycle_status,'LIMITED_INTERNAL_ERROR');assert.equal(calls,0);assert.equal(r.record.process_exit.pid,null);
    if(kind==='inline')assert.equal(canceled,1);
  }
});

test('timer handle returned after reentrant exit/completion is canceled', async () => {
  const f=fixture({scheduleHook(delay,child){if(delay===30){child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',null,'SIGTERM');}}});
  await flush();await f.advance(1000);const r=await f.result;
  assert.equal(r.record.lifecycle_status,'LIMITED_TIMEOUT');assert.equal(f.active(),0);assert.deepEqual(f.kills,['SIGTERM']);
});
test('overflowing derived deadline fails internally without spawn', async () => {
  let spawned=false;
  const r=await runForeground({...spec,task_class:'PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND'}, {executable:'/synthetic',args:[]},
    {shutdown:{}},{clock:{now:()=>Number.MAX_SAFE_INTEGER,schedule(){throw Error('unexpected');}},spawn(){spawned=true;},environment:{}});
  assert.equal(r.record.lifecycle_status,'LIMITED_INTERNAL_ERROR');assert.equal(spawned,false);
});

test('early original-budget callback remains armed through exited-child persistence', async () => {
  const f=fixture({persist:(_,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('deadline'))))});
  await flush();await f.advance(990);f.output();f.child.emit('exit',0,null);await flush();f.earlyBudget();await f.advance(1000);
  const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_TIMEOUT');assert.equal(r.record.output_custody.persisted,false);
});
