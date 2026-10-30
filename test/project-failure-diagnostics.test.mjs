import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createProjectFailureObserver,createProjectFailureBinding,
  createProjectFailureEvidence,writeProjectFailureDiagnostics
} from '../src/project-failure-diagnostics.mjs';
import {
  runProjectDesktopCodegenWithFailureDiagnosticsWithPorts,
  runProjectDesktopCodegenWithPorts,
  runProjectDesktopCodegenNativeWithFailureDiagnostics,
  projectDryRun,desktopCodegenEntrypointMode
} from '../acceptance/project-entrypoint.mjs';
import {
  DESKTOP_CODEGEN_SOURCE_FILES,PROJECT_SOURCE_FILES,PROJECT_SOURCE_ROOT,
  DESKTOP_CODEGEN_SCHEMA,DESKTOP_CODEGEN_INTENT,PROJECT_ENVIRONMENT_POLICY
} from '../src/project-configuration.mjs';
import {DESKTOP_TARGET,DESKTOP_PREFIX_IDENTITY} from '../src/desktop-profile.mjs';
import {buildProjectCodegenPrompt} from '../src/project-task.mjs';
import {
  NODE_RUNTIME,GENERATION_SHUTDOWN,canonicalBytes,hash
} from '../src/bounded-codegen-plan.mjs';
import {RETENTION_POLICY} from '../src/local-rejected-retention.mjs';

// Event-emitting fake producers only. No child, provider, model, GJS or generated
// module is executed. Writer tests use memory FS; success staging uses owned files.
const enc=value=>new TextEncoder().encode(value);
const job='00000000-0000-4000-8000-000000000001';
const scope='/owned/scope';
const run={scope,job_id:job};
const parent=join(scope,'output','run-'+job);
const destination=join(parent,'failure-diagnostics.json');
const secret='PRIVATE_TOKEN_abc /private/account/123 {"credential":"PRIVATE_TOKEN_abc"}';
const forbidden=()=>{throw Error(secret);};
const clone=value=>structuredClone(value);

function observed(chunks=[],end=true){
  const stderr=new EventEmitter(),observer=createProjectFailureObserver();
  observer.observe({stderr});
  for(const chunk of chunks)stderr.emit('data',chunk);
  if(end)stderr.emit('end');
  return {stderr,observer,value:observer.seal()};
}
function evidence(observation=observed().value,binding={
  job_id:job,outcome:'GENERATION_REJECTED',lifecycle:'LIMITED_PROCESS_FAILED'
}){
  return createProjectFailureEvidence(binding,observation);
}
function stat({file=false,uid=1234,nlink=1,mode=file?0o100600:0o40700,ino=1,size=0}={}){
  return {
    dev:1,ino,uid,nlink,mode,size,mtimeMs:1,ctimeMs:1,
    isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false
  };
}
function memoryFs(change={}){
  const files=new Map(),opened=[],closed=[],directories=new Map();
  let sequence=20;
  const fs={
    async mkdir(path){directories.set(path,stat({ino:++sequence}));},
    async lstat(path){
      if(change.lstat)return change.lstat(path,baseStat);
      return baseStat(path);
    },
    async open(path,flags,mode){
      opened.push({path,flags,mode});
      if(change.openBeforeCreation)throw Error(secret);
      if(files.has(path))throw Error(secret);
      const item={bytes:new Uint8Array(),ino:++sequence};
      files.set(path,item);
      if(change.openAfterCreation)throw Error(secret);
      const view=()=>stat({
        file:true,ino:item.ino,size:item.bytes.length,
        ...(change.leaf??{})
      });
      return {
        async stat(){return view();},
        async writeFile(bytes){
          if(change.partialWrite){
            item.bytes=new Uint8Array(bytes.subarray(0,8));
            throw Error(secret);
          }
          if(change.write)throw Error(secret);
          item.bytes=new Uint8Array(bytes);
        },
        async read(buffer,offset,length,position){
          const count=Math.min(length,Math.max(0,item.bytes.length-position));
          buffer.set(item.bytes.subarray(position,position+count),offset);
          if(change.readback&&count)buffer[offset]^=1;
          if(change.readResult)return change.readResult(buffer,count);
          return {bytesRead:count,buffer};
        },
        async close(){closed.push(path);if(change.close)throw Error(secret);}
      };
    }
  };
  function baseStat(path){
    if(files.has(path)){
      const item=files.get(path);
      return stat({
        file:true,ino:item.ino,size:item.bytes.length,
        ...(change.leaf??{})
      });
    }
    if(!directories.has(path)){
      directories.set(path,stat({uid:path==='/'?0:1234,ino:++sequence}));
    }
    return directories.get(path);
  }
  return {fs,files,opened,closed,directories,baseStat};
}

