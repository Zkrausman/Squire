// Native activation requires exact separate admission; import/default/dry run are inert.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
import {readReceiptBytes} from '../bin/squire-report.mjs';
import {parseReceiptJson,snapshotReceiptData} from '../src/offline-run-summary.mjs';
import {validateCodexPreflight,verifyExactFile,hash} from '../src/bounded-codegen-plan.mjs';
import {PROJECT_SOURCE_ROOT,validateProjectCodexConfig,requireProjectCodexAdmission,validateProjectReceiptDestination,validateDesktopCodegenConfig,requireDesktopCodegenAdmission,validateDesktopCodingLargeObservationConfig,validateDesktopCodingLargeObservationAdmission,requireDesktopCodingLargeObservationAdmission,DESKTOP_CODEGEN_INTENT} from '../src/project-configuration.mjs';
import {closed,object,artifactPath} from '../src/job-spec.mjs';
import {writeNativeProjectResultReceipt} from '../src/project-result-receipt.mjs';
import {runProjectCodexTask,admitDesktopCodegenProjectTask,runDesktopCodingLargeObservationProjectTask,admitDesktopCodingLargeObservationProjectTask} from '../src/project-runner.mjs';
import {createMonotonicClock} from '../src/node-process-port.mjs';
import {createNativeRejectedRetention} from '../src/local-rejected-retention.mjs';
import {
  PROJECT_CODING_OBSERVATION_CONFIG_SCHEMA,PROJECT_CODING_OBSERVATION_RESULT_SCHEMA,
  PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,PROJECT_CODING_OBSERVATION_PROFILE,
  validateProjectCodingObservationProfile,validateProjectOutputLargeProfile
} from '../src/project-coding-profile.mjs';
const consumed=new Set();
const desktopCodegenFlag='--run-admitted-desktop-codegen';
const desktopCodingLargeObservationFlag='--run-admitted-desktop-coding-large-observation';
export const desktopCodegenEntrypointMode=args=>args.length===3&&args[0]===desktopCodegenFlag?'EXPLICIT_DESKTOP_CODEGEN_ADMISSION_REQUIRED':'DRY_RUN_NATIVE_DISABLED';
export const desktopCodingLargeObservationEntrypointMode=args=>
  args.length===3&&args[0]===desktopCodingLargeObservationFlag
    ?'EXPLICIT_DESKTOP_CODING_LARGE_OBSERVATION_ADMISSION_REQUIRED'
    :'DRY_RUN_NATIVE_DISABLED';

