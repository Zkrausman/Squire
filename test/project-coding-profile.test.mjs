import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {
  PROJECT_CODING_OBSERVATION_PROFILE as PROFILE,
  PROJECT_CODING_OBSERVATION_CONFIG_SCHEMA as CONFIG,
  PROJECT_CODING_OBSERVATION_RESULT_SCHEMA as RESULT,
  PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA as RECEIPT,
  validateProjectCodingObservationProfile,resolveProjectCodingProfile,
  validateProjectCodingObservationOutcome
} from '../src/project-coding-profile.mjs';
import {
  prepareDesktopCodingObservationTask,prepareDesktopCodegenTask,
  validateDesktopCodegenConfig,validateProjectCodexConfig,
  DESKTOP_CODEGEN_SOURCE_FILES,PROJECT_SOURCE_ROOT,PROJECT_SOURCE_FILES,
  requireDesktopCodegenAdmission
} from '../src/project-configuration.mjs';
import {buildProjectCodegenPrompt} from '../src/project-task.mjs';
import {DESKTOP_TARGET,DESKTOP_PREFIX_IDENTITY} from '../src/desktop-profile.mjs';
import {buildDesktopCodegenInvocation} from '../acceptance/project-entrypoint.mjs';
import {admitProjectCodexTask,admitDesktopCodegenProjectTask,runProjectCodexTask} from '../src/project-runner.mjs';
import {runForeground} from '../src/internal/limited-core.mjs';
import {
  GENERATION_SHUTDOWN,canonicalBytes,hash,verifyExactFile,NODE_RUNTIME,
  FIXTURE_FREEZE_SHA256
} from '../src/bounded-codegen-plan.mjs';
import {
  SOURCE_FILES,validateCodexOperationConfig,CODEX_ENVIRONMENT_POLICY,
  PUBLIC_FREEZE_ROOT,codexFixtureConfigurations
} from '../src/bounded-codegen-configuration.mjs';
import {
  SINGLE_JS_SOURCE_FILES,SINGLE_JS_SOURCE_ROOT,SINGLE_JS_ENVIRONMENT_POLICY,
  validateSingleJsCodexConfig
} from '../src/single-js-configuration.mjs';
import {RETENTION_POLICY} from '../src/local-rejected-retention.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {
  createNativeProjectCodingObservationResultReceipt as create,
  writeNativeProjectCodingObservationResultReceipt as write,
  createNativeProjectResultReceipt,writeNativeProjectResultReceipt
} from '../src/project-result-receipt.mjs';
import {
  projectNativeProjectCodingObservationRunSummary as project,
  formatNativeProjectCodingObservationSummaryTerminal as format,
  projectNativeProjectRunSummary
} from '../src/project-summary.mjs';
import {runOfflineReportCli} from '../bin/squire-report.mjs';