test('fixed markers use ASCII case folding across every chunk boundary',()=>{
  const patterns={
    STREAM_DISCONNECTED:'stream disconnected',
    ERROR_SENDING_REQUEST:'error sending request',
    RETRYING:'retrying',
    RECONNECTING:'reconnecting',
    CONNECTION_RESET:'connection reset',
    TIMED_OUT:'timed out',
    UNAUTHORIZED_401:'401 unauthorized',
    FORBIDDEN_403:'403 forbidden',
    TOO_MANY_REQUESTS_429:'429 too many requests',
    RATE_LIMIT:'rate limit',
    QUOTA:'quota',
    CLAMPING_INTERRUPT_HOOK_TIMEOUT:'clamping interrupt hook timeout'
  };
  for(const [key,pattern]of Object.entries(patterns)){
    const bytes=enc(pattern.toUpperCase());
    for(let index=0;index<=bytes.length;index++){
      const {value}=observed([bytes.subarray(0,index),bytes.subarray(index)]);
      assert.equal(value.markers[key],1);
      assert.equal(value.completeness,'COMPLETE');
      assert.equal(value.byte_count,bytes.length);
    }
  }
});
test('unknown, missing, empty complete and partial streams remain distinct',()=>{
  assert.equal(createProjectFailureObserver().seal().completeness,'UNKNOWN');
  for(const stderr of [null,undefined]){
    const observer=createProjectFailureObserver();observer.observe({stderr});
    assert.equal(observer.seal().completeness,'MISSING');
  }
  assert.equal(observed().value.completeness,'EMPTY_COMPLETE');
  assert.equal(observed([],false).value.completeness,'PARTIAL');
  assert.equal(observed([enc('partial')],false).value.completeness,'PARTIAL');
});
test('counts saturate, scanning is bounded and omitted bytes never join markers',()=>{
  assert.equal(observed([enc('quota '.repeat(500))]).value.markers.QUOTA,255);
  const prefix=new Uint8Array(65536);prefix.fill(32);
  prefix.set(enc('quo'),prefix.length-3);
  const {value}=observed([prefix,enc('ta quota')]);
  assert.equal(value.byte_count,65544);
  assert.equal(value.scanned_bytes,65536);
  assert.equal(value.truncated,true);
  assert.equal(value.eof,true);
  assert.equal(value.completeness,'TRUNCATED');
  assert.equal(value.markers.QUOTA,0);
  const huge=new Uint8Array(70000);huge.fill(32);
  huge.set(enc('quota'),69000);
  assert.equal(observed([huge]).value.markers.QUOTA,0);
});
test('invalid UTF-8 is a barrier and strings are not silently decoded',()=>{
  const value=observed([enc('quo'),new Uint8Array([255]),enc('ta QUOTA')]).value;
  assert.equal(value.markers.QUOTA,1);
  assert.equal(value.byte_count,12);
  const invalid=observed(['quota']).value;
  assert.equal(invalid.observer_error,'OBSERVER_ERROR');
  assert.equal(invalid.byte_count,0);
});
test('sealing removes only owned listeners and freezes late metadata',()=>{
  const stderr=new EventEmitter(),existing=()=>{};
  stderr.on('data',existing);
  const observer=createProjectFailureObserver();observer.observe({stderr});
  stderr.emit('data',enc('quota'));
  const value=observer.seal(),before=JSON.stringify(value);
  assert.deepEqual(stderr.listeners('data'),[existing]);
  assert.equal(stderr.listenerCount('end'),0);
  assert.equal(stderr.listenerCount('error'),0);
  stderr.emit('data',enc(secret+' retrying'));stderr.emit('end');
  assert.equal(observer.seal(),value);
  assert.equal(JSON.stringify(value),before);
  assert.equal(Object.isFrozen(value),true);
  assert.equal(Object.isFrozen(value.markers),true);
});
test('stream errors, registration failures and detach failures cannot throw',()=>{
  const stderr=new EventEmitter(),observer=createProjectFailureObserver();
  observer.observe({stderr});
  assert.doesNotThrow(()=>stderr.emit('error',Error(secret)));
  assert.equal(observer.seal().observer_error,'STREAM_ERROR');
  const broken=new EventEmitter();broken.removeListener=forbidden;
  const other=createProjectFailureObserver();other.observe({stderr:broken});
  assert.doesNotThrow(()=>other.seal());
  const sealed=other.seal();
  broken.emit('data',enc(secret));
  assert.equal(other.seal(),sealed);
  assert.equal(sealed.observer_error,'OBSERVER_ERROR');
  const registration=createProjectFailureObserver();
  assert.doesNotThrow(()=>registration.observe({
    stderr:{on:forbidden,removeListener(){}}
  }));
  assert.equal(registration.seal().observer_error,'OBSERVER_ERROR');
});
test('hostile children, stream methods and chunks do not invoke accessors or traps',()=>{
  let accesses=0;
  const trap=()=>{accesses++;throw Error(secret);};
  const accessor={};Object.defineProperty(accessor,'stderr',{get:trap});
  const stream={};Object.defineProperty(stream,'on',{get:trap});
  const proxy=new Proxy({},{
    get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap
  });
  for(const child of [accessor,proxy,{stderr:stream},{stderr:proxy}]){
    const observer=createProjectFailureObserver();
    assert.doesNotThrow(()=>observer.observe(child));
    assert.equal(observer.seal().observer_error,'OBSERVER_ERROR');
  }
  const stderr=new EventEmitter(),observer=createProjectFailureObserver();
  observer.observe({stderr});stderr.emit('data',proxy);
  assert.equal(observer.seal().observer_error,'OBSERVER_ERROR');
  const bytes=enc('quota');
  for(const key of ['byteLength','length',Symbol.iterator]){
    Object.defineProperty(bytes,key,{get:trap});
  }
  assert.equal(observed([bytes]).value.markers.QUOTA,1);
  assert.equal(accesses,0);
});
test('binding selects only UUID and fixed primary outcome and lifecycle enums',()=>{
  for(const [outcome,lifecycle]of [
    ['INCOMPLETE','LIMITED_TIMEOUT'],
    ['INCOMPLETE','LIMITED_USER_ABORT'],
    ['GENERATION_REJECTED','LIMITED_SPAWN_FAILED'],
    ['GENERATION_REJECTED','LIMITED_PROCESS_FAILED']
  ]){
    const binding=createProjectFailureBinding({job_id:job},{
      status:outcome,generation:{record:{lifecycle_status:lifecycle}},
      reason:secret,command:secret
    });
    assert.deepEqual(binding,{job_id:job,outcome,lifecycle});
    assert.equal(Object.isFrozen(binding),true);
  }
  assert.deepEqual(createProjectFailureBinding({job_id:job},{
    status:'FAILED',generation:null
  }),{job_id:job,outcome:'FAILED',lifecycle:'UNKNOWN'});
  assert.deepEqual(createProjectFailureBinding({job_id:job},{}),{
    job_id:job,outcome:'UNKNOWN',lifecycle:'UNKNOWN'
  });
  let accesses=0;
  const trap=()=>{accesses++;throw Error(secret);};
  const proxy=new Proxy({},{
    get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap
  });
  const accessor={};
  Object.defineProperty(accessor,'status',{get:trap});
  Object.defineProperty(accessor,'generation',{get:trap});
  for(const result of [proxy,accessor,{status:secret,generation:{record:{lifecycle_status:secret}}}]){
    assert.deepEqual(createProjectFailureBinding({job_id:job},result),{
      job_id:job,outcome:'UNKNOWN',lifecycle:'UNKNOWN'
    });
  }
  assert.equal(accesses,0);
});
test('explicit sidecar writes bounded bound data with exclusive identity readback',async()=>{
  const m=memoryFs(),value=evidence(observed([enc(secret+' QUOTA')]).value);
  assert.deepEqual(await writeProjectFailureDiagnostics(value,run,{fs:m.fs,uid:1234}),{
    status:'RECORDED'
  });
  assert.deepEqual(m.opened,[{
    path:destination,mode:0o600,
    flags:constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|
      constants.O_NOFOLLOW|constants.O_NONBLOCK
  }]);
  assert.deepEqual(m.closed,[destination]);
  const bytes=m.files.get(destination).bytes;
  assert.ok(bytes.length<=4096);
  const text=new TextDecoder().decode(bytes);
  assert.deepEqual(JSON.parse(text),value);
  assert.equal(JSON.parse(text).binding.job_id,job);
  for(const privateText of [
    'PRIVATE_TOKEN','/private/','credential','account','sha256',secret
  ])assert.equal(text.includes(privateText),false);
  const before=new Uint8Array(bytes);
  // Even an exclusive-open rejection is uncertain once open has been invoked.
  assert.deepEqual(await writeProjectFailureDiagnostics(value,run,{fs:m.fs,uid:1234}),{
    status:'UNKNOWN'
  });
  assert.deepEqual(m.files.get(destination).bytes,before);
});
test('partial writes remain preserved and return UNKNOWN without cleanup',async()=>{
  const m=memoryFs({partialWrite:true});
  assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
    fs:m.fs,uid:1234
  }),{status:'UNKNOWN'});
  assert.equal(m.files.get(destination).bytes.length,8);
  assert.deepEqual(m.closed,[destination]);
  assert.equal(m.opened.length,1);
});
test('open uncertainty is latched before the port can create and throw',async()=>{
  for(const change of [{openBeforeCreation:true},{openAfterCreation:true}]){
    const m=memoryFs(change);
    assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
      fs:m.fs,uid:1234
    }),{status:'UNKNOWN'});
    assert.equal(m.opened.length,1);
    assert.equal(m.files.has(destination),Boolean(change.openAfterCreation));
  }
});
test('close failure is UNKNOWN and close is attempted once',async()=>{
  const m=memoryFs({close:true});
  assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
    fs:m.fs,uid:1234
  }),{status:'UNKNOWN'});
  assert.deepEqual(m.closed,[destination]);
  assert.ok(m.files.get(destination).bytes.length>0);
});
test('readback mismatch and invalid read results remain UNKNOWN',async()=>{
  for(const change of [
    {readback:true},
    {readResult:buffer=>({bytesRead:-1,buffer})},
    {readResult:buffer=>({bytesRead:5000,buffer})},
    {readResult:buffer=>({bytesRead:0,buffer})}
  ]){
    const m=memoryFs(change);
    assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
      fs:m.fs,uid:1234
    }),{status:'UNKNOWN'});
    assert.ok(m.files.has(destination));
  }
});
test('unsafe ancestry is a known pre-open rejection',async()=>{
  for(const [path,replace]of [
    [parent,s=>({...s,isSymbolicLink:()=>true})],
    [parent,s=>({...s,mode:0o40750})],
    [parent,s=>({...s,uid:9})],
    ['/owned',s=>({...s,mode:0o41777})],
    ['/owned',s=>({...s,uid:9})],
    ['/owned',s=>({...s,isSymbolicLink:()=>true})]
  ]){
    const m=memoryFs({lstat:(p,base)=>p===path?replace(base(p)):base(p)});
    assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
      fs:m.fs,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
    assert.equal(m.files.size,0);
  }
});
test('post-open mode, ownership, symlink and identity uncertainty return UNKNOWN',async()=>{
  for(const change of [
    {leaf:{mode:0o100644}},{leaf:{uid:9}},{leaf:{nlink:2}},
    {write:true},
    {lstat:(path,base)=>{
      const value=base(path);
      return path===destination?{...value,isSymbolicLink:()=>true}:value;
    }},
    {lstat:(path,base)=>{
      const value=base(path);
      return path===destination?{...value,ino:value.ino+100}:value;
    }}
  ]){
    const m=memoryFs(change);
    assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
      fs:m.fs,uid:1234
    }),{status:'UNKNOWN'});
    assert.equal(m.opened.length,1);
  }
  let calls=0;
  const ancestry=memoryFs({lstat:(path,base)=>{
    const value=base(path);
    if(path==='/owned'&&++calls>1)return {...value,ino:value.ino+100};
    return value;
  }});
  assert.deepEqual(await writeProjectFailureDiagnostics(evidence(),run,{
    fs:ancestry.fs,uid:1234
  }),{status:'UNKNOWN'});
});
test('unknown strings, extra or mismatched bindings reject before any write',async()=>{
  const base=evidence();
  for(const binding of [
    {...base.binding,job_id:'not-a-job'},
    {...base.binding,job_id:'00000000-0000-4000-8000-000000000099'},
    {...base.binding,outcome:secret},
    {...base.binding,lifecycle:secret},
    {...base.binding,command:secret},
    {...base.binding,outcome:'CANDIDATE_STAGED'}
  ]){
    const m=memoryFs();
    assert.deepEqual(await writeProjectFailureDiagnostics({...base,binding},run,{
      fs:m.fs,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  // An unavailable primary record is represented by the fixed UNKNOWN enum.
  const unknown=evidence(observed().value,{
    job_id:job,outcome:'FAILED',lifecycle:'UNKNOWN'
  });
  const m=memoryFs();
  assert.deepEqual(await writeProjectFailureDiagnostics(unknown,run,{
    fs:m.fs,uid:1234
  }),{status:'RECORDED'});
});
test('writer rejects arbitrary payloads, hooks, proxies and destinations without dispatch',async()=>{
  let accesses=0;
  const trap=()=>{accesses++;throw Error(secret);};
  const proxy=new Proxy({},{
    get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap
  });
  const base=evidence(),accessor={...base};
  Object.defineProperty(accessor,'observation',{get:trap});
  const observation=base.observation;
  for(const value of [
    proxy,accessor,{...base,payload:secret},{...base,toJSON:trap},
    {...base,binding:proxy},
    {...base,observation:{...observation,observer_error:secret}},
    {...base,observation:{...observation,markers:{...observation.markers,SECRET:1}}},
    {...base,observation:{...observation,markers:{...observation.markers,QUOTA:256}}}
  ]){
    const m=memoryFs();
    assert.deepEqual(await writeProjectFailureDiagnostics(value,run,{
      fs:m.fs,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  for(const target of [
    proxy,{scope:'relative',job_id:job},{...run,destination:secret},
    {scope,job_id:'../private'}
  ]){
    const m=memoryFs();
    assert.deepEqual(await writeProjectFailureDiagnostics(base,target,{
      fs:m.fs,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  assert.equal(accesses,0);
});

let fixtureNumber=1;
function fixture(kind='nonzero',selectedScope){
  const id=`00000000-0000-4000-8000-${String(++fixtureNumber).padStart(12,'0')}`;
  const taskScope=selectedScope??'/owned/scope-'+fixtureNumber,m=memoryFs();
  const prompt=buildProjectCodegenPrompt({
    schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'synthetic-failure-evidence',
    task_prompt:'Public synthetic source request.',
    runtime_target:DESKTOP_TARGET,stage_target:'multifile-candidate'
  });
  const c={
    schema:DESKTOP_CODEGEN_SCHEMA,runtime_admitted:false,provider_id:'native_codex',
    job_id:id,scope:taskScope,source_commit:'e'.repeat(40),
    source_pins:Object.fromEntries(DESKTOP_CODEGEN_SOURCE_FILES.map(path=>[
      join(PROJECT_SOURCE_ROOT,path),{bytes:1,sha256:'a'.repeat(64)}
    ])),
    node:NODE_RUNTIME,
    codex:{path:'/synthetic/codex',version:'0.160.0',bytes:1,sha256:'b'.repeat(64)},
    requested_model:'synthetic-model',effort:'medium',
    authorization:{
      operator_receipt:'/synthetic/operator',
      supported_tuples:[{model:'synthetic-model',effort:'medium'}]
    },
    permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'},
    prompt:{path:'/synthetic/prompt',bytes:prompt.length,sha256:hash(prompt)},
    target_mode:{mode:'multifile_stage',stage_subpath:'stage'},
    diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,
    preflight_freshness_ms:300000,outer_observation_ms:140000,
    generation_wall_ms:120000,max_direct_child_spawns:1,
    environment_policy:PROJECT_ENVIRONMENT_POLICY,
    operation_intent:DESKTOP_CODEGEN_INTENT,runtime_target:DESKTOP_TARGET,
    prefix_identity:DESKTOP_PREFIX_IDENTITY,
    desktop_runtime_identity:{
      status:'NOT_QUALIFIED',
      executable:{path:'/prospective/gjs',bytes:1,sha256:'c'.repeat(64)},
      typelibs:[{namespace:'Gtk',version:'4.0',typelib:'/prospective/Gtk.typelib',bytes:1,sha256:'d'.repeat(64)}],
      libraries:[{name:'gtk',path:'/prospective/libgtk.so',bytes:1,sha256:'f'.repeat(64)}]
    }
  };
  const bytes=canonicalBytes(c);
  const admission={
    provider_id:'native_codex',operator_receipt:c.authorization.operator_receipt,
    config_sha256:hash(bytes),job_id:id,scope:taskScope,
    desktop_codegen_admitted:true,preflight:{evidence_receipt:'/synthetic/proof'}
  };
  const proof=canonicalBytes({
    operation_config_sha256:hash(bytes),observed_at_ms:1000,
    provider_id:'native_codex',cli_version:c.codex.version,
    executable_sha256:c.codex.sha256,requested_model:c.requested_model,
    effort:c.effort,operator_receipt:c.authorization.operator_receipt,
    subscription:true,allowance_available:true,effective_provider:'openai_subscription',
    no_api_or_paid_fallback:true,sandbox:c.permissions.sandbox,
    approval_mode:c.permissions.approval_mode,output_contract:c.permissions.output_contract,
    installed_flags_verified:true
  });
  const payload=JSON.stringify({
    schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',
    files:[{
      path:'main.js',classification:'SOURCE',encoding:'utf-8',
      content:"import Gtk from 'gi://Gtk?version=4.0';\n"+'// public synthetic source\n'.repeat(50)
    }]
  });
  const jsonl=enc([
    {type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:payload}},
    {type:'turn.completed',usage:{input_tokens:1,output_tokens:2,cached_input_tokens:0,reasoning_output_tokens:0}}
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  let time=0,spawns=0;
  const timers=[],controller=new AbortController(),child=new EventEmitter();
  child.pid=123;child.kill=()=>true;child.unref=()=>{};
  for(const key of ['stdin','stdout','stderr']){
    child[key]=new EventEmitter();child[key].destroy=()=>{};
  }
  child.stdin.write=(_bytes,callback)=>{callback();return true;};
  child.stdin.end=callback=>{
    callback();
    queueMicrotask(()=>{
      if(kind!=='empty')child.stderr.emit('data',enc(secret+' TIMED OUT'));
      if(kind==='abort'){controller.abort();return;}
      if(kind==='timeout')return;
      if(kind==='success')child.stdout.emit('data',jsonl);
      child.stdout.emit('end');child.stderr.emit('end');
      child.emit('exit',kind==='success'?0:1,null);
    });
  };
  const clock={
    now:()=>time,
    schedule(delay,fn){
      const timer={at:time+delay,fn,active:true};timers.push(timer);
      return()=>{timer.active=false;};
    }
  };
  const ports={
    fs:m.fs,uid:1234,clock,now:()=>1000,environment:{},
    reads:{lstat:m.fs.lstat,readChunks:async function*(){}},
    verifyFile:async()=>{},
    readBytes:async path=>path==='/synthetic/proof'?proof:prompt,
    retention:()=>({prepare:async()=>({capability_status:'READY'})}),
    spawn(){
      spawns++;
      if(kind==='spawnfailure')throw Error(secret);
      queueMicrotask(()=>child.emit('spawn'));
      return child;
    }
  };
  async function settle(operation){
    let done=false,value,error;
    operation.then(result=>{value=result;done=true;},reason=>{error=reason;done=true;});
    for(let step=0;step<30&&!done;step++){
      for(let turn=0;turn<300;turn++)await Promise.resolve();
      if(done)break;
      const timer=timers.filter(item=>item.active).sort((a,b)=>a.at-b.at)[0];
      assert.ok(timer,'synthetic operation must settle or have a scheduled bound');
      time=timer.at;timer.active=false;timer.fn();
    }
    assert.equal(done,true);
    if(error)throw error;
    return value;
  }
  return {
    c,bytes,admission,ports,child,controller,m,settle,
    spawns:()=>spawns
  };
}

test('opt-in call chain binds actual terminal outcomes with exactly one launch',async()=>{
  for(const [kind,lifecycle,outcome]of [
    ['nonzero','LIMITED_PROCESS_FAILED','GENERATION_REJECTED'],
    ['timeout','LIMITED_TIMEOUT','INCOMPLETE'],
    ['abort','LIMITED_USER_ABORT','INCOMPLETE'],
    ['spawnfailure','LIMITED_SPAWN_FAILED','GENERATION_REJECTED']
  ]){
    const f=fixture(kind);
    const envelope=await f.settle(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
      f.bytes,f.admission,f.controller.signal,f.ports
    ));
    assert.equal(f.spawns(),1);
    assert.equal(envelope.result.generation.record.lifecycle_status,lifecycle);
    assert.equal(envelope.result.status,outcome);
    assert.equal(envelope.result.direct_child_invocations.generation,1);
    assert.equal(Object.hasOwn(envelope.result,'failure_diagnostics'),false);
    assert.equal(envelope.failure_diagnostics.sidecar_status,'NOT_REQUESTED');
    const value=envelope.failure_diagnostics.evidence;
    assert.deepEqual(value.binding,{job_id:f.c.job_id,outcome,lifecycle});
    assert.equal(value.observation.stream,kind==='spawnfailure'?'UNKNOWN':'PRESENT');
    assert.equal(Object.isFrozen(envelope.failure_diagnostics),true);
    assert.equal(Object.isFrozen(value.binding),true);
    // The fixed schema contains PRIVATE; reject the actual injected secrets.
    for(const privateText of ['PRIVATE_TOKEN_abc','/private/account/123','credential',secret]){
      assert.equal(JSON.stringify(value).includes(privateText),false);
    }
    assert.equal(f.child.stderr.listenerCount('data'),0);
    assert.equal(f.child.stderr.listenerCount('end'),0);
    assert.equal(f.m.opened.length,0);
    const before=JSON.stringify(value);
    f.child.stderr.emit('data',enc('quota '+secret));f.child.stderr.emit('end');
    assert.equal(JSON.stringify(value),before);
  }
});
test('default and opt-in failure results have identical primary values',async()=>{
  const a=fixture(),b=fixture();
  const original=await a.settle(runProjectDesktopCodegenWithPorts(
    a.bytes,a.admission,undefined,a.ports
  ));
  const wrapped=await b.settle(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    b.bytes,b.admission,undefined,b.ports
  ));
  // The only fixture-specific field in these failed primary records is job_id.
  const primary=value=>{
    const result=JSON.parse(JSON.stringify(value));
    result.generation.record.job_id='fixture-job';
    return result;
  };
  assert.deepEqual(primary(wrapped.result),primary(original));
  assert.equal(Object.hasOwn(original,'result'),false);
  assert.equal(Object.hasOwn(original,'failure_diagnostics'),false);
  assert.equal(a.m.opened.length,0);
  assert.equal(b.m.opened.length,0);
});
test('empty stderr is bound without inventing a marker or cause',async()=>{
  const f=fixture('empty');
  const envelope=await f.settle(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    f.bytes,f.admission,undefined,f.ports
  ));
  const value=envelope.failure_diagnostics.evidence;
  assert.equal(value.observation.completeness,'EMPTY_COMPLETE');
  assert.equal(value.observation.byte_count,0);
  assert.equal(Object.values(value.observation.markers).every(count=>count===0),true);
  assert.equal(value.binding.lifecycle,'LIMITED_PROCESS_FAILED');
});
test('observation wrapper starts zero diagnostic FS operations even if they would hang',async()=>{
  const f=fixture();
  let diagnosticCalls=0;
  const originalLstat=f.ports.fs.lstat;
  f.ports.fs.lstat=async path=>{
    if(path!==f.c.scope){
      diagnosticCalls++;
      return new Promise(()=>{});
    }
    return originalLstat(path);
  };
  f.ports.fs.open=()=>{
    diagnosticCalls++;
    return new Promise(()=>{});
  };
  const envelope=await f.settle(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    f.bytes,f.admission,undefined,f.ports
  ));
  assert.equal(envelope.result.generation.record.lifecycle_status,'LIMITED_PROCESS_FAILED');
  assert.equal(envelope.failure_diagnostics.sidecar_status,'NOT_REQUESTED');
  assert.equal(diagnosticCalls,0);
  assert.equal(f.spawns(),1);
  for(let turn=0;turn<20;turn++)await Promise.resolve();
  assert.equal(diagnosticCalls,0);
});
test('separately awaited writer uncertainty never rewrites the primary result',async()=>{
  const f=fixture();
  const envelope=await f.settle(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    f.bytes,f.admission,undefined,f.ports
  ));
  const before=JSON.stringify(envelope);
  const writer=memoryFs({partialWrite:true});
  const acknowledgement=await writeProjectFailureDiagnostics(
    envelope.failure_diagnostics.evidence,
    {scope:f.c.scope,job_id:f.c.job_id},{fs:writer.fs,uid:1234}
  );
  assert.deepEqual(acknowledgement,{status:'UNKNOWN'});
  assert.equal(JSON.stringify(envelope),before);
  assert.equal(f.spawns(),1);
});
test('admission throws remain throws and create no diagnostic artifacts',async()=>{
  const f=fixture();
  await assert.rejects(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    f.bytes,null,undefined,f.ports
  ));
  assert.equal(f.spawns(),0);assert.equal(f.m.opened.length,0);
  const aborted=fixture();aborted.controller.abort();
  await assert.rejects(runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    aborted.bytes,aborted.admission,aborted.controller.signal,aborted.ports
  ));
  assert.equal(aborted.spawns(),0);assert.equal(aborted.m.opened.length,0);
});
test('successful synthetic staging retains no failure evidence or sidecar',async()=>{
  const root=await nativeFs.mkdtemp(join(tmpdir(),'squire-failure-evidence-'));
  await nativeFs.chmod(root,0o700);
  try{
    const f=fixture('success',join(root,'scope'));
    f.ports.fs=nativeFs;f.ports.uid=process.getuid();
    const envelope=await runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
      f.bytes,f.admission,undefined,f.ports
    );
    assert.equal(envelope.result.status,'CANDIDATE_STAGED');
    assert.equal(envelope.result.generation.record.lifecycle_status,'LIMITED_SUCCESS');
    assert.deepEqual(envelope.failure_diagnostics,{status:'NOT_RETAINED_SUCCESS'});
    assert.equal(f.spawns(),1);
    assert.equal(f.child.stderr.listenerCount('data'),0);
    const directory=join(f.c.scope,'output','run-'+f.c.job_id);
    const names=await nativeFs.readdir(directory);
    assert.equal(names.includes('failure-diagnostics.json'),false);
    assert.ok(names.includes('candidate-envelope.json'));
    assert.ok(names.includes('stage'));
  }finally{await nativeFs.rm(root,{recursive:true,force:true});}
});
test('legacy eager import closure excludes diagnostics while desktop closure pins the lazy dependency',async()=>{
  const entry=join(PROJECT_SOURCE_ROOT,'acceptance/project-entrypoint.mjs');
  const diagnostic=join(PROJECT_SOURCE_ROOT,'src/project-failure-diagnostics.mjs');
  const staticImports=/^\s*(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?['"](\.[^'"]+)['"]/gm;
  const dynamicImports=/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  async function closure(includeDynamic){
    const queue=[entry],seen=new Set();
    while(queue.length){
      const path=queue.pop();if(seen.has(path))continue;seen.add(path);
      const source=await nativeFs.readFile(path,'utf8');
      for(const match of source.matchAll(staticImports)){
        queue.push(resolve(dirname(path),match[1]));
      }
      if(includeDynamic){
        for(const match of source.matchAll(dynamicImports)){
          queue.push(resolve(dirname(path),match[1]));
        }
      }
    }
    return seen;
  }
  const eager=await closure(false),desktop=await closure(true);
  assert.ok(eager.has(join(PROJECT_SOURCE_ROOT,'src/project-runner.mjs')));
  assert.ok(eager.has(join(PROJECT_SOURCE_ROOT,'src/project-result-receipt.mjs')));
  assert.equal(eager.has(diagnostic),false);
  assert.equal(desktop.has(diagnostic),true);
  const inventory=new Set(DESKTOP_CODEGEN_SOURCE_FILES.map(path=>join(PROJECT_SOURCE_ROOT,path)));
  for(const path of desktop)assert.ok(inventory.has(path),'Missing desktop dependency: '+path);
  assert.equal(PROJECT_SOURCE_FILES.includes('src/project-failure-diagnostics.mjs'),false);
  const source=await nativeFs.readFile(entry,'utf8');
  const start=source.indexOf('export async function runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(');
  const end=source.indexOf('// Trusted capability injection',start);
  assert.ok(start>=0&&end>start);
  assert.equal(source.slice(start,end).match(
    /import\('\.\.\/src\/project-failure-diagnostics\.mjs'\)/g
  )?.length,1);
  assert.equal(source.slice(0,start).includes("import('../src/project-failure-diagnostics.mjs')"),false);
  assert.equal(source.slice(end).includes("import('../src/project-failure-diagnostics.mjs')"),false);
  assert.equal(projectDryRun().status,'DRY_RUN_NATIVE_DISABLED');
  assert.equal(desktopCodegenEntrypointMode([]),'DRY_RUN_NATIVE_DISABLED');
  assert.equal(runProjectDesktopCodegenNativeWithFailureDiagnostics.length,3);
});