// Pure binding builder shared by the native wrapper and injected source tests.
// There is no executable override, loader, shell, evaluator or provider callback.
export function buildDesktopCodegenInvocation(config,promptBytes){
  const c=validateDesktopCodegenConfig(config);
  const length=receiptByteLength(promptBytes);
  if(length!==c.prompt.bytes)throw Error('PROMPT_CHANGED');
  // The branded typed-array source takes the intrinsic byte-copy path.
  // Neither caller length/byteLength properties nor its iterator are read.
  const bytes=new Uint8Array(length);
  Uint8Array.prototype.set.call(bytes,promptBytes);
  if(hash(bytes)!==c.prompt.sha256)throw Error('PROMPT_CHANGED');
  const specification=admitDesktopCodegenProjectTask({
    job_id:c.job_id,task_scope:c.scope,requested_model:c.requested_model,
    effort:c.effort,max_wall_clock_sec:c.generation_wall_ms===null?null:c.generation_wall_ms/1000,prompt_bytes:bytes,
    runtime_target:c.runtime_target,prefix_identity:c.prefix_identity,
    desktop_runtime_identity:c.desktop_runtime_identity,
    ...(c.schema===PROJECT_CODING_OBSERVATION_CONFIG_SCHEMA?{execution_profile:c.execution_profile}:{})
  });
  return Object.freeze({
    specification,mode:'DESKTOP_CODEGEN_ONLY',operation_intent:DESKTOP_CODEGEN_INTENT,
    executable:c.codex.path,
    codex:Object.freeze({
      observed_cli_version:c.codex.version,
      authorization:c.authorization,permissions:c.permissions
    })
  });
}
export function buildDesktopCodingLargeObservationInvocation(config,promptBytes){
  const c=validateDesktopCodingLargeObservationConfig(config);
  const length=receiptByteLength(promptBytes);
  if(length!==c.prompt.bytes||length>32768)throw Error('PROMPT_CHANGED');
  const bytes=new Uint8Array(length);
  Uint8Array.prototype.set.call(bytes,promptBytes);
  if(hash(bytes)!==c.prompt.sha256)throw Error('PROMPT_CHANGED');
  const specification=admitDesktopCodingLargeObservationProjectTask({
    job_id:c.job_id,task_scope:c.scope,requested_model:c.requested_model,
    effort:c.effort,max_wall_clock_sec:null,prompt_bytes:bytes,
    runtime_target:c.runtime_target,prefix_identity:c.prefix_identity,
    desktop_runtime_identity:c.desktop_runtime_identity,
    execution_profile:PROJECT_CODING_OBSERVATION_PROFILE,
    output_profile:validateProjectOutputLargeProfile(c.output_profile)
  });
  return Object.freeze({
    specification,mode:'DESKTOP_CODEGEN_ONLY',operation_intent:DESKTOP_CODEGEN_INTENT,
    executable:c.codex.path,
    codex:Object.freeze({
      observed_cli_version:c.codex.version,
      authorization:c.authorization,permissions:c.permissions
    })
  });
}
function nativeDesktopCodegenPorts(){
  return {
    fs,spawn,readBytes:readReceiptBytes,verifyFile:verifyExactFile,
    reads:{lstat:fs.lstat,readChunks:p=>createReadStream(p)},
    now:Date.now,clock:createMonotonicClock(),
    retention:createNativeRejectedRetention,environment:process.env,uid:process.getuid()
  };
}
export async function runProjectDesktopCodegenNative(configBytes,admission,abortSignal){
  return runProjectDesktopCodegenWithPorts(configBytes,admission,abortSignal,nativeDesktopCodegenPorts());
}
// Separate explicit opt-in API. Legacy/default/native/CLI/receipt routes neither
// load the observer module nor change their result shapes.
export async function runProjectDesktopCodegenNativeWithFailureDiagnostics(configBytes,admission,abortSignal){
  return runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(
    configBytes,admission,abortSignal,nativeDesktopCodegenPorts()
  );
}
export async function runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(configBytes,admission,abortSignal,ports){
  closed(ports,['fs','spawn','readBytes','verifyFile','reads','now','clock','retention','environment','uid'],[],'desktop_codegen_ports');
  receiptFunction(ports.spawn);
  const c=validateDesktopCodegenConfig(parseReceiptJson(configBytes));
  // Fixed literal import only on the explicit opt-in call path. Future desktop
  // preparations pin this module; legacy eager import closures stay unchanged.
  const {
    createProjectFailureObserver,createProjectFailureBinding,
    createProjectFailureEvidence
  }=await loadProjectFailureDiagnostics();
  const observer=createProjectFailureObserver();
  let result,observation;
  try{
    result=await runProjectDesktopCodegenWithPorts(configBytes,admission,abortSignal,{
      ...ports,
      spawn(executable,argv,options){
        const child=ports.spawn(executable,argv,options);
        observer.observe(child);
        return child;
      }
    });
  }finally{observation=observer.seal();}
  if(result.status==='CANDIDATE_STAGED'){
    return Object.freeze({
      result,
      failure_diagnostics:Object.freeze({status:'NOT_RETAINED_SUCCESS'})
    });
  }
  const binding=createProjectFailureBinding(c,result);
  const evidence=createProjectFailureEvidence(binding,observation);
  // Observation only: no diagnostic filesystem operation is started here.
  // A host may separately await the explicit writer under its accepted window.
  return Object.freeze({
    result,
    failure_diagnostics:Object.freeze({
      status:'OBSERVED',evidence,sidecar_status:'NOT_REQUESTED'
    })
  });
}
async function loadProjectFailureDiagnostics(){
  return import('../src/project-failure-diagnostics.mjs');
}
// Separate explicit phase API. Capture the trusted monotonic origin before
// async intake; observer failures never replace a known primary result.
export async function runProjectDesktopCodegenNativeWithPhaseDiagnostics(configBytes,admission,abortSignal){
  return runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(
    configBytes,admission,abortSignal,nativeDesktopCodegenPorts()
  );
}
export async function runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(configBytes,admission,abortSignal,ports){
  closed(ports,['fs','spawn','readBytes','verifyFile','reads','now','clock','retention','environment','uid'],[],'desktop_codegen_ports');
  receiptFunction(ports.spawn);
  closed(ports.clock,['now','schedule'],[],'desktop_codegen_clock');
  receiptFunction(ports.clock.now);receiptFunction(ports.clock.schedule);
  let origin=null;
  try{
    const value=ports.clock.now();
    if(Number.isSafeInteger(value)&&value>=0)origin=value;
  }catch{}
  const c=validateDesktopCodegenConfig(parseReceiptJson(configBytes));
  let module=null,observer=null;
  try{
    module=await loadProjectPhaseDiagnostics();
    observer=module.createProjectPhaseObserver(ports.clock,origin);
  }catch{}
  let result,observation=null;
  try{
    result=await runProjectDesktopCodegenWithPorts(configBytes,admission,abortSignal,{
      ...ports,
      spawn(executable,argv,options){
        try{observer?.spawnAttempt();}catch{}
        const child=ports.spawn(executable,argv,options);
        try{observer?.observe(child);}catch{}
        return child;
      }
    });
    try{observer?.primaryResultReturned();}catch{}
  }finally{
    try{observation=observer?.seal()??null;}catch{}
  }
  let phase_diagnostics;
  try{
    if(!module||!observation||observation.observer_error==='OBSERVER_ERROR')throw 0;
    const binding=module.createProjectPhaseBinding(c,result);
    const evidence=module.createProjectPhaseEvidence(binding,observation);
    phase_diagnostics=Object.freeze({
      status:'OBSERVED',evidence,sidecar_status:'NOT_REQUESTED'
    });
  }catch{
    phase_diagnostics=Object.freeze({
      status:'UNAVAILABLE',reason:'OBSERVER_ERROR',sidecar_status:'NOT_REQUESTED'
    });
  }
  return Object.freeze({result,phase_diagnostics});
}
async function loadProjectPhaseDiagnostics(){
  return import('../src/project-phase-diagnostics.mjs');
}
// Trusted capability injection for ordinary source acceptance. The production
// wrapper above supplies the fixed native backend; operation files supply data.
export async function runProjectDesktopCodegenWithPorts(configBytes,admission,abortSignal,ports){
  if(!admission)throw Error('UNADMITTED_NATIVE_OPERATION');
  closed(ports,['fs','spawn','readBytes','verifyFile','reads','now','clock','retention','environment','uid'],[],'desktop_codegen_ports');
  for(const key of ['spawn','readBytes','verifyFile','now','retention'])receiptFunction(ports[key]);
  closed(ports.reads,['lstat','readChunks'],[],'desktop_codegen_reads');
  receiptFunction(ports.reads.lstat);receiptFunction(ports.reads.readChunks);
  closed(ports.clock,['now','schedule'],[],'desktop_codegen_clock');
  receiptFunction(ports.clock.now);receiptFunction(ports.clock.schedule);
  if(!Number.isSafeInteger(ports.uid)||ports.uid<0||
     abortSignal!==undefined&&!(abortSignal instanceof AbortSignal))throw Error('DESKTOP_CODEGEN_PORTS_INVALID');
  const c=validateDesktopCodegenConfig(parseReceiptJson(configBytes));
  const observation=c.schema===PROJECT_CODING_OBSERVATION_CONFIG_SCHEMA;
  const a=requireDesktopCodegenAdmission(admission,c,configBytes);
  if(consumed.has(c.job_id)||consumed.has(c.scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');
  const controller=new AbortController();
  const signal=abortSignal?AbortSignal.any([abortSignal,controller.signal]):controller.signal;
  const wait=operation=>{
    if(!observation)return operation();
    if(signal.aborted)return Promise.reject(Error('OPERATION_ABORTED'));
    let listener;
    const aborted=new Promise((_,reject)=>{
      listener=()=>reject(Error('OPERATION_ABORTED'));
      signal.addEventListener('abort',listener,{once:true});
    });
    const work=Promise.resolve().then(()=>{
      if(signal.aborted)throw Error('OPERATION_ABORTED');
      return operation();
    });
    return Promise.race([work,aborted]).finally(()=>signal.removeEventListener('abort',listener));
  };
  for(const identity of [c.node,c.codex,c.prompt,...Object.entries(c.source_pins).map(([path,pin])=>({path,...pin}))]){
    await wait(()=>ports.verifyFile(identity,ports.reads));
  }
  const proofBytes=await wait(()=>ports.readBytes(a.preflight.evidence_receipt,65536));
  receiptByteLength(proofBytes);
  validateCodexPreflight(parseReceiptJson(proofBytes),c,configBytes,ports.now());
  const promptBytes=await wait(()=>ports.readBytes(c.prompt.path,32768));
  const invocation=buildDesktopCodegenInvocation(c,promptBytes);
  consumed.add(c.job_id);consumed.add(c.scope);
  const retention=ports.retention(c.job_id),gate=await wait(()=>retention.prepare());
  if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  const counts={generation:0};
  const cancel=observation?()=>{}:ports.clock.schedule(c.outer_observation_ms,()=>controller.abort());
  if(typeof cancel!=='function')throw Error('SCHEDULER_UNAVAILABLE');
  try{
    if(signal.aborted)throw Error('OPERATION_ABORTED');
    await wait(()=>ports.fs.mkdir(c.scope,{mode:0o700}));
    const result=await runProjectCodexTask(invocation.specification,
      {clock:ports.clock,shutdown:c.generation_shutdown,abortSignal:signal},
      {
        fs:ports.fs,uid:ports.uid,mode:invocation.mode,
        operation_intent:invocation.operation_intent,executable:invocation.executable,
        codex:invocation.codex,environment:ports.environment,
        retainRejected:retention.retainRejected,
        spawn(executable,argv,options){
          if(signal.aborted||++counts.generation>1||
             executable!==invocation.executable||options.shell!==false)throw Error('PROJECT_SPAWN_LIMIT');
          return ports.spawn(executable,argv,options);
        }
      });
    return Object.freeze({...result,operator_admitted:true,operator_receipt:a.operator_receipt,
      direct_child_invocations:Object.freeze({...counts})});
  }finally{cancel();}
}
export async function runProjectDesktopCodingLargeObservationNative(configBytes,admission,abortSignal){
  return runProjectDesktopCodingLargeObservationWithPorts(
    configBytes,admission,abortSignal,nativeDesktopCodegenPorts()
  );
}
export async function runProjectDesktopCodingLargeObservationNativeWithFailureDiagnostics(configBytes,admission,abortSignal){
  return runProjectDesktopCodingLargeObservationWithFailureDiagnosticsWithPorts(
    configBytes,admission,abortSignal,nativeDesktopCodegenPorts()
  );
}
export async function runProjectDesktopCodingLargeObservationNativeWithPhaseDiagnostics(configBytes,admission,abortSignal){
  return runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts(
    configBytes,admission,abortSignal,nativeDesktopCodegenPorts()
  );
}
function validateLargeDesktopPorts(ports){
  closed(ports,['fs','spawn','readBytes','verifyFile','reads','now','clock','retention','environment','uid'],[],'desktop_codegen_ports');
  for(const key of ['spawn','readBytes','verifyFile','now','retention'])receiptFunction(ports[key]);
  closed(ports.reads,['lstat','readChunks'],[],'desktop_codegen_reads');
  receiptFunction(ports.reads.lstat);receiptFunction(ports.reads.readChunks);
  closed(ports.clock,['now','schedule'],[],'desktop_codegen_clock');
  receiptFunction(ports.clock.now);receiptFunction(ports.clock.schedule);
  if(!Number.isSafeInteger(ports.uid)||ports.uid<0)throw Error('DESKTOP_CODEGEN_PORTS_INVALID');
}
export async function runProjectDesktopCodingLargeObservationWithPorts(configBytes,admission,abortSignal,ports){
  if(!admission)throw Error('UNADMITTED_NATIVE_OPERATION');
  validateLargeDesktopPorts(ports);
  if(abortSignal!==undefined&&!(abortSignal instanceof AbortSignal))throw Error('DESKTOP_CODEGEN_PORTS_INVALID');
  receiptByteLength(configBytes);
  const c=validateDesktopCodingLargeObservationConfig(parseReceiptJson(configBytes));
  const a=requireDesktopCodingLargeObservationAdmission(admission,c,configBytes);
  if(consumed.has(c.job_id)||consumed.has(c.scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');
  const controller=new AbortController();
  const signal=abortSignal?AbortSignal.any([abortSignal,controller.signal]):controller.signal;
  const wait=operation=>{
    if(signal.aborted)return Promise.reject(Error('OPERATION_ABORTED'));
    let listener;
    const aborted=new Promise((_,reject)=>{
      listener=()=>reject(Error('OPERATION_ABORTED'));
      signal.addEventListener('abort',listener,{once:true});
    });
    const work=Promise.resolve().then(()=>{
      if(signal.aborted)throw Error('OPERATION_ABORTED');
      return operation();
    });
    return Promise.race([work,aborted]).finally(()=>signal.removeEventListener('abort',listener));
  };
  for(const identity of [c.node,c.codex,c.prompt,...Object.entries(c.source_pins).map(([path,pin])=>({path,...pin}))]){
    await wait(()=>ports.verifyFile(identity,ports.reads));
  }
  const proofBytes=await wait(()=>ports.readBytes(a.preflight.evidence_receipt,65536));
  receiptByteLength(proofBytes);
  validateCodexPreflight(parseReceiptJson(proofBytes),c,configBytes,ports.now());
  const promptBytes=await wait(()=>ports.readBytes(c.prompt.path,32768));
  const invocation=buildDesktopCodingLargeObservationInvocation(c,promptBytes);
  consumed.add(c.job_id);consumed.add(c.scope);
  const retention=ports.retention(c.job_id),gate=await wait(()=>retention.prepare());
  if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  if(signal.aborted)throw Error('OPERATION_ABORTED');
  await wait(()=>ports.fs.mkdir(c.scope,{mode:0o700}));
  const counts={generation:0};
  const result=await runDesktopCodingLargeObservationProjectTask(
    invocation.specification,
    {clock:ports.clock,shutdown:c.generation_shutdown,abortSignal:signal},
    {
      fs:ports.fs,uid:ports.uid,mode:invocation.mode,
      operation_intent:invocation.operation_intent,executable:invocation.executable,
      codex:invocation.codex,environment:ports.environment,
      retainRejected:retention.retainRejected,
      spawn(executable,argv,options){
        if(signal.aborted||++counts.generation>1||
           executable!==invocation.executable||options.shell!==false)throw Error('PROJECT_SPAWN_LIMIT');
        return ports.spawn(executable,argv,options);
      }
    }
  );
  if(result.schema!==PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA)throw Error('INVALID_LARGE_OBSERVATION_RESULT');
  return Object.freeze({...result,operator_admitted:true,operator_receipt:a.operator_receipt,
    direct_child_invocations:Object.freeze({...counts})});
}
const READINESS_COMPANION_PATHS=Object.freeze([
  'src/desktop-readiness-evidence.mjs',
  'src/project-artifact-check-evidence.mjs',
  'src/artifact-verifier.mjs',
  'src/job-record.mjs'
]);
const READINESS_SHA256=/^[a-f0-9]{64}$/;
const READINESS_INPUT_BYTES=65536;
const READINESS_ROUTE_BYTES=16384;
const READINESS_DEFINITION_BYTES=1048576;
const READINESS_COMPANION_TOTAL=4194304;
const READINESS_CODES=new Set([
  'INVALID_READINESS_CONTEXT','READINESS_EVIDENCE_BLOCKED',
  'OPERATION_ABORTED','NATIVE_OPERATION_ALREADY_CONSUMED'
]);
const readinessByteLength=Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),'byteLength'
).get;

function readinessFixedError(code){
  const error=new Error(code);
  error.code=code;
  return error;
}

// Only fixed own data fields are inspected. In particular, this recognizes
// the existing shared-admission error by its exact fixed message, without
// exporting arbitrary error text or invoking a getter or proxy trap.
function readinessErrorCode(error){
  if(!error||typeof error!=='object'||types.isProxy(error))return null;
  try{
    const code=Object.getOwnPropertyDescriptor(error,'code');
    if(code&&Object.hasOwn(code,'value')&&READINESS_CODES.has(code.value)){
      return code.value;
    }
    const message=Object.getOwnPropertyDescriptor(error,'message');
    if(message&&Object.hasOwn(message,'value')&&
       message.value==='NATIVE_OPERATION_ALREADY_CONSUMED'){
      return 'NATIVE_OPERATION_ALREADY_CONSUMED';
    }
  }catch{}
  return null;
}

function copyReadinessInputBytes(value,maxBytes){
  if(types.isProxy(value)||!types.isUint8Array(value)||
     Object.getPrototypeOf(value)!==Uint8Array.prototype){
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
  let length;
  try{length=Reflect.apply(readinessByteLength,value,[]);}
  catch{throw readinessFixedError('INVALID_READINESS_CONTEXT');}
  if(!Number.isSafeInteger(length)||length<0||length>maxBytes){
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
  const copy=new Uint8Array(length);
  try{Uint8Array.prototype.set.call(copy,value);}
  catch{copy.fill(0);throw readinessFixedError('INVALID_READINESS_CONTEXT');}
  return copy;
}

function readinessOwnDataRecord(value,keys,code='INVALID_READINESS_CONTEXT'){
  try{closed(value,keys,[],code);}
  catch{throw readinessFixedError(code);}
  const result=Object.create(null);
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')){
      throw readinessFixedError(code);
    }
    result[key]=descriptor.value;
  }
  return result;
}

function readinessDataMethod(target,key){
  if(!target||typeof target!=='object'&&typeof target!=='function'||
     types.isProxy(target)){
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
  try{
    for(let current=target;current!==null;current=Object.getPrototypeOf(current)){
      if(types.isProxy(current))throw 0;
      const descriptor=Object.getOwnPropertyDescriptor(current,key);
      if(!descriptor)continue;
      if(!Object.hasOwn(descriptor,'value')||
         typeof descriptor.value!=='function'||types.isProxy(descriptor.value)){
        throw 0;
      }
      return descriptor.value;
    }
  }catch{throw readinessFixedError('INVALID_READINESS_CONTEXT');}
  throw readinessFixedError('INVALID_READINESS_CONTEXT');
}

function readinessBoundMethod(target,key){
  const method=readinessDataMethod(target,key);
  return (...args)=>Reflect.apply(method,target,args);
}

function captureReadinessLargeDesktopPorts(value){
  const keys=[
    'fs','spawn','readBytes','verifyFile','reads','now','clock','retention',
    'environment','uid'
  ];
  const supplied=readinessOwnDataRecord(value,keys);
  for(const key of ['spawn','readBytes','verifyFile','now','retention']){
    receiptFunction(supplied[key]);
  }
  const reads=readinessOwnDataRecord(supplied.reads,['lstat','readChunks']);
  receiptFunction(reads.lstat);
  receiptFunction(reads.readChunks);
  const clock=readinessOwnDataRecord(supplied.clock,['now','schedule']);
  receiptFunction(clock.now);
  receiptFunction(clock.schedule);
  if(!Number.isSafeInteger(supplied.uid)||supplied.uid<0){
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
  try{object(supplied.fs,'readiness_fs');}
  catch{throw readinessFixedError('INVALID_READINESS_CONTEXT');}
  const fsMethods=Object.create(null);
  for(const key of ['lstat','realpath','open','mkdir','chmod','readdir']){
    fsMethods[key]=readinessBoundMethod(supplied.fs,key);
  }
  let environment;
  try{
    object(supplied.environment,'readiness_environment');
    environment=snapshotReceiptData(supplied.environment);
  }catch{throw readinessFixedError('INVALID_READINESS_CONTEXT');}
  return Object.freeze({
    fs:Object.freeze(fsMethods),
    spawn:readinessBoundMethod(value,'spawn'),
    readBytes:readinessBoundMethod(value,'readBytes'),
    verifyFile:readinessBoundMethod(value,'verifyFile'),
    reads:Object.freeze({
      lstat:readinessBoundMethod(supplied.reads,'lstat'),
      readChunks:readinessBoundMethod(supplied.reads,'readChunks')
    }),
    now:readinessBoundMethod(value,'now'),
    clock:Object.freeze({
      now:readinessBoundMethod(supplied.clock,'now'),
      schedule:readinessBoundMethod(supplied.clock,'schedule')
    }),
    retention:readinessBoundMethod(value,'retention'),
    environment,uid:supplied.uid
  });
}

function captureReadinessCompanionPins(contextBytes){
  try{
    const context=snapshotReceiptData(parseReceiptJson(contextBytes));
    const value=readinessOwnDataRecord(context,[
      'schema','requirements','proof_pin','observer_definition_pin',
      'fixture_definition_pin','observer_terminal_pin','probe_artifacts',
      'companion_source_pins'
    ]);
    if(value.schema!=='squire.desktop_readiness_context.v2'){
      throw readinessFixedError('INVALID_READINESS_CONTEXT');
    }
    const supplied=readinessOwnDataRecord(
      value.companion_source_pins,READINESS_COMPANION_PATHS
    );
    let total=0;
    return READINESS_COMPANION_PATHS.map(relative=>{
      const pin=readinessOwnDataRecord(supplied[relative],['bytes','sha256']);
      if(!Number.isSafeInteger(pin.bytes)||pin.bytes<1||
         pin.bytes>READINESS_DEFINITION_BYTES||
         typeof pin.sha256!=='string'||!READINESS_SHA256.test(pin.sha256)){
        throw readinessFixedError('INVALID_READINESS_CONTEXT');
      }
      total+=pin.bytes;
      if(!Number.isSafeInteger(total)||total>READINESS_COMPANION_TOTAL){
        throw readinessFixedError('INVALID_READINESS_CONTEXT');
      }
      return Object.freeze({
        path:join(PROJECT_SOURCE_ROOT,relative),
        bytes:pin.bytes,sha256:pin.sha256
      });
    });
  }catch(error){
    if(readinessErrorCode(error))throw error;
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
}

function readinessBindingSnapshotMatches(api,captured,configBytes,
  contextBytes,routeBytes,config){
  const copies=[];
  try{
    for(const name of ['config','context','selected_route']){
      copies.push(api.copyCapturedDesktopReadinessBytes(captured,name));
    }
    if(hash(copies[0])!==hash(configBytes)||
       hash(copies[1])!==hash(contextBytes)||
       hash(copies[2])!==hash(routeBytes)||
       captured.config.job_id!==config.job_id||
       captured.config.scope!==config.scope||
       captured.config.source_commit!==config.source_commit||
       captured.context.requirements.operation_config_sha256!==hash(configBytes)||
       captured.context.requirements.job_id!==config.job_id||
       captured.context.requirements.scope!==config.scope){
      throw readinessFixedError('READINESS_EVIDENCE_BLOCKED');
    }
  }catch(error){
    if(readinessErrorCode(error))throw error;
    throw readinessFixedError('READINESS_EVIDENCE_BLOCKED');
  }finally{for(const bytes of copies)bytes.fill(0);}
}

const NATIVE_READINESS_ENVIRONMENT_MAX_KEYS=4096;
const NATIVE_READINESS_ENVIRONMENT_MAX_BYTES=262144;

function copyNativeReadinessEnvironment(){
  let source,keys;
  try{
    const descriptor=Object.getOwnPropertyDescriptor(process,'env');
    if(!descriptor||!Object.hasOwn(descriptor,'value'))throw 0;
    source=descriptor.value;
    if(!source||typeof source!=='object'||Array.isArray(source)||
       types.isProxy(source))throw 0;
    keys=Reflect.ownKeys(source);
  }catch{
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
  if(!Array.isArray(keys)||keys.length>NATIVE_READINESS_ENVIRONMENT_MAX_KEYS){
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
  const copied={};
  const encoder=new TextEncoder();
  let totalBytes=0;
  try{
    for(const key of keys){
      if(typeof key!=='string')throw 0;
      const property=Object.getOwnPropertyDescriptor(source,key);
      if(!property||!Object.hasOwn(property,'value')||
         typeof property.enumerable!=='boolean')throw 0;
      if(!property.enumerable)continue;
      if(typeof property.value!=='string'||key.length>4096||
         property.value.length>NATIVE_READINESS_ENVIRONMENT_MAX_BYTES)throw 0;
      totalBytes+=encoder.encode(key).length;
      totalBytes+=encoder.encode(property.value).length;
      if(!Number.isSafeInteger(totalBytes)||
         totalBytes>NATIVE_READINESS_ENVIRONMENT_MAX_BYTES)throw 0;
      Object.defineProperty(copied,key,{
        value:property.value,enumerable:true,writable:true,configurable:true
      });
    }
    snapshotReceiptData(copied);
    return copied;
  }catch{
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }
}

/**
 * Explicit readiness-gated large observation. Evidence acquisition and
 * physical checking stay delegated to the accepted reader and its verifiers.
 */
export async function runProjectDesktopCodingLargeObservationNativeWithReadiness(
  configBytes,admission,readinessContextBytes,selectedRouteBytes,abortSignal
){
  const nativePorts=nativeDesktopCodegenPorts();
  return runProjectDesktopCodingLargeObservationWithReadinessWithPorts(
    configBytes,admission,readinessContextBytes,selectedRouteBytes,
    abortSignal,{
      ...nativePorts,
      environment:copyNativeReadinessEnvironment()
    }
  );
}

export async function runProjectDesktopCodingLargeObservationWithReadinessWithPorts(
  configBytes,admission,readinessContextBytes,selectedRouteBytes,abortSignal,ports
){
  let privateConfig=null,privateContext=null,privateRoute=null;
  let privateAdmission=null,promptBytes=null,subscriptionBytes=null;
  let consumedAtCP1=false;
  try{
    const capturedPorts=captureReadinessLargeDesktopPorts(ports);
    privateConfig=copyReadinessInputBytes(configBytes,READINESS_INPUT_BYTES);
    privateContext=copyReadinessInputBytes(
      readinessContextBytes,READINESS_INPUT_BYTES
    );
    privateRoute=copyReadinessInputBytes(
      selectedRouteBytes,READINESS_ROUTE_BYTES
    );
    if(abortSignal!==undefined&&
       (types.isProxy(abortSignal)||!(abortSignal instanceof AbortSignal))){
      throw readinessFixedError('INVALID_READINESS_CONTEXT');
    }
    const config=validateDesktopCodingLargeObservationConfig(
      parseReceiptJson(privateConfig)
    );
    privateAdmission=snapshotReceiptData(admission);
    const pureAdmission=validateDesktopCodingLargeObservationAdmission(
      privateAdmission,privateConfig
    );
    if(consumed.has(config.job_id)||consumed.has(config.scope)){
      throw readinessFixedError('NATIVE_OPERATION_ALREADY_CONSUMED');
    }
    const companionPins=captureReadinessCompanionPins(privateContext);
    const controller=new AbortController();
    const signal=abortSignal
      ?AbortSignal.any([abortSignal,controller.signal])
      :controller.signal;
    let previousNow=-1;
    const readinessNow=()=>{
      let value;
      try{value=Reflect.apply(capturedPorts.now,ports,[]);}
      catch{throw readinessFixedError('READINESS_EVIDENCE_BLOCKED');}
      if(!Number.isSafeInteger(value)||value<0||value<previousNow){
        throw readinessFixedError('READINESS_EVIDENCE_BLOCKED');
      }
      previousNow=value;
      return value;
    };
    const checkAbort=()=>{
      if(signal.aborted)throw readinessFixedError('OPERATION_ABORTED');
    };
    const awaitPreflight=async operation=>{
      checkAbort();
      const result=await operation();
      checkAbort();
      readinessNow();
      return result;
    };

    let captured=null,invocation=null;
    let preflightFailureCode='INVALID_READINESS_CONTEXT';
    try{
      readinessNow();
      const baseIdentities=[
        config.node,config.codex,config.prompt,
        ...Object.keys(config.source_pins).sort().map(path=>({
          path,...config.source_pins[path]
        }))
      ];
      preflightFailureCode='READINESS_EVIDENCE_BLOCKED';
      for(const identity of baseIdentities){
        checkAbort();
        await awaitPreflight(()=>Reflect.apply(
          capturedPorts.verifyFile,ports,
          [Object.freeze({...identity}),capturedPorts.reads]
        ));
      }
      for(const identity of companionPins){
        checkAbort();
        await awaitPreflight(()=>Reflect.apply(
          capturedPorts.verifyFile,ports,[identity,capturedPorts.reads]
        ));
      }

      const readinessModule=await awaitPreflight(
        ()=>import('../src/desktop-readiness-evidence.mjs')
      );
      captured=await awaitPreflight(()=>
        readinessModule.captureDesktopReadinessFromFilesWithPorts(
          privateConfig,privateContext,privateRoute,signal,{
            readBytes:capturedPorts.readBytes,
            reads:capturedPorts.reads
          }
        )
      );
      await awaitPreflight(()=>
        readinessModule.verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
          captured,signal,{
            fs:{
              realpath:capturedPorts.fs.realpath,
              lstat:capturedPorts.fs.lstat
            },
            verifyFile:capturedPorts.verifyFile,
            reads:capturedPorts.reads
          }
        )
      );
      await awaitPreflight(()=>
        readinessModule.verifyDesktopReadinessProbeArtifactsWithPorts(
          captured,signal,{
            fs:{
              lstat:capturedPorts.fs.lstat,
              realpath:capturedPorts.fs.realpath,
              open:capturedPorts.fs.open
            },
            uid:capturedPorts.uid
          }
        )
      );

      const receiptBytes=await awaitPreflight(()=>Reflect.apply(
        capturedPorts.readBytes,ports,
        [pureAdmission.preflight.evidence_receipt,65536]
      ));
      subscriptionBytes=copyReadinessInputBytes(receiptBytes,65536);
      validateCodexPreflight(
        parseReceiptJson(subscriptionBytes),config,privateConfig,readinessNow()
      );
      const suppliedPrompt=await awaitPreflight(()=>Reflect.apply(
        capturedPorts.readBytes,ports,[config.prompt.path,32768]
      ));
      promptBytes=copyReadinessInputBytes(suppliedPrompt,32768);
      invocation=buildDesktopCodingLargeObservationInvocation(config,promptBytes);
      checkAbort();

      readinessBindingSnapshotMatches(
        readinessModule,captured,privateConfig,privateContext,privateRoute,config
      );
      const previousBeforeFinalNow=previousNow;
      const finalNow=readinessNow();
      readinessModule.assertDesktopReadinessCurrent(
        captured,finalNow,previousBeforeFinalNow
      );
      checkAbort();
      if(consumed.has(config.job_id)||consumed.has(config.scope)){
        throw readinessFixedError('NATIVE_OPERATION_ALREADY_CONSUMED');
      }
      // CP1: the existing shared admission fence and this entrypoint's markers
      // are synchronous with no await between them.
      const admitted=requireDesktopCodingLargeObservationAdmission(
        privateAdmission,config,privateConfig
      );
      consumed.add(config.job_id);
      consumed.add(config.scope);
      consumedAtCP1=true;

      const retentionObject=await Reflect.apply(
        capturedPorts.retention,ports,[config.job_id]
      );
      const retentionPrepare=readinessBoundMethod(retentionObject,'prepare');
      const retainRejected=readinessBoundMethod(
        retentionObject,'retainRejected'
      );
      const gate=await retentionPrepare();
      if(gate.capability_status!=='READY'){
        throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
      }
      if(signal.aborted)throw Error('OPERATION_ABORTED');
      await capturedPorts.fs.mkdir(config.scope,{mode:0o700});

      const counts={generation:0};
      const result=await runDesktopCodingLargeObservationProjectTask(
        invocation.specification,
        {
          clock:capturedPorts.clock,
          shutdown:config.generation_shutdown,
          abortSignal:signal
        },
        {
          fs:capturedPorts.fs,uid:capturedPorts.uid,
          mode:invocation.mode,
          operation_intent:invocation.operation_intent,
          executable:invocation.executable,
          codex:invocation.codex,
          environment:capturedPorts.environment,
          retainRejected,
          spawn(executable,argv,options){
            if(signal.aborted||++counts.generation>1||
               executable!==invocation.executable||options.shell!==false){
              throw Error('PROJECT_SPAWN_LIMIT');
            }
            try{
              readinessBindingSnapshotMatches(
                readinessModule,captured,privateConfig,privateContext,
                privateRoute,config
              );
              const previous=previousNow;
              const current=readinessNow();
              readinessModule.assertDesktopReadinessCurrent(
                captured,current,previous
              );
              if(signal.aborted)throw Error('OPERATION_ABORTED');
            }catch{
              throw Error(signal.aborted
                ?'OPERATION_ABORTED':'READINESS_EVIDENCE_BLOCKED');
            }
            return Reflect.apply(capturedPorts.spawn,ports,[
              executable,argv,options
            ]);
          }
        }
      );
      if(result.schema!==PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA){
        throw Error('INVALID_LARGE_OBSERVATION_RESULT');
      }
      return Object.freeze({
        ...result,operator_admitted:true,
        operator_receipt:admitted.operator_receipt,
        direct_child_invocations:Object.freeze({...counts})
      });
    }catch(error){
      if(consumedAtCP1)throw error;
      if(signal.aborted)throw readinessFixedError('OPERATION_ABORTED');
      const code=readinessErrorCode(error);
      if(code)throw readinessFixedError(code);
      throw readinessFixedError(preflightFailureCode);
    }
  }catch(error){
    if(consumedAtCP1)throw error;
    const code=readinessErrorCode(error);
    if(code)throw readinessFixedError(code);
    throw readinessFixedError('INVALID_READINESS_CONTEXT');
  }finally{
    privateConfig?.fill(0);
    privateContext?.fill(0);
    privateRoute?.fill(0);
    promptBytes?.fill(0);
    subscriptionBytes?.fill(0);
  }
}

// The artifact API has its own closed context and source-pin envelope. It
// deliberately does not reuse the readiness-context parser above.
const ARTIFACT_COMPANION_PATHS=Object.freeze([
  'src/desktop-readiness-evidence.mjs',
  'src/project-artifact-check-evidence.mjs',
  'src/artifact-verifier.mjs',
  'src/job-record.mjs'
]);
const ARTIFACT_SHA256=/^[a-f0-9]{64}$/;
const ARTIFACT_UUID4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ARTIFACT_TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_CONTEXT_MAX=65536;
const ARTIFACT_ROUTE_MAX=16384;
const ARTIFACT_PIN_MAX=1048576;
const ARTIFACT_PIN_TOTAL_MAX=4194304;
const ARTIFACT_FS_KEYS=Object.freeze([
  'open','mkdir','lstat','chmod','readdir','realpath'
]);
const ARTIFACT_ABORTED_GETTER=Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,'aborted'
).get;
const ARTIFACT_ABORT_SIGNAL_PROTOTYPE=AbortSignal.prototype;
const ARTIFACT_CODES=new Set([
  'INVALID_ARTIFACT_CONTEXT','OPERATION_ABORTED'
]);

function artifactFixedError(code){
  const fixed=ARTIFACT_CODES.has(code)?code:'INVALID_ARTIFACT_CONTEXT';
  const error=new Error(fixed);
  error.code=fixed;
  return error;
}

function artifactCopyBytes(value,maxBytes){
  try{
    if(types.isProxy(value)||!types.isUint8Array(value)||
       Object.getPrototypeOf(value)!==Uint8Array.prototype)throw 0;
    const length=Reflect.apply(readinessByteLength,value,[]);
    if(!Number.isSafeInteger(length)||length<0||length>maxBytes)throw 0;
    const copy=new Uint8Array(length);
    Uint8Array.prototype.set.call(copy,value);
    return copy;
  }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
}

function artifactRecord(value,keys){
  try{closed(value,keys,[],'INVALID_ARTIFACT_CONTEXT');}
  catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
  const result=Object.create(null);
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    result[key]=descriptor.value;
  }
  return result;
}

function artifactArray(value,min,max){
  try{
    if(types.isProxy(value)||!Array.isArray(value)||
       Object.getPrototypeOf(value)!==Array.prototype)throw 0;
    const descriptor=Object.getOwnPropertyDescriptor(value,'length');
    const length=descriptor?.value;
    const keys=Reflect.ownKeys(value);
    if(!Number.isSafeInteger(length)||length<min||length>max||
       keys.length!==length+1)throw 0;
    const result=[];
    for(let index=0;index<length;index++){
      const item=Object.getOwnPropertyDescriptor(value,String(index));
      if(!item||!Object.hasOwn(item,'value'))throw 0;
      result.push(item.value);
    }
    for(const key of keys){
      if(key==='length')continue;
      if(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||
         Number(key)>=length)throw 0;
    }
    return result;
  }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
}

function artifactAbsolutePath(value){
  return typeof value==='string'&&value.length>0&&value.length<=512&&
    new TextEncoder().encode(value).length<=512&&value.startsWith('/')&&
    value!=='/'&&!value.includes('\\')&&
    !/[\u0000-\u001f\u007f]/u.test(value)&&resolve(value)===value&&
    value.slice(1).split('/').every(part=>
      part.length>0&&part!=='.'&&part!=='..'
    );
}

function artifactWithin(path,root){
  return path===root||path.startsWith(`${root}/`);
}

function artifactPin(value,maxBytes){
  const pin=artifactRecord(value,['path','bytes','sha256']);
  if(!artifactAbsolutePath(pin.path)||
     !Number.isSafeInteger(pin.bytes)||pin.bytes<1||
     pin.bytes>maxBytes||typeof pin.sha256!=='string'||
     !ARTIFACT_SHA256.test(pin.sha256)){
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }
  return Object.freeze(pin);
}

function artifactCompanionPins(value){
  const supplied=artifactRecord(value,ARTIFACT_COMPANION_PATHS);
  let total=0;
  return Object.freeze(ARTIFACT_COMPANION_PATHS.map(relative=>{
    const pin=artifactRecord(supplied[relative],['bytes','sha256']);
    if(!Number.isSafeInteger(pin.bytes)||pin.bytes<1||
       pin.bytes>ARTIFACT_PIN_MAX||
       typeof pin.sha256!=='string'||!ARTIFACT_SHA256.test(pin.sha256)){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    total+=pin.bytes;
    if(!Number.isSafeInteger(total)||total>ARTIFACT_PIN_TOTAL_MAX){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    return Object.freeze({
      path:join(PROJECT_SOURCE_ROOT,relative),
      bytes:pin.bytes,sha256:pin.sha256
    });
  }));
}

function artifactConfigPins(config){
  const pins=config.source_pins;
  const paths=Reflect.ownKeys(pins);
  if(paths.some(path=>typeof path!=='string')) {
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }
  paths.sort();
  return Object.freeze(paths.map(path=>{
    const descriptor=Object.getOwnPropertyDescriptor(pins,path);
    if(!descriptor||!Object.hasOwn(descriptor,'value')){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    const pin=artifactRecord(descriptor.value,['bytes','sha256']);
    if(!Number.isSafeInteger(pin.bytes)||pin.bytes<0||
       typeof pin.sha256!=='string'||!ARTIFACT_SHA256.test(pin.sha256)){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    return Object.freeze({path,bytes:pin.bytes,sha256:pin.sha256});
  }));
}

function validateArtifactContextEnvelope(contextBytes,config,configBytes){
  let context;
  try{
    context=snapshotReceiptData(parseReceiptJson(contextBytes));
  }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
  const value=artifactRecord(context,[
    'schema','operation_config_sha256','job_id','candidate','artifacts',
    'required_checks','observer_policy_sha256','companion_source_pins'
  ]);
  if(value.schema!=='squire.project_artifact_check_context.v2'||
     value.operation_config_sha256!==hash(configBytes)||
     value.job_id!==config.job_id||
     typeof value.observer_policy_sha256!=='string'||
     !ARTIFACT_SHA256.test(value.observer_policy_sha256)){
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }
  const candidate=artifactRecord(value.candidate,[
    'source_commit','stage_root','stage_operation_id','stage_manifest_sha256'
  ]);
  const expectedStage=join(
    config.scope,'output',`run-${config.job_id}`,'stage'
  );
  if(candidate.source_commit!==config.source_commit||
     candidate.stage_root!==expectedStage||
     candidate.stage_operation_id!==`stage-${config.job_id}`||
     !artifactAbsolutePath(candidate.stage_root)||
     typeof candidate.stage_manifest_sha256!=='string'||
     !ARTIFACT_SHA256.test(candidate.stage_manifest_sha256)){
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }

  const artifacts=artifactArray(value.artifacts,1,16);
  const ids=new Set(),locations=new Set(),byId=new Map();
  let total=0;
  const roots=[];
  for(const raw of artifacts){
    const item=artifactRecord(raw,[
      'artifact_id','role','root','relative_path','byte_count','sha256',
      'staged_artifact_id'
    ]);
    if(typeof item.artifact_id!=='string'||
       !ARTIFACT_TOKEN.test(item.artifact_id)||ids.has(item.artifact_id)||
       !['staged','delivered_copy'].includes(item.role)||
       !artifactAbsolutePath(item.root)||
       typeof item.relative_path!=='string'||
       !artifactPath(item.relative_path)||item.relative_path.length>256||
       new TextEncoder().encode(item.relative_path).length>256||
       item.relative_path.split('/').length>16||
       !Number.isSafeInteger(item.byte_count)||item.byte_count<1||
       item.byte_count>67108864||
       typeof item.sha256!=='string'||!ARTIFACT_SHA256.test(item.sha256)){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    if(item.role==='staged'){
      if(item.staged_artifact_id!==null||item.root!==candidate.stage_root){
        throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
      }
    }else if(typeof item.staged_artifact_id!=='string'||
             !ARTIFACT_TOKEN.test(item.staged_artifact_id)){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    total+=item.byte_count;
    if(!Number.isSafeInteger(total)||total>134217728){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    const location=`${item.root}\0${item.relative_path}`;
    if(locations.has(location))throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    ids.add(item.artifact_id);locations.add(location);
    byId.set(item.artifact_id,item);
    roots.push(item.root);
  }
  for(const item of artifacts){
    if(item.role!=='delivered_copy')continue;
    const source=byId.get(item.staged_artifact_id);
    if(!source||source.role!=='staged'||
       source.byte_count!==item.byte_count||source.sha256!==item.sha256||
       source.root===item.root&&source.relative_path===item.relative_path){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
  }

  const checks=artifactArray(value.required_checks,1,16);
  const checkIds=new Set();
  let definitionTotal=0;
  for(const raw of checks){
    const check=artifactRecord(raw,[
      'check_id','definition_pin','receipt_pin','observer_role','artifact_ids'
    ]);
    const artifactIds=artifactArray(check.artifact_ids,1,16);
    if(typeof check.check_id!=='string'||
       !ARTIFACT_TOKEN.test(check.check_id)||checkIds.has(check.check_id)||
       check.observer_role!=='trusted_owner_fixture'||
       artifactIds.some(id=>typeof id!=='string'||!ARTIFACT_TOKEN.test(id)||
         !ids.has(id))||
       artifactIds.some((id,index)=>index>0&&artifactIds[index-1]>=id)){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    const definition=artifactPin(check.definition_pin,ARTIFACT_PIN_MAX);
    artifactPin(check.receipt_pin,65536);
    definitionTotal+=definition.bytes;
    if(!Number.isSafeInteger(definitionTotal)||definitionTotal>16777216||
       roots.some(root=>artifactWithin(definition.path,root))||
       roots.some(root=>artifactWithin(check.receipt_pin.path,root))){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    checkIds.add(check.check_id);
  }
  return artifactCompanionPins(value.companion_source_pins);
}

function captureArtifactCheckPorts(value){
  const supplied=artifactRecord(value,[
    'fs','uid','readBytes','verifyFile','reads'
  ]);
  const fsReceiver=supplied.fs;
  const fsMethods=artifactRecord(fsReceiver,ARTIFACT_FS_KEYS);
  const readsReceiver=supplied.reads;
  const readMethods=artifactRecord(readsReceiver,['lstat','readChunks']);
  const methods=[
    ...ARTIFACT_FS_KEYS.map(key=>fsMethods[key]),
    supplied.readBytes,supplied.verifyFile,
    readMethods.lstat,readMethods.readChunks
  ];
  if(!Number.isSafeInteger(supplied.uid)||supplied.uid<0||
     methods.some(method=>typeof method!=='function'||types.isProxy(method))){
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }
  const forward=(method,receiver)=>(...args)=>
    Reflect.apply(method,receiver,args);
  const fs=Object.create(null);
  for(const key of ARTIFACT_FS_KEYS){
    fs[key]=forward(fsMethods[key],fsReceiver);
  }
  return Object.freeze({
    fs:Object.freeze(fs),uid:supplied.uid,
    readBytes:forward(supplied.readBytes,value),
    verifyFile:forward(supplied.verifyFile,value),
    reads:Object.freeze({
      lstat:forward(readMethods.lstat,readsReceiver),
      readChunks:forward(readMethods.readChunks,readsReceiver)
    })
  });
}

function artifactSignalState(signal){
  if(signal===undefined)return false;
  if(!signal||typeof signal!=='object'||types.isProxy(signal)){
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }
  let current=signal,found=false;
  while(current!==null){
    if(types.isProxy(current)){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    let descriptor,next;
    try{
      descriptor=Object.getOwnPropertyDescriptor(current,'aborted');
      next=Object.getPrototypeOf(current);
    }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
    if(current===signal&&descriptor){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    if(current===ARTIFACT_ABORT_SIGNAL_PROTOTYPE){
      if(!descriptor||!Object.hasOwn(descriptor,'get')||
         descriptor.get!==ARTIFACT_ABORTED_GETTER){
        throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
      }
      found=true;
    }else if(descriptor){
      throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
    }
    current=next;
  }
  if(!found)throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  try{
    const value=Reflect.apply(ARTIFACT_ABORTED_GETTER,signal,[]);
    if(typeof value!=='boolean')throw 0;
    return value;
  }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
}

function checkArtifactBootstrapAbort(signal){
  if(artifactSignalState(signal)){
    throw artifactFixedError('OPERATION_ABORTED');
  }
}

async function awaitArtifactBootstrap(operation,signal){
  checkArtifactBootstrapAbort(signal);
  let value;
  try{value=await operation();}
  catch{
    checkArtifactBootstrapAbort(signal);
    throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');
  }
  checkArtifactBootstrapAbort(signal);
  return value;
}

async function readNativeArtifactDirectory(path,signal){
  const names=[];
  let directory=null,failed=false,failure;
  try{
    checkArtifactBootstrapAbort(signal);
    directory=await fs.opendir(path,{bufferSize:1});
    checkArtifactBootstrapAbort(signal);
    while(true){
      checkArtifactBootstrapAbort(signal);
      const entry=await directory.read();
      checkArtifactBootstrapAbort(signal);
      if(entry===null)break;
      if(names.length===51)throw Error('ARTIFACT_DIRECTORY_LIMIT');
      names.push(entry.name);
    }
  }catch(error){
    failed=true;failure=error;
  }finally{
    if(directory!==null){
      try{await directory.close();}
      catch(error){if(!failed){failed=true;failure=error;}}
    }
  }
  checkArtifactBootstrapAbort(signal);
  if(failed)throw failure;
  return names;
}

function nativeArtifactCheckPorts(signal){
  const nativeFs=Object.freeze({
    open:fs.open,mkdir:fs.mkdir,lstat:fs.lstat,chmod:fs.chmod,
    readdir:path=>readNativeArtifactDirectory(path,signal),realpath:fs.realpath
  });
  return Object.freeze({
    fs:nativeFs,uid:process.getuid(),readBytes:readReceiptBytes,
    verifyFile:verifyExactFile,
    reads:Object.freeze({
      lstat:fs.lstat,readChunks:path=>createReadStream(path)
    })
  });
}

/** Fixed native, read-only artifact sidecar API; no generation admission. */
export async function verifyProjectArtifactChecks(
  configBytes,artifactContextBytes,abortSignal
){
  let ports;
  try{ports=nativeArtifactCheckPorts(abortSignal);}
  catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
  return verifyProjectArtifactChecksWithPorts(
    configBytes,artifactContextBytes,abortSignal,ports
  );
}

/** Explicit injected ArtifactPorts API; it still verifies the full source closure. */
export async function verifyProjectArtifactChecksWithPorts(
  configBytes,artifactContextBytes,abortSignal,ports
){
  let configCopy=null,contextCopy=null;
  try{
    configCopy=artifactCopyBytes(configBytes,ARTIFACT_CONTEXT_MAX);
    contextCopy=artifactCopyBytes(
      artifactContextBytes,ARTIFACT_CONTEXT_MAX
    );
    const capturedPorts=captureArtifactCheckPorts(ports);
    artifactSignalState(abortSignal);
    let config;
    try{
      config=validateDesktopCodingLargeObservationConfig(
        parseReceiptJson(configCopy)
      );
    }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
    const companionPins=validateArtifactContextEnvelope(
      contextCopy,config,configCopy
    );
    const sourcePins=artifactConfigPins(config);
    checkArtifactBootstrapAbort(abortSignal);

    // Verify every config pin on every call, even when the following literal
    // module import is already present in the ESM cache.
    for(const identity of [...sourcePins,...companionPins]){
      await awaitArtifactBootstrap(()=>Reflect.apply(
        capturedPorts.verifyFile,capturedPorts,[
          Object.freeze({...identity}),capturedPorts.reads
        ]
      ),abortSignal);
    }

    // No helper import, fallback or caller-selected loader occurs before the
    // complete source closure above has verified.
    const module=await awaitArtifactBootstrap(
      ()=>import('../src/project-artifact-check-evidence.mjs'),
      abortSignal
    );
    try{
      return await Reflect.apply(
        module.resolveProjectArtifactChecksWithPorts,module,[
          configCopy,contextCopy,abortSignal,capturedPorts
        ]
      );
    }catch{throw artifactFixedError('INVALID_ARTIFACT_CONTEXT');}
  }finally{
    configCopy?.fill(0);
    contextCopy?.fill(0);
  }
}

async function runLargeObservationDiagnostics(kind,configBytes,admission,abortSignal,ports){
  validateLargeDesktopPorts(ports);
  let phaseOrigin=null;
  if(kind==='PHASE'){
    try{
      const value=ports.clock.now();
      if(Number.isSafeInteger(value)&&value>=0)phaseOrigin=value;
    }catch{}
  }
  let config=null;
  try{
    receiptByteLength(configBytes);
    config=validateDesktopCodingLargeObservationConfig(parseReceiptJson(configBytes));
  }catch{}
  let module=null,observer=null;
  try{
    module=kind==='FAILURE'
      ?await loadProjectFailureDiagnostics()
      :await loadProjectPhaseDiagnostics();
    if(kind==='FAILURE')observer=module.createProjectFailureObserver();
    else observer=module.createProjectPhaseObserver(ports.clock,phaseOrigin);
  }catch{}
  let result,primaryFailed=false,primaryError,observation=null;
  try{
    result=await runProjectDesktopCodingLargeObservationWithPorts(
      configBytes,admission,abortSignal,{
        ...ports,
        spawn(executable,argv,options){
          if(kind==='PHASE')try{observer?.spawnAttempt();}catch{}
          const child=ports.spawn(executable,argv,options);
          try{observer?.observe(child);}catch{}
          return child;
        }
      }
    );
    if(kind==='PHASE')try{observer?.primaryResultReturned();}catch{}
  }catch(error){primaryFailed=true;primaryError=error;}
  finally{try{observation=observer?.seal()??null;}catch{}}
  if(primaryFailed)throw primaryError;
  if(kind==='FAILURE'){
    if(result.status==='CANDIDATE_STAGED'){
      return Object.freeze({result,failure_diagnostics:Object.freeze({status:'NOT_RETAINED_SUCCESS'})});
    }
    try{
      if(!module||!observer||!observation||!config)throw 0;
      const binding=module.createProjectFailureBinding(config,result);
      const evidence=module.createProjectFailureEvidence(binding,observation);
      return Object.freeze({result,failure_diagnostics:Object.freeze({
        status:'OBSERVED',evidence,sidecar_status:'NOT_REQUESTED'
      })});
    }catch{
      return Object.freeze({result,failure_diagnostics:Object.freeze({
        status:'UNAVAILABLE',reason:'OBSERVER_ERROR',sidecar_status:'NOT_REQUESTED'
      })});
    }
  }
  try{
    if(!module||!observer||!observation||!config||
       observation.observer_error==='OBSERVER_ERROR')throw 0;
    const binding=module.createProjectPhaseBinding(config,result);
    const evidence=module.createProjectPhaseEvidence(binding,observation);
    return Object.freeze({result,phase_diagnostics:Object.freeze({
      status:'OBSERVED',evidence,sidecar_status:'NOT_REQUESTED'
    })});
  }catch{
    return Object.freeze({result,phase_diagnostics:Object.freeze({
      status:'UNAVAILABLE',reason:'OBSERVER_ERROR',sidecar_status:'NOT_REQUESTED'
    })});
  }
}
export async function runProjectDesktopCodingLargeObservationWithFailureDiagnosticsWithPorts(configBytes,admission,abortSignal,ports){
  return runLargeObservationDiagnostics('FAILURE',configBytes,admission,abortSignal,ports);
}
export async function runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts(configBytes,admission,abortSignal,ports){
  return runLargeObservationDiagnostics('PHASE',configBytes,admission,abortSignal,ports);
}
export const projectEntrypointMode=args=>args.length===3&&args[0]==='--run-admitted'?'EXPLICIT_ADMISSION_REQUIRED':'DRY_RUN_NATIVE_DISABLED';
export const projectDryRun=()=>Object.freeze({schema:'SQUIRE2_PROJECT_DRY_RUN_V1',status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0,task_correctness:'NOT_EVALUATED',runtime_admitted:false});
export async function runProjectOneCaseNative(configBytes,admission,abortSignal){
  if(!admission)throw Error('UNADMITTED_NATIVE_OPERATION');
  const c=validateProjectCodexConfig(parseReceiptJson(configBytes)),a=requireProjectCodexAdmission(admission,c,configBytes);
  if(consumed.has(c.job_id)||consumed.has(c.scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');
  const reads={lstat:fs.lstat,readChunks:p=>createReadStream(p)};
  for(const identity of [c.node,c.codex,c.prompt,...Object.entries(c.source_pins).map(([path,pin])=>({path,...pin}))])await verifyExactFile(identity,reads);
  const proof=parseReceiptJson(await readReceiptBytes(a.preflight.evidence_receipt,65536));validateCodexPreflight(proof,c,configBytes,Date.now());
  const prompt_bytes=await readReceiptBytes(c.prompt.path,32768);if(hash(prompt_bytes)!==c.prompt.sha256||prompt_bytes.length!==c.prompt.bytes)throw Error('PROMPT_CHANGED');
  consumed.add(c.job_id);consumed.add(c.scope);
  const retention=createNativeRejectedRetention(c.job_id),gate=await retention.prepare();if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  const clock=createMonotonicClock(),controller=new AbortController(),signal=abortSignal?AbortSignal.any([abortSignal,controller.signal]):controller.signal;
  const cancel=clock.schedule(c.outer_observation_ms,()=>controller.abort());
  const counts={generation:0};
  const launch=kind=>(exe,argv,opts)=>{if(signal.aborted||++counts[kind]>1||counts.generation>1)throw Error('PROJECT_SPAWN_LIMIT');return spawn(exe,argv,opts);};
  try{
    await fs.mkdir(c.scope,{mode:0o700});
    const result=await runProjectCodexTask({job_id:c.job_id,task_scope:c.scope,requested_model:c.requested_model,effort:c.effort,max_wall_clock_sec:120,prompt_bytes},
      {clock,shutdown:c.generation_shutdown,abortSignal:signal},
      {fs,spawn:launch('generation'),executable:c.codex.path,codex:{observed_cli_version:c.codex.version,authorization:c.authorization,permissions:c.permissions},environment:process.env,retainRejected:retention.retainRejected,uid:process.getuid()});
    return Object.freeze({...result,operator_admitted:true,operator_receipt:a.operator_receipt,direct_child_invocations:Object.freeze({...counts}),outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'});
  }finally{cancel();}
}
const receiptFlag='--run-admitted-save-receipt';
function receiptMethod(target,key){
  if(!target||typeof target!=='object'||types.isProxy(target))throw 0;
  for(let current=target;current!==null;current=Object.getPrototypeOf(current)){
    if(types.isProxy(current))throw 0;
    const descriptor=Object.getOwnPropertyDescriptor(current,key);
    if(!descriptor)continue;
    if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function'||types.isProxy(descriptor.value))throw 0;
    return (...args)=>Reflect.apply(descriptor.value,target,args);
  }
  throw 0;
}
function receiptFunction(value){
  if(typeof value!=='function'||types.isProxy(value))throw 0;
}
function receiptByteLength(bytes){
  if(!types.isUint8Array(bytes)||types.isProxy(bytes))throw 0;
  const length=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get.call(bytes);
  if(length>65536)throw 0;
  return length;
}
function receiptArgs(value){
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype)throw 0;
  const length=Object.getOwnPropertyDescriptor(value,'length').value;
  if(length>64||Reflect.ownKeys(value).length!==length+1)throw 0;
  const args=[];
  for(let index=0;index<length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string'||descriptor.value.includes('\0'))throw 0;
    args.push(descriptor.value);
  }
  return args;
}
function receiptPorts(ports){
  closed(ports,['readBytes','runProject','verifyFile','reads','writerPorts','stdout','stderr'],[],'receipt_ports');
  for(const key of ['readBytes','runProject','verifyFile'])receiptFunction(ports[key]);
  closed(ports.reads,['lstat','readChunks'],[],'receipt_reads');
  for(const key of ['lstat','readChunks'])receiptFunction(ports.reads[key]);
  closed(ports.writerPorts,['fs','uid'],[],'receipt_writer_ports');
  closed(ports.writerPorts.fs,['lstat','open'],[],'receipt_fs');
  for(const key of ['lstat','open'])receiptFunction(ports.writerPorts.fs[key]);
  if(!Number.isSafeInteger(ports.writerPorts.uid)||ports.writerPorts.uid<0)throw 0;
  closed(ports.stdout,['write'],[],'receipt_stdout');
  closed(ports.stderr,['write'],[],'receipt_stderr');
  receiptFunction(ports.stdout.write);receiptFunction(ports.stderr.write);
}
async function receiptParent(destination,ports){
  const stat=await ports.fs.lstat(destination.directory),view={};
  if(!stat||typeof stat!=='object'||types.isProxy(stat))throw 0;
  for(const key of ['dev','ino','uid','nlink','mode','size','mtimeMs','ctimeMs']){
    const descriptor=Object.getOwnPropertyDescriptor(stat,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))throw 0;
    view[key]=descriptor.value;
  }
  for(const key of ['dev','ino','uid','nlink','mode','size'])if(!Number.isSafeInteger(view[key])||view[key]<0)throw 0;
  if(!Number.isFinite(view.mtimeMs)||!Number.isFinite(view.ctimeMs))throw 0;
  const file=receiptMethod(stat,'isFile')(),directory=receiptMethod(stat,'isDirectory')(),symlink=receiptMethod(stat,'isSymbolicLink')();
  if(![file,directory,symlink].every(value=>typeof value==='boolean')||
     !directory||symlink||view.uid!==ports.uid||(view.mode&0o7777)!==0o700)throw 0;
}
// All capabilities are explicit and trusted. The result writer is deliberately fixed.
export async function runProjectEntrypointCli(argv,ports){
  let out,err,args;
  try{
    object(ports,'receipt_ports');
    const stdout=Object.getOwnPropertyDescriptor(ports,'stdout'),stderr=Object.getOwnPropertyDescriptor(ports,'stderr');
    if(!stdout||!stderr||!Object.hasOwn(stdout,'value')||!Object.hasOwn(stderr,'value'))throw 0;
    out=receiptMethod(stdout.value,'write');err=receiptMethod(stderr.value,'write');
    args=receiptArgs(argv);
  }catch{if(err)err('PROJECT_RECEIPT_REQUEST_INVALID\n');return 2;}
  if(args[0]===desktopCodingLargeObservationFlag){
    try{
      if(desktopCodingLargeObservationEntrypointMode(args)!==
           'EXPLICIT_DESKTOP_CODING_LARGE_OBSERVATION_ADMISSION_REQUIRED'||
         args.slice(1).some(value=>value.length===0))throw 0;
      receiptFunction(ports.readBytes);
      const configBytes=await ports.readBytes(args[1],65536);
      const admissionBytes=await ports.readBytes(args[2],65536);
      receiptByteLength(configBytes);receiptByteLength(admissionBytes);
      const config=validateDesktopCodingLargeObservationConfig(
        parseReceiptJson(configBytes)
      );
      const admission=validateDesktopCodingLargeObservationAdmission(
        parseReceiptJson(admissionBytes),configBytes
      );
      const result=await runProjectDesktopCodingLargeObservationWithPorts(
        configBytes,admission,undefined,ports.desktopCodingLargeObservationPorts
      );
      const profile=validateProjectOutputLargeProfile(result.output_profile);
      const stage=result.staging;
      validateProjectCodingObservationProfile(result.execution_profile);
      if(result.schema!==PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA||
         result.status!=='CANDIDATE_STAGED'||
         result.task_correctness!=='NOT_EVALUATED'||
         result.task_outcome_evaluated!==false||result.runtime_admitted!==false||
         result.operator_admitted!==true||
         result.direct_child_invocations?.generation!==1||
         result.post_generation_closeout?.status!=='COMPLETE'||
         result.post_generation_closeout?.limit_ms!==20000||
         !stage||stage.schema_version!=='squire4.large_project_stage_receipt.v1'||
         validateProjectOutputLargeProfile(stage.output_profile)!==profile||
         stage.stage_operation_id!==`stage-${config.job_id}`||
         stage.caller_label!=='project_candidate_stager'||
         stage.completion_status!=='COMPLETE'||
         stage.operation_acknowledgement!=='ACKNOWLEDGED'||
         !/^[a-f0-9]{64}$/.test(stage.manifest_sha256)||
         !Number.isSafeInteger(stage.file_count)||stage.file_count<1||
         stage.file_count>profile.max_all_files||
         !Number.isSafeInteger(stage.total_bytes)||stage.total_bytes<0||
         stage.total_bytes>profile.max_decoded_project_bytes||
         stage.provenance_authenticity!=='NOT_ESTABLISHED'||
         stage.crash_durability!=='NOT_ESTABLISHED')throw 0;
      out('{"schema":"SQUIRE2_DESKTOP_CODING_LARGE_OBSERVATION_ACK_V1","status":"CANDIDATE_STAGED","task_correctness":"NOT_EVALUATED","native_app_status":"NOT_QUALIFIED"}\n');
      return 1;
    }catch{
      err('DESKTOP_CODING_LARGE_OBSERVATION_ADMISSION_OR_OPERATION_FAILED\n');
      return 2;
    }
  }
  if(args[0]===desktopCodegenFlag){
    try{
      if(desktopCodegenEntrypointMode(args)!=='EXPLICIT_DESKTOP_CODEGEN_ADMISSION_REQUIRED'||
         args.slice(1).some(value=>value.length===0))throw 0;
      receiptFunction(ports.readBytes);
      const configBytes=await ports.readBytes(args[1],65536);
      const admissionBytes=await ports.readBytes(args[2],65536);
      receiptByteLength(configBytes);receiptByteLength(admissionBytes);
      const result=await runProjectDesktopCodegenWithPorts(
        configBytes,parseReceiptJson(admissionBytes),undefined,ports.desktopCodegenPorts);
      if(result.status!=='CANDIDATE_STAGED'||result.task_correctness!=='NOT_EVALUATED'||
         result.task_outcome_evaluated!==false||result.runtime_admitted!==false||
         result.staging?.operation_acknowledgement!=='ACKNOWLEDGED')throw 0;
      if(result.schema===PROJECT_CODING_OBSERVATION_RESULT_SCHEMA){
        out('{"schema":"SQUIRE2_DESKTOP_CODING_OBSERVATION_ACK_V1","status":"CANDIDATE_STAGED","task_correctness":"NOT_EVALUATED","native_app_status":"NOT_QUALIFIED"}\n');
      }else{
        out('{"schema":"SQUIRE2_DESKTOP_CODEGEN_ACK_V1","status":"CANDIDATE_STAGED","task_correctness":"NOT_EVALUATED","native_app_status":"NOT_QUALIFIED"}\n');
      }
      return 1;
    }catch{err('DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED\n');return 2;}
  }
  const save=args[0]===receiptFlag;
  if(!save){
    if(projectEntrypointMode(args)!=='EXPLICIT_ADMISSION_REQUIRED'){
      out(`${JSON.stringify(projectDryRun())}\n`);return 0;
    }
    try{
      const config=await ports.readBytes(args[1],65536),admission=parseReceiptJson(await ports.readBytes(args[2],65536));
      const result=await ports.runProject(config,admission);
      out(`${JSON.stringify(result)}\n`);return result.status==='CANDIDATE_STAGED'?0:1;
    }catch{err('PROJECT_ADMISSION_OR_OPERATION_FAILED\n');return 2;}
  }
  let configBytes,admission,descriptor;
  try{
    if(args.length!==5||args.slice(1,4).some(value=>value.length===0)||!/^[a-f0-9]{64}$/.test(args[4]))throw 0;
    receiptPorts(ports);
    configBytes=await ports.readBytes(args[1],65536);receiptByteLength(configBytes);
    const admissionBytes=await ports.readBytes(args[2],65536);receiptByteLength(admissionBytes);
    const descriptorBytes=await ports.readBytes(args[3],65536);receiptByteLength(descriptorBytes);
    if(hash(descriptorBytes)!==args[4])throw 0;
    admission=parseReceiptJson(admissionBytes);
    descriptor=validateProjectReceiptDestination(parseReceiptJson(descriptorBytes),configBytes,admission);
    for(const [path,pin]of Object.entries(descriptor.source_pins))await ports.verifyFile({path,...pin},ports.reads);
    await receiptParent(descriptor.destination,ports.writerPorts);
  }catch{err('PROJECT_RECEIPT_REQUEST_INVALID\n');return 2;}
  let result;
  try{result=await ports.runProject(configBytes,admission);}
  catch{err('PROJECT_ADMISSION_OR_OPERATION_FAILED\n');return 2;}
  try{
    const acknowledgement=await writeNativeProjectResultReceipt(result,descriptor.destination,ports.writerPorts);
    out(`${JSON.stringify(acknowledgement)}\n`);return 1;
  }catch{err('PROJECT_RECEIPT_WRITE_FAILED\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  if(args[0]===receiptFlag||args[0]===desktopCodegenFlag||
     args[0]===desktopCodingLargeObservationFlag){
    process.exitCode=await runProjectEntrypointCli(args,{
      readBytes:readReceiptBytes,runProject:runProjectOneCaseNative,verifyFile:verifyExactFile,
      reads:{lstat:fs.lstat,readChunks:p=>createReadStream(p)},
      writerPorts:{fs:{lstat:fs.lstat,open:fs.open},uid:process.getuid()},
      ...(args[0]===desktopCodegenFlag?{desktopCodegenPorts:nativeDesktopCodegenPorts()}:{}),
      ...(args[0]===desktopCodingLargeObservationFlag
        ?{desktopCodingLargeObservationPorts:nativeDesktopCodegenPorts()}:{}),
      stdout:{write:value=>process.stdout.write(value)},stderr:{write:value=>process.stderr.write(value)}
    });
  }
  else if(projectEntrypointMode(args)!=='EXPLICIT_ADMISSION_REQUIRED')console.log(JSON.stringify(projectDryRun()));
  else try{
    const config=await readReceiptBytes(args[1],65536),admission=parseReceiptJson(await readReceiptBytes(args[2],65536));
    const result=await runProjectOneCaseNative(config,admission);console.log(JSON.stringify(result));if(result.status!=='CANDIDATE_STAGED')process.exitCode=1;
  }catch{console.error('PROJECT_ADMISSION_OR_OPERATION_FAILED');process.exitCode=2;}
}