// All producers, clocks and source preparations are synthetic. Only owned
// disposable fixture data uses the native filesystem; no generated file runs.
const enc=s=>new TextEncoder().encode(s),clone=v=>structuredClone(v);
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
let serial=1;
const id=()=>`a2c339ec-56a4-4fa5-8d12-${String(serial++).padStart(12,'0')}`;
const request={
  schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'observation-synthetic',
  task_prompt:'Public synthetic source fixture.',runtime_target:DESKTOP_TARGET,
  stage_target:'multifile-candidate'
};
const desktop=()=>({
  status:'NOT_QUALIFIED',
  executable:{path:'/prospective/gjs',bytes:1,sha256:'a'.repeat(64)},
  typelibs:[{namespace:'Gtk',version:'4.0',typelib:'/prospective/Gtk.typelib',bytes:1,sha256:'b'.repeat(64)}],
  libraries:[{name:'gtk',path:'/prospective/libgtk.so',bytes:1,sha256:'c'.repeat(64)}]
});
const authorization={
  operator_receipt:'/PRIVATE_OPERATOR_SENTINEL',
  supported_tuples:[{model:'synthetic-model',effort:'medium'}]
};
const permissions={sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'};
function privateInputs(scope){
  return {
    job_id:id(),scope,codex:{path:'/synthetic/codex',version:'0.160.0',bytes:1,sha256:'d'.repeat(64)},
    requested_model:'synthetic-model',effort:'medium',authorization,permissions,
    desktop_runtime_identity:desktop()
  };
}
function memoryPreparation(){
  const files=new Map(),effects=[];
  for(const name of DESKTOP_CODEGEN_SOURCE_FILES)files.set(join(PROJECT_SOURCE_ROOT,name),enc(`Public source ${name}`));
  return {
    files,effects,
    ports:{
      fs:{
        async readFile(path){assert.ok(files.has(path));return new Uint8Array(files.get(path));},
        async mkdir(path,options){effects.push(['mkdir',path]);assert.equal(options.mode,0o700);},
        async writeFile(path,bytes,options){
          effects.push(['write',path]);assert.equal(options.flag,'wx');assert.equal(options.mode,0o600);
          assert.equal(files.has(path),false);files.set(path,new Uint8Array(bytes));
        }
      },
      async verifyFile(pin){assert.equal(pin.path.startsWith('/prospective/'),false);},
      retention:()=>({prepare:async()=>({capability_status:'READY'})})
    }
  };
}
async function prepared(observation=true){
  const m=memoryPreparation(),inputs=privateInputs('/synthetic/scope-'+id()),root='/synthetic/prepared-'+id();
  const ack=await (observation?prepareDesktopCodingObservationTask:prepareDesktopCodegenTask)(
    root,'e'.repeat(40),request,inputs,m.ports);
  const bytes=m.files.get(join(root,'config.json'));
  return {...m,inputs,root,ack,bytes,config:parseReceiptJson(bytes),
    manifest:parseReceiptJson(m.files.get(join(root,'operation-manifest.json')))};
}
const sourceEnvelope=' \n'+JSON.stringify({
  schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',
  files:[{path:'main.js',classification:'SOURCE',encoding:'utf-8',content:'// PRIVATE_SOURCE_SENTINEL\nexport const fixture = 1;\n'}]
})+'\t';
const stream=(response=sourceEnvelope)=>enc([
  {type:'turn.started'},
  {type:'item.completed',item:{type:'agent_message',text:response}},
  {type:'turn.completed',usage:{input_tokens:0,output_tokens:2,cached_input_tokens:0,reasoning_output_tokens:0}}
].map(v=>JSON.stringify(v)).join('\n')+'\n');
function runtime(){
  let time=0;
  const timers=[],calls=[],kills=[],controller=new AbortController(),child=new EventEmitter();
  child.pid=51;child.unref=()=>{};child.kill=signal=>{kills.push(signal);return true;};
  for(const key of ['stdin','stdout','stderr']){
    child[key]=new EventEmitter();child[key].destroy=()=>{};
  }
  child.stdin.write=(bytes,callback)=>{callback();return true;};
  child.stdin.end=callback=>{callback();child.stdin.emit('finish');};
  const clock={
    now:()=>time,
    schedule(delay,fn){
      assert.ok(Number.isSafeInteger(delay)&&delay>=0);
      const timer={at:time+delay,delay,fn,active:true};timers.push(timer);
      return()=>{timer.active=false;};
    }
  };
  return {
    clock,timers,calls,kills,controller,child,
    spawn(...args){calls.push(args);queueMicrotask(()=>child.emit('spawn'));return child;},
    async advance(value){
      time=value;
      for(;;){
        const timer=timers.filter(t=>t.active&&t.at<=time).sort((a,b)=>a.at-b.at)[0];
        if(!timer)break;timer.active=false;timer.fn();await flush();
      }
      await flush();
    },
    setTime(value){time=value;},
    complete(response=sourceEnvelope,code=0){
      child.stdout.emit('data',stream(response));child.stdout.emit('end');
      child.stderr.emit('end');child.emit('exit',code,null);
    }
  };
}
async function owned(fn){
  const root=await fs.mkdtemp(join(tmpdir(),'squire-observation-'));
  await fs.chmod(root,0o700);
  try{return await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
async function until(predicate){
  for(let i=0;i<1000;i++){
    if(predicate())return;
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.fail('synthetic fixture did not reach expected state');
}
function launch(root,rt,observation=true){
  const spec={
    job_id:id(),task_scope:root,requested_model:'synthetic-model',effort:'medium',
    max_wall_clock_sec:observation?null:120,prompt_bytes:buildProjectCodegenPrompt(request),
    runtime_target:DESKTOP_TARGET,prefix_identity:DESKTOP_PREFIX_IDENTITY,
    desktop_runtime_identity:desktop(),
    ...(observation?{execution_profile:PROFILE}:{})
  };
  return {
    spec,options:{clock:rt.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:rt.controller.signal},
    ports:{
      fs,uid:process.getuid(),spawn:rt.spawn,executable:'/synthetic/codex',
      mode:'DESKTOP_CODEGEN_ONLY',operation_intent:'CODEGEN_ONLY_NO_DESKTOP_EXECUTION',
      codex:{observed_cli_version:'0.160.0',authorization,permissions},environment:{}
    }
  };
}
test('N01 fixed descriptors reject traps and every mixed tuple without invoking hooks',()=>{
  assert.equal(validateProjectCodingObservationProfile(clone(PROFILE)),PROFILE);
  assert.equal(Object.isFrozen(PROFILE),true);
  assert.deepEqual(resolveProjectCodingProfile(),{
    generation_wall_ms:120000,outer_observation_ms:140000,post_generation_closeout_ms:null
  });
  let hooks=0;
  const getter={...PROFILE};Object.defineProperty(getter,'id',{get(){hooks++;throw 0;}});
  const proxy=new Proxy({...PROFILE},{ownKeys(){hooks++;throw 0;}});
  for(const value of [
    null,{},getter,proxy,{...PROFILE,id:'UNKNOWN'},{...PROFILE,extra:1},
    {...PROFILE,generation_wall_ms:0},{...PROFILE,generation_wall_ms:NaN},
    {...PROFILE,outer_observation_ms:260000},{...PROFILE,post_generation_closeout_ms:-1},
    {...PROFILE,toJSON(){hooks++;throw 0;}}
  ])assert.throws(()=>validateProjectCodingObservationProfile(value));
  assert.equal(hooks,0);
});
test('N01 preparation binds only explicit observation schema, profile, hashes and active source closure',async()=>{
  const f=await prepared(),c=validateDesktopCodegenConfig(f.config);
  assert.equal(c.schema,CONFIG);assert.equal(c.generation_wall_ms,null);assert.equal(c.outer_observation_ms,null);
  assert.deepEqual(c.execution_profile,Object.assign(Object.create(null),PROFILE));
  assert.equal(f.manifest.schema,'SQUIRE2_DESKTOP_CODING_OBSERVATION_PREPARED_MANIFEST_V1');
  assert.deepEqual(f.manifest.execution_profile,Object.assign(Object.create(null),PROFILE));
  assert.equal(f.manifest.generation.wall_ms,null);assert.equal(f.manifest.limits.outer_observation_ms,null);
  assert.equal(f.manifest.config_sha256,hash(f.bytes));assert.equal(f.ack.runtime_admitted,false);
  for(const name of ['src/project-coding-profile.mjs','src/internal/limited-core.mjs']){
    assert.ok(PROJECT_SOURCE_FILES.includes(name));assert.ok(DESKTOP_CODEGEN_SOURCE_FILES.includes(name));
    const path=join(PROJECT_SOURCE_ROOT,name);
    assert.equal(c.source_pins[path].sha256,hash(f.files.get(path)));
  }
  const invocation=buildDesktopCodegenInvocation(c,f.files.get(c.prompt.path));
  assert.equal(invocation.specification.max_wall_clock_sec,null);
  assert.equal(invocation.specification.execution_profile,PROFILE);
  for(const change of [
    {generation_wall_ms:120000},{outer_observation_ms:140000},
    {execution_profile:null},{execution_profile:{...PROFILE,outer_observation_ms:0}},
    {schema:'UNKNOWN'}
  ])assert.throws(()=>validateDesktopCodegenConfig({...c,...change}));
  const missing=clone(c);delete missing.execution_profile;
  assert.throws(()=>validateDesktopCodegenConfig(missing));
  assert.throws(()=>validateProjectCodexConfig(c));
  const old=await prepared(false);
  assert.equal(old.config.generation_wall_ms,120000);assert.equal(old.config.outer_observation_ms,140000);
  assert.equal(Object.hasOwn(old.config,'execution_profile'),false);
  assert.throws(()=>validateDesktopCodegenConfig({...old.config,execution_profile:PROFILE}));
  assert.equal(buildDesktopCodegenInvocation(old.config,old.files.get(old.config.prompt.path)).specification.max_wall_clock_sec,120);
});
test('N01 invalid runtime selections and direct core null attempts reject before dispatch',async()=>{
  const rt=runtime(),a=launch('/synthetic/no-effects',rt);
  let effects=0;
  const ports={...a.ports,fs:{lstat(){effects++;throw 0;}},spawn(){effects++;throw 0;}};
  for(const change of [
    {execution_profile:undefined},{execution_profile:{...PROFILE,id:'UNKNOWN'}},
    {max_wall_clock_sec:120},{runtime_target:'node24-esm'}
  ])await assert.rejects(runProjectCodexTask({...a.spec,...change},a.options,ports));
  const untagged={...a.spec};delete untagged.execution_profile;
  assert.throws(()=>admitDesktopCodegenProjectTask(untagged));
  assert.throws(()=>admitProjectCodexTask(a.spec));
  for(const spec of [
    {...a.spec,provider_id:'native_codex',task_class:'PROJECT_CODEGEN_V1',execution_profile:undefined},
    {...untagged,provider_id:'native_codex',task_class:'PROJECT_CODEGEN_V1'},
    {...a.spec,provider_id:'agy_gemini',task_class:'PROJECT_CODEGEN_V1'},
    {...a.spec,provider_id:'native_codex',task_class:'SINGLE_JS_CODEGEN_V1'},
    {...a.spec,provider_id:'native_codex',task_class:'PROJECT_CODEGEN_V1',max_wall_clock_sec:120}
  ])assert.throws(()=>runForeground(spec,{}, {}, {spawn(){effects++;}}));
  assert.equal(effects,0);assert.equal(rt.calls.length,0);
});
test('N02 stalled child survives hours without timers, progress or signals; cancellation owns finite shutdown',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt);
  let settled=false;
  const pending=runProjectCodexTask(a.spec,a.options,a.ports).then(r=>{settled=true;return r;});
  await until(()=>rt.calls.length===1);await flush();
  for(const time of [120000,240000,260000,290000,12*60*60*1000]){
    await rt.advance(time);assert.equal(settled,false);assert.deepEqual(rt.kills,[]);
    assert.equal(rt.timers.length,0);
  }
  rt.controller.abort();await flush();
  assert.deepEqual(rt.kills,['SIGTERM']);
  await rt.advance(12*60*60*1000+3000);
  assert.deepEqual(rt.kills,['SIGTERM','SIGKILL']);
  await rt.advance(12*60*60*1000+5000);
  const r=await pending;
  assert.equal(r.schema,RESULT);assert.equal(r.status,'INCOMPLETE');
  assert.equal(r.generation.record.lifecycle_status,'LIMITED_USER_ABORT');
  assert.equal(r.generation.runtime_evidence.deadline_ms,null);
  assert.equal(r.generation.runtime_evidence.timeout_latched,false);
  assert.equal(r.generation.record.containment_evidence.settlement_status,'ABANDONED_UNSETTLED');
  assert.equal(r.workspace_disposition,'QUARANTINED');assert.equal(r.staging,null);
  assert.equal(r.outer_observation_target_ms,null);assert.equal(r.direct_child_invocations.generation,1);
  assert.equal(create(r).schema,RECEIPT);
  rt.child.emit('exit',null,'SIGKILL');
}));
test('N03 long completion preserves exact envelope and actual elapsed wall time; closeout begins afterward',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt),pending=runProjectCodexTask(a.spec,a.options,a.ports);
  await until(()=>rt.calls.length===1);await flush();await rt.advance(6*60*60*1000);
  rt.child.stdout.emit('data',enc('{"type":"thread.started","thread_id":"PRIVATE_THREAD"}\n'));
  assert.equal(rt.timers.length,0);
  rt.complete();
  const r=await pending;
  assert.equal(r.status,'CANDIDATE_STAGED');
  assert.equal(r.generation.record.process_exit.process_wall_ms,6*60*60*1000);
  assert.equal(r.generation.runtime_evidence.deadline_ms,null);
  assert.equal(r.generation.runtime_evidence.timeout_latched,false);
  assert.deepEqual(r.post_generation_closeout,{status:'COMPLETE',limit_ms:20000});
  assert.equal(await fs.readFile(r.generation.record.output_custody.path,'utf8'),sourceEnvelope);
  assert.equal(r.staging.operation_acknowledgement,'ACKNOWLEDGED');
  assert.equal(rt.timers.filter(t=>t.delay===20000).length,1);
  assert.equal(rt.calls.length,1);
  const summary=project(create(r)),text=format(summary);
  assert.equal(summary.generation.process_exit.process_wall_ms,6*60*60*1000);
  assert.match(text,/NO SQUIRE ELAPSED GENERATION CUTOFF/);
  assert.match(text,/user cancellation available/);
  assert.match(text,/cost: UNKNOWN/);
  assert.equal(/PRIVATE_|prospective|synthetic\/codex/.test(text),false);
}));
test('N04 pre-abort and canceled pending setup return tagged zero-spawn results without late dispatch',async()=>{
  await owned(async root=>{
    const rt=runtime(),a=launch(root,rt);rt.controller.abort();
    const r=await runProjectCodexTask(a.spec,a.options,a.ports);
    assert.equal(r.reason,'CANCELED');assert.equal(r.schema,RESULT);assert.equal(r.generation,null);
    assert.equal(r.direct_child_invocations.generation,0);assert.equal(create(r).result.outer_observation_target_ms,null);
    assert.deepEqual(await fs.readdir(root),[]);
  });
  await owned(async root=>{
    const rt=runtime(),a=launch(root,rt);
    let release,entered=false;
    const blocked=new Promise(resolve=>{release=resolve;});
    const pending=runProjectCodexTask(a.spec,a.options,{
      ...a.ports,fs:{...fs,async lstat(path){entered=true;await blocked;return fs.lstat(path);}}
    });
    await until(()=>entered);rt.controller.abort();
    const r=await pending;assert.equal(r.reason,'CANCELED');assert.equal(rt.calls.length,0);
    release();await flush();assert.equal(rt.calls.length,0);
  });
});
test('N05 nonzero, invalid output, stream errors and output caps remain terminal failures',async()=>{
  for(const kind of ['nonzero','parser','stdout-cap','stderr-cap','stream-error'])await owned(async root=>{
    const rt=runtime(),a=launch(root,rt),pending=runProjectCodexTask(a.spec,a.options,a.ports);
    await until(()=>rt.calls.length===1);await flush();await rt.advance(500000);
    if(kind==='nonzero')rt.complete(sourceEnvelope,3);
    else if(kind==='parser')rt.complete('{}');
    else{
      if(kind==='stdout-cap')rt.child.stdout.emit('data',new Uint8Array(1048577));
      if(kind==='stderr-cap')rt.child.stderr.emit('data',new Uint8Array(65537));
      if(kind==='stream-error')rt.child.stderr.emit('error',Error('PRIVATE_ERROR'));
      rt.child.stdout.emit('end');rt.child.stderr.emit('end');rt.child.emit('exit',1,null);
    }
    const r=await pending;
    assert.notEqual(r.status,'CANDIDATE_STAGED');assert.equal(r.staging,null);
    assert.equal(r.generation.runtime_evidence.timeout_latched,false);
    assert.equal(r.generation.runtime_evidence.deadline_ms,null);
    assert.equal(JSON.stringify(create(r)).includes('PRIVATE_ERROR'),false);
    assert.equal(rt.calls.length,1);
  });
});
test('OC03 an actually sampled backward core clock stops valid input with CLOCK_UNAVAILABLE',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt),pending=runProjectCodexTask(a.spec,a.options,a.ports);
  await until(()=>rt.calls.length===1);await flush();
  await rt.advance(500000);
  // This valid frame invokes feed/checkDeadline and samples 500000 in the core.
  rt.child.stdout.emit('data',enc('{"type":"turn.started"}\n'));
  assert.deepEqual(rt.kills,[]);
  rt.setTime(1);
  rt.child.stdout.emit('data',enc(JSON.stringify({
    type:'item.completed',item:{type:'agent_message',text:sourceEnvelope}
  })+'\n'));
  assert.deepEqual(rt.kills,['SIGTERM']);
  // Restore a monotonic sample before settlement. Supply a valid terminal and
  // zero exit, so neither malformed output nor nonzero exit masks the failure.
  rt.setTime(500001);
  rt.child.stdout.emit('data',enc(JSON.stringify({
    type:'turn.completed',usage:{
      input_tokens:0,output_tokens:2,cached_input_tokens:0,reasoning_output_tokens:0
    }
  })+'\n'));
  rt.child.stdout.emit('end');rt.child.stderr.emit('end');rt.child.emit('exit',0,null);
  const r=await pending;
  assert.equal(r.status,'GENERATION_REJECTED');
  assert.equal(r.generation.record.lifecycle_status,'LIMITED_INTERNAL_ERROR');
  assert.equal(r.generation.record.error_details.code,'CLOCK_UNAVAILABLE');
  assert.equal(r.generation.record.process_exit.exit_code,0);
  assert.equal(r.generation.record.process_exit.observed_termination,true);
  assert.equal(r.generation.runtime_evidence.deadline_ms,null);
  assert.equal(r.generation.runtime_evidence.timeout_latched,false);
  assert.equal(r.workspace_disposition,'QUARANTINED');
  assert.equal(r.staging,null);
  assert.equal(r.direct_child_invocations.generation,1);
  assert.equal(project(create(r)).readiness,'GENERATION_REJECTED');
}));
test('N06 stalled rejected retention has a finite local wait after observed exit',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt);
  let entered=false,release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const pending=runProjectCodexTask(a.spec,a.options,{
    ...a.ports,retainRejected:async()=>{entered=true;await blocked;return {};}
  });
  await until(()=>rt.calls.length===1);await flush();await rt.advance(900000);
  assert.equal(rt.timers.length,0);rt.complete('');
  await until(()=>entered);
  assert.ok(rt.timers.some(t=>t.active&&t.delay===2000));
  await rt.advance(902000);
  const r=await pending;
  assert.equal(r.status,'GENERATION_REJECTED');
  assert.equal(r.generation.record.lifecycle_status,'LIMITED_PARSER_ERROR');
  assert.equal(r.generation.diagnostic_retention.retention_status,'UNKNOWN');
  assert.equal(r.generation.runtime_evidence.timeout_latched,false);
  assert.equal(r.post_generation_closeout.status,'NOT_STARTED');
  release();await flush();
}));
test('N06 stage closeout starts after foreground settlement and reports its own deadline',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt);
  let entered=false,release,closed;
  const blocked=new Promise(resolve=>{release=resolve;}),done=new Promise(resolve=>{closed=resolve;});
  const io={...fs,async open(path,...args){
    if(!path.endsWith('/stage/main.js'))return fs.open(path,...args);
    entered=true;await blocked;
    const handle=await fs.open(path,...args);
    return {
      writeFile:(...values)=>handle.writeFile(...values),
      stat:()=>handle.stat(),read:(...values)=>handle.read(...values),
      chmod:(...values)=>handle.chmod(...values),
      async close(){try{return await handle.close();}finally{closed();}}
    };
  }};
  const pending=runProjectCodexTask(a.spec,a.options,{...a.ports,fs:io});
  await until(()=>rt.calls.length===1);await flush();await rt.advance(3600000);
  assert.equal(rt.timers.length,0);rt.complete();await until(()=>entered);
  const timer=rt.timers.find(t=>t.active&&t.delay===20000);
  assert.ok(timer);assert.equal(timer.at,3620000);
  await rt.advance(3620000);
  const r=await pending;
  assert.equal(r.status,'INCOMPLETE');assert.equal(r.reason,'POST_GENERATION_CLOSEOUT_DEADLINE');
  assert.equal(r.generation.record.lifecycle_status,'LIMITED_SUCCESS');
  assert.equal(r.generation.runtime_evidence.timeout_latched,false);
  assert.equal(r.staging,null);assert.equal(r.post_generation_closeout.status,'DEADLINE_EXCEEDED');
  assert.equal(project(create(r)).readiness,'INCOMPLETE');
  release();await done;await flush();
}));
test('N07 shared job and scope nonreuse cannot be bypassed by changing profiles',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt);rt.controller.abort();
  await runProjectCodexTask(a.spec,a.options,a.ports);
  const legacy={...a.spec,max_wall_clock_sec:120};delete legacy.execution_profile;
  const fresh=runtime();
  await assert.rejects(runProjectCodexTask(legacy,{...a.options,clock:fresh.clock,abortSignal:fresh.controller.signal},{...a.ports,spawn:fresh.spawn}));
  assert.equal(fresh.calls.length,0);
  const f=await prepared(),c=f.config;
  const admission={
    provider_id:'native_codex',operator_receipt:c.authorization.operator_receipt,
    config_sha256:hash(f.bytes),job_id:c.job_id,scope:c.scope,
    desktop_codegen_admitted:true,preflight:{evidence_receipt:'/synthetic/proof'}
  };
  requireDesktopCodegenAdmission(admission,c,f.bytes);
  const changed={...c,schema:'SQUIRE2_DESKTOP_CODEGEN_OPERATION_V1',generation_wall_ms:120000,outer_observation_ms:140000};
  delete changed.execution_profile;
  const bytes=canonicalBytes(changed);
  assert.throws(()=>requireDesktopCodegenAdmission({...admission,config_sha256:hash(bytes)},changed,bytes),/NATIVE_OPERATION_ALREADY_CONSUMED/);
}));
function emptyResult(){
  return {
    schema:RESULT,status:'INCOMPLETE',reason:'CANCELED',generation:null,staging:null,
    task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,
    operator_admitted:false,workspace_disposition:'QUARANTINED',descendant_guarantee:'NONE',
    operator_receipt:'/PRIVATE_OPERATOR_SENTINEL',direct_child_invocations:{generation:0},
    outer_observation_target_ms:null,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',
    execution_profile:PROFILE,post_generation_closeout:{status:'NOT_STARTED',limit_ms:20000}
  };
}
test('N07 receipt families reject cross-format, malformed profiles and incompatible closeout before writes',async()=>{
  const r=emptyResult(),saved=create(r);
  assert.equal(project(saved).readiness,'INCOMPLETE');
  assert.equal(projectNativeProjectRunSummary(saved).readiness,'INVALID_RECEIPT');
  assert.throws(()=>createNativeProjectResultReceipt(r));
  const legacy={...r,schema:'SQUIRE2_PROJECT_RESULT_V1',outer_observation_target_ms:140000};
  delete legacy.execution_profile;delete legacy.post_generation_closeout;
  assert.throws(()=>create(legacy));
  let writes=0;
  const ports={fs:{lstat(){writes++;throw 0;},open(){writes++;throw 0;}},uid:0};
  for(const change of [
    {execution_profile:{...PROFILE,id:'UNKNOWN'}},{outer_observation_target_ms:140000},
    {post_generation_closeout:{status:'COMPLETE',limit_ms:20000}},
    {post_generation_closeout:{status:'NOT_STARTED',limit_ms:0}},
    {reason:'OBSERVATION_DEADLINE'}
  ]){
    const value={...r,...change};
    assert.equal(project({schema:RECEIPT,result:value}).readiness,'INVALID_RECEIPT');
    await assert.rejects(write(value,{directory:'/synthetic',filename:'receipt.json'},ports));
  }
  await assert.rejects(write(legacy,{directory:'/synthetic',filename:'receipt.json'},ports));
  await assert.rejects(writeNativeProjectResultReceipt(r,{directory:'/synthetic',filename:'receipt.json'},ports));
  assert.equal(writes,0);
});
test('N07 new writer shares exclusive private custody, exact readback, close failure and no retry',async()=>owned(async root=>{
  const result=emptyResult(),destination={directory:root,filename:'observation.json'};
  const ports={fs:{lstat:fs.lstat,open:fs.open},uid:process.getuid()};
  const ack=await write(result,destination,ports);
  assert.equal(ack.status,'RECORDED');
  assert.equal((await fs.stat(join(root,destination.filename))).mode&0o777,0o600);
  const saved=parseReceiptJson(await fs.readFile(join(root,destination.filename)));
  assert.equal(saved.schema,RECEIPT);assert.equal(project(saved).readiness,'INCOMPLETE');
  await assert.rejects(write(result,destination,ports),error=>error.code==='WRITE_FAILED');
  let opens=0,closes=0;
  const io={
    lstat:fs.lstat,
    async open(...args){
      opens++;const handle=await fs.open(...args);
      return {
        stat:()=>handle.stat(),writeFile:bytes=>handle.writeFile(bytes),
        read:(...values)=>handle.read(...values),
        async close(){closes++;await handle.close();throw Error('PRIVATE_CLOSE');}
      };
    }
  };
  await assert.rejects(write(result,{directory:root,filename:'partial.json'},{fs:io,uid:process.getuid()}),
    error=>error.code==='WRITE_FAILED');
  assert.equal(opens,1);assert.equal(closes,1);
  assert.ok((await fs.stat(join(root,'partial.json'))).isFile());
}));
test('N08 offline CLI reads only supplied saved bytes and retains operator claim and unknown semantics',async()=>{
  for(const operator of [false,true]){
    const saved=create({...emptyResult(),operator_admitted:operator});
    const summary=project(saved);
    assert.equal(summary.operator_admission_claimed,operator);
    assert.equal(summary.admission_authority,'NOT_ESTABLISHED');
    assert.equal(summary.outer_observation_target_ms,null);
    assert.equal(summary.generation,null);
    const bytes=canonicalBytes(saved);let out='',err='',reads=0;
    const code=await runOfflineReportCli(['/PRIVATE_RECEIPT'],{
      stat:async()=>({size:bytes.length,isFile:()=>true,isSymbolicLink:()=>false}),
      readFile:async()=>{reads++;return bytes;},
      stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}
    });
    assert.equal(code,1);assert.equal(reads,1);assert.equal(err,'');
    assert.match(out,/observation target ms=NONE/);assert.match(out,/wall ms: UNKNOWN/);
    assert.equal(out.includes('PRIVATE_'),false);
  }
  const saved={schema:RECEIPT,result:{...emptyResult(),execution_profile:{...PROFILE,outer_observation_ms:0}}};
  const bytes=canonicalBytes(saved);let out='',err='';
  const code=await runOfflineReportCli(['/PRIVATE_RECEIPT'],{
    stat:async()=>({size:bytes.length,isFile:()=>true,isSymbolicLink:()=>false}),
    readFile:async()=>bytes,stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}
  });
  assert.equal(code,2);assert.equal(err,'SCHEMA_MISMATCH\n');
  assert.equal(out,'Squire native offline project coding observation result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n');
});
test('N10 preparation CLI and core source explicitly select observation without changing legacy timer values',async()=>{
  const preparation=await fs.readFile(new URL('../acceptance/prepare-project-task.mjs',import.meta.url),'utf8');
  assert.match(preparation,/--prepare-desktop-coding-observation/);
  assert.match(preparation,/prepareDesktopCodingObservationTask/);
  const core=await fs.readFile(new URL('../src/internal/limited-core.mjs',import.meta.url),'utf8');
  assert.match(core,/if\(!observation\)arm\('budget'/);
  assert.match(core,/observation\?shutdown\.persistence_timeout_ms:deadline-current/);
});

async function assertObservationRecordable(result,directory){
  const saved=create(result),summary=project(saved);
  assert.equal(summary.readiness,result.status);
  assert.equal(summary.reason,result.reason);
  assert.equal(summary.post_generation_closeout.status,result.post_generation_closeout.status);
  assert.equal(summary.staging!==null,result.staging!==null);
  const text=format(summary);
  assert.equal(text.includes('INVALID_RECEIPT'),false);
  assert.match(text,new RegExp(`Local closeout: ${result.post_generation_closeout.status};`));
  if(result.staging)assert.match(text,/Staging ACK history: COMPLETE; operation=ACKNOWLEDGED/);
  const filename=`matrix-${serial++}.json`;
  const ack=await write(result,{directory,filename},{
    fs:{lstat:fs.lstat,open:fs.open},uid:process.getuid()
  });
  assert.equal(ack.status,'RECORDED');
  const readback=project(parseReceiptJson(await fs.readFile(join(directory,filename))));
  assert.deepEqual(readback,summary);
  return {saved,summary};
}
test('OC02 actual pre-generation failures and aborts obey the shared recordable matrix',async()=>{
  for(const kind of ['pre-abort','setup-error','spawn-error','generation-rejected'])await owned(async root=>{
    const rt=runtime(),a=launch(root,rt);
    if(kind==='pre-abort')rt.controller.abort();
    if(kind==='setup-error')a.ports.fs={...fs,async lstat(){throw Error('PRIVATE_SETUP');}};
    if(kind==='spawn-error')a.ports.spawn=()=>{throw Error('PRIVATE_SPAWN');};
    const pending=runProjectCodexTask(a.spec,a.options,a.ports);
    if(kind==='generation-rejected'){
      await until(()=>rt.calls.length===1);await flush();rt.complete('{}');
    }
    const r=await pending;
    assert.equal(r.post_generation_closeout.status,'NOT_STARTED');
    assert.equal(r.staging,null);
    if(kind==='pre-abort'){
      assert.equal(r.status,'INCOMPLETE');assert.equal(r.reason,'CANCELED');
      assert.equal(r.direct_child_invocations.generation,0);
    }else if(kind==='setup-error'){
      assert.equal(r.status,'FAILED');assert.equal(r.reason,'OPERATION_FAILED_OR_UNCERTAIN');
      assert.equal(r.direct_child_invocations.generation,0);
    }else{
      assert.equal(r.status,'GENERATION_REJECTED');
      assert.equal(r.generation.record.lifecycle_status,kind==='spawn-error'?'LIMITED_SPAWN_FAILED':'LIMITED_PARSER_ERROR');
      assert.equal(r.direct_child_invocations.generation,1);
    }
    await assertObservationRecordable(r,root);
  });
});
test('OC02 successful staging preserves ACK history under actual closeout cleanup, cancel and clock failures',async()=>{
  for(const kind of ['success','cleanup-throw','cleanup-abort','cleanup-abort-throw','final-deadline','final-clock-error'])await owned(async root=>{
    const rt=runtime(),a=launch(root,rt),schedule=rt.clock.schedule,readNow=rt.clock.now;
    let clockFailed=false;
    rt.clock.now=()=>clockFailed?-1:readNow();
    rt.clock.schedule=(delay,fn)=>{
      const cancel=schedule(delay,fn);
      if(delay!==20000)return cancel;
      return()=>{
        cancel();
        if(kind==='cleanup-abort'||kind==='cleanup-abort-throw')rt.controller.abort();
        if(kind==='final-deadline')rt.setTime(20000);
        if(kind==='final-clock-error')clockFailed=true;
        if(kind==='cleanup-throw'||kind==='cleanup-abort-throw')throw Error('PRIVATE_CANCEL');
      };
    };
    const pending=runProjectCodexTask(a.spec,a.options,a.ports);
    await until(()=>rt.calls.length===1);await flush();rt.complete();
    const r=await pending;
    assert.equal(r.generation.record.lifecycle_status,'LIMITED_SUCCESS');
    assert.equal(r.staging.operation_acknowledgement,'ACKNOWLEDGED');
    assert.equal(r.generation.runtime_evidence.deadline_ms,null);
    assert.equal(r.generation.runtime_evidence.timeout_latched,false);
    const expected={
      success:['CANDIDATE_STAGED',null,'COMPLETE'],
      'cleanup-throw':['FAILED','CLEANUP_FAILED_OR_UNCERTAIN','FAILED_OR_UNCERTAIN'],
      'cleanup-abort':['INCOMPLETE','CANCELED','CANCELED'],
      'cleanup-abort-throw':['FAILED','CLEANUP_FAILED_OR_UNCERTAIN','CANCELED'],
      'final-deadline':['INCOMPLETE','POST_GENERATION_CLOSEOUT_DEADLINE','DEADLINE_EXCEEDED'],
      'final-clock-error':['FAILED','CLOCK_UNAVAILABLE','FAILED_OR_UNCERTAIN']
    }[kind];
    assert.deepEqual([r.status,r.reason,r.post_generation_closeout.status],expected);
    assert.equal(r.workspace_disposition,kind==='success'?'DEDICATED_NOT_REUSED':'QUARANTINED');
    await assertObservationRecordable(r,root);
  });
});
test('OC02 actual staging rejection starts closeout before reporting rejection',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt);
  const io={...fs,async mkdir(path,...args){
    const value=await fs.mkdir(path,...args);
    if(path.endsWith('run-'+a.spec.job_id))await fs.mkdir(join(path,'stage'),{mode:0o700});
    return value;
  }};
  const pending=runProjectCodexTask(a.spec,a.options,{...a.ports,fs:io});
  await until(()=>rt.calls.length===1);await flush();rt.complete();
  const r=await pending;
  assert.equal(r.status,'STAGING_REJECTED');
  assert.equal(r.reason,'STAGING:DESTINATION_ALREADY_EXISTS');
  assert.equal(r.post_generation_closeout.status,'FAILED_OR_UNCERTAIN');
  assert.equal(r.staging,null);
  await assertObservationRecordable(r,root);
}));
test('OC02 canceled or expired pending stage remains recordable even when timer cleanup throws',async()=>{
  for(const kind of ['cancel','cancel-throw','deadline','deadline-throw'])await owned(async root=>{
    const rt=runtime(),a=launch(root,rt),schedule=rt.clock.schedule;
    rt.clock.schedule=(delay,fn)=>{
      const cancel=schedule(delay,fn);
      return()=>{
        cancel();
        if(delay===20000&&kind.endsWith('-throw'))throw Error('PRIVATE_CANCEL');
      };
    };
    let entered=false,release,closed;
    const blocked=new Promise(resolve=>{release=resolve;});
    const settled=new Promise(resolve=>{closed=resolve;});
    const io={...fs,async open(path,...args){
      if(!path.endsWith('/stage/main.js'))return fs.open(path,...args);
      entered=true;await blocked;
      const handle=await fs.open(path,...args);
      return {
        writeFile:(...values)=>handle.writeFile(...values),stat:()=>handle.stat(),
        read:(...values)=>handle.read(...values),chmod:(...values)=>handle.chmod(...values),
        async close(){try{return await handle.close();}finally{closed();}}
      };
    }};
    const pending=runProjectCodexTask(a.spec,a.options,{...a.ports,fs:io});
    await until(()=>rt.calls.length===1);await flush();rt.complete();await until(()=>entered);
    try{
      if(kind.startsWith('deadline'))await rt.advance(20000);
      else rt.controller.abort();
      const r=await pending;
      assert.equal(r.status,kind.endsWith('-throw')?'FAILED':'INCOMPLETE');
      assert.equal(r.reason,kind.endsWith('-throw')?'CLEANUP_FAILED_OR_UNCERTAIN':
        kind==='cancel'?'CANCELED':'POST_GENERATION_CLOSEOUT_DEADLINE');
      assert.equal(r.post_generation_closeout.status,kind.startsWith('deadline')?'DEADLINE_EXCEEDED':'CANCELED');
      assert.equal(r.generation.record.lifecycle_status,'LIMITED_SUCCESS');
      assert.equal(r.generation.runtime_evidence.timeout_latched,false);
      assert.equal(r.staging,null);
      assert.equal(r.workspace_disposition,'QUARANTINED');
      await assertObservationRecordable(r,root);
    }finally{
      release();await settled;await flush();
    }
  });
});
test('OC02 contradictory raw and projected outcomes reject before writer filesystem effects',async()=>owned(async root=>{
  const rt=runtime(),a=launch(root,rt),pending=runProjectCodexTask(a.spec,a.options,a.ports);
  await until(()=>rt.calls.length===1);await flush();rt.complete();
  const actual=await pending,{saved,summary}=await assertObservationRecordable(actual,root);
  const baseline=clone(saved.result);
  const variants=[
    {status:'STAGING_REJECTED',reason:'STAGING:PACKAGE_IO_ERROR',staging:null,
      post_generation_closeout:{status:'NOT_STARTED',limit_ms:20000}},
    {status:'INCOMPLETE',reason:'CANCELED',staging:null,
      post_generation_closeout:{status:'FAILED_OR_UNCERTAIN',limit_ms:20000}},
    {status:'FAILED',reason:'CLEANUP_FAILED_OR_UNCERTAIN',
      post_generation_closeout:{status:'DEADLINE_EXCEEDED',limit_ms:20000}},
    {status:'FAILED',reason:'OPERATION_FAILED_OR_UNCERTAIN',staging:null,
      post_generation_closeout:{status:'DEADLINE_EXCEEDED',limit_ms:20000}},
    {status:'GENERATION_REJECTED',reason:'GENERATION_REJECTED',staging:null,
      post_generation_closeout:{status:'NOT_STARTED',limit_ms:20000}},
    {staging:null},
    {direct_child_invocations:{generation:0}},
    {status:'INCOMPLETE',reason:'CANCELED',
      post_generation_closeout:{status:'NOT_STARTED',limit_ms:20000}}
  ];
  let effects=0;
  const writerPorts={uid:process.getuid(),fs:{
    lstat(){effects++;throw Error('MUST_NOT_TOUCH_FS');},
    open(){effects++;throw Error('MUST_NOT_TOUCH_FS');}
  }};
  const invalidText='Squire native offline project coding observation result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
  for(const change of variants){
    const value={...clone(baseline),...change};
    value.workspace_disposition=value.status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED';
    assert.throws(()=>create(value));
    const projected=project({schema:RECEIPT,result:value});
    assert.equal(projected.readiness,'INVALID_RECEIPT');
    assert.equal(format(projected),invalidText);
    await assert.rejects(write(value,{directory:root,filename:'must-not-exist.json'},writerPorts));
    const forgedSummary={
      ...clone(summary),readiness:value.status,reason:value.reason,
      workspace_disposition:value.workspace_disposition,
      direct_child_invocations:value.direct_child_invocations,
      staging:value.staging===null?null:clone(summary.staging),
      post_generation_closeout:value.post_generation_closeout
    };
    assert.equal(format(forgedSummary),invalidText);
  }
  assert.equal(effects,0);
  for(const value of [
    {status:'INCOMPLETE',reason:'CANCELED',lifecycle:null,generation_invocations:1,has_staging:false},
    {status:'GENERATION_REJECTED',reason:'GENERATION_REJECTED',lifecycle:'LIMITED_SPAWN_FAILED',generation_invocations:0,has_staging:false},
    {status:'INCOMPLETE',reason:'GENERATION_REJECTED',lifecycle:'LIMITED_USER_ABORT',generation_invocations:1,has_staging:false},
    {status:'INCOMPLETE',reason:'GENERATION_REJECTED',lifecycle:'LIMITED_TIMEOUT',generation_invocations:1,has_staging:false}
  ])assert.throws(()=>validateProjectCodingObservationOutcome({
    ...value,post_generation_closeout:{status:'NOT_STARTED',limit_ms:20000}
  }));
}));

function relativeModuleImports(source){
  const imports=new Set();
  // Traverse literal runtime imports/re-exports, including fixed lazy imports.
  // This deliberately does not infer paths from arbitrary strings or comments.
  const statics=/^\s*(?:import\s+(?:[^;'"]*?\s+from\s+)?|export\s+[^;'"]*?\s+from\s+)['"](\.[^'"]+)['"]/gm;
  const dynamics=/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for(const expression of [statics,dynamics]){
    for(const match of source.matchAll(expression))imports.add(match[1]);
  }
  return [...imports];
}
test('OC01 both legacy inventories cover the actual shared-core and new dependency import closure',async()=>{
  for(const [consumer,inventory] of [['bounded',SOURCE_FILES],['single-js',SINGLE_JS_SOURCE_FILES]]){
    const pending=[
      'src/internal/limited-core.mjs','src/project-coding-profile.mjs','src/desktop-profile.mjs'
    ],seen=new Set();
    while(pending.length){
      const name=pending.pop();if(seen.has(name))continue;seen.add(name);
      assert.ok(inventory.includes(name),`${consumer}: shared-core dependency missing: ${name}`);
      const url=new URL('../'+name,import.meta.url);
      const source=await fs.readFile(url,'utf8');
      for(const specifier of relativeModuleImports(source)){
        const target=new URL(specifier,url);
        assert.equal(target.protocol,'file:');
        const dependency=relative(PROJECT_SOURCE_ROOT,fileURLToPath(target)).split('\\').join('/');
        assert.equal(dependency.startsWith('../'),false);
        assert.equal(resolve(PROJECT_SOURCE_ROOT,dependency),fileURLToPath(target));
        assert.ok(inventory.includes(dependency),`${consumer}: ${name} imports unpinned ${dependency}`);
        if(dependency.endsWith('.mjs'))pending.push(dependency);
      }
    }
    assert.ok(seen.has('src/project-coding-profile.mjs'));
    assert.ok(seen.has('src/desktop-profile.mjs'));
    assert.ok(seen.has('src/offline-run-summary.mjs'));
    // This assertion covers the demonstrated shared-core dependency branch.
    // It makes no claim about unrelated preexisting inventory omissions reached
    // only from other entrypoints, report routes or historical preparations.
  }
});
function syntheticSourcePins(inventory,root){
  const files=new Map(),source_pins={};
  for(const name of inventory){
    const path=join(root,name),bytes=enc(`Public synthetic pin ${name}`);
    files.set(path,bytes);source_pins[path]={bytes:bytes.length,sha256:hash(bytes)};
  }
  return {files,source_pins};
}
function singleJsPinConfig(source_pins){
  const inputs=privateInputs('/synthetic/single-pin-'+id());
  return {
    schema:'SQUIRE2_SINGLE_JS_OPERATION_V1',runtime_admitted:false,provider_id:'native_codex',
    job_id:inputs.job_id,scope:inputs.scope,source_commit:'e'.repeat(40),source_pins,
    node:NODE_RUNTIME,codex:inputs.codex,requested_model:inputs.requested_model,
    effort:inputs.effort,authorization,permissions,
    prompt:{path:'/synthetic/prompt.utf8',bytes:900,sha256:'a'.repeat(64)},
    target_file:{workspace_relative_path:'src/task.mjs'},
    diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,
    preflight_freshness_ms:300000,outer_observation_ms:140000,generation_wall_ms:120000,
    syntax_check_wall_ms:5000,max_direct_child_spawns:2,
    environment_policy:SINGLE_JS_ENVIRONMENT_POLICY
  };
}
function boundedPinConfig(source_pins){
  const inputs=privateInputs('/synthetic/bounded-pin-'+id());
  return {
    schema:'Q218C_OPERATION_V1',runtime_admitted:false,provider_id:'native_codex',
    job_id:inputs.job_id,scope:inputs.scope,source_commit:'e'.repeat(40),source_pins,
    node:NODE_RUNTIME,codex:inputs.codex,requested_model:inputs.requested_model,
    effort:inputs.effort,authorization,permissions,
    prompt:{path:'/synthetic/prompt.utf8',bytes:900,sha256:'a'.repeat(64)},
    fixtures:{path:join(PUBLIC_FREEZE_ROOT,'fixtures-freeze-manifest.json'),bytes:20720,sha256:FIXTURE_FREEZE_SHA256},
    fixture_inputs:Array.from({length:17},(_,i)=>join(PUBLIC_FREEZE_ROOT,`fixture-${String(i+1).padStart(2,'0')}`,'input.ndjson')),
    fixture_configs:codexFixtureConfigurations(inputs.job_id,inputs.scope),
    diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,
    preflight_freshness_ms:300000,outer_observation_ms:250000,fixture_aggregate_ms:85000,
    max_direct_child_spawns:19,environment_policy:CODEX_ENVIRONMENT_POLICY,
    task_input:{path:'/synthetic/task.json',bytes:10,sha256:'b'.repeat(64)}
  };
}
test('OC01 actual pure validators require new pins and the real verifier rejects changed synthetic bytes',async()=>{
  for(const fixture of [
    {
      inventory:SOURCE_FILES,root:PROJECT_SOURCE_ROOT,make:boundedPinConfig,
      validate:validateCodexOperationConfig,
      required:['src/project-coding-profile.mjs','src/desktop-profile.mjs','src/offline-run-summary.mjs']
    },
    {
      inventory:SINGLE_JS_SOURCE_FILES,root:SINGLE_JS_SOURCE_ROOT,make:singleJsPinConfig,
      validate:validateSingleJsCodexConfig,
      required:['src/project-coding-profile.mjs','src/desktop-profile.mjs']
    }
  ]){
    const {files,source_pins}=syntheticSourcePins(fixture.inventory,fixture.root);
    const config=fixture.make(source_pins);
    fixture.validate(config);
    let reads=0;
    const ports={
      async lstat(path){
        reads++;
        if(!files.has(path))throw Error('SYNTHETIC_FILE_ABSENT');
        return {size:files.get(path).length,isFile:()=>true,isSymbolicLink:()=>false};
      },
      async *readChunks(path){reads++;yield new Uint8Array(files.get(path));}
    };
    for(const name of fixture.required){
      const path=join(fixture.root,name),missing=clone(config);
      delete missing.source_pins[path];
      const before=reads;
      assert.throws(()=>fixture.validate(missing));
      assert.equal(reads,before);
      const pin={path,...config.source_pins[path]},original=files.get(path);
      await verifyExactFile(pin,ports);
      const changed=new Uint8Array(original);changed[0]^=1;files.set(path,changed);
      // A structurally valid recorded hash cannot establish current bytes.
      fixture.validate(config);
      await assert.rejects(verifyExactFile(pin,ports),/FILE_IDENTITY_MISMATCH/);
      files.delete(path);
      await assert.rejects(verifyExactFile(pin,ports),/SYNTHETIC_FILE_ABSENT/);
      files.set(path,original);
    }
  }
});
