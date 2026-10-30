// Native activation requires exact separate admission; import/default/dry run are inert.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
import {readReceiptBytes} from '../bin/squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {validateCodexPreflight,verifyExactFile,hash} from '../src/bounded-codegen-plan.mjs';
import {validateProjectCodexConfig,requireProjectCodexAdmission,validateProjectReceiptDestination,validateDesktopCodegenConfig,requireDesktopCodegenAdmission,DESKTOP_CODEGEN_INTENT} from '../src/project-configuration.mjs';
import {closed,object} from '../src/job-spec.mjs';
import {writeNativeProjectResultReceipt} from '../src/project-result-receipt.mjs';
import {runProjectCodexTask,admitDesktopCodegenProjectTask} from '../src/project-runner.mjs';
import {createMonotonicClock} from '../src/node-process-port.mjs';
import {createNativeRejectedRetention} from '../src/local-rejected-retention.mjs';
const consumed=new Set();
const desktopCodegenFlag='--run-admitted-desktop-codegen';
export const desktopCodegenEntrypointMode=args=>args.length===3&&args[0]===desktopCodegenFlag?'EXPLICIT_DESKTOP_CODEGEN_ADMISSION_REQUIRED':'DRY_RUN_NATIVE_DISABLED';

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
    effort:c.effort,max_wall_clock_sec:120,prompt_bytes:bytes,
    runtime_target:c.runtime_target,prefix_identity:c.prefix_identity,
    desktop_runtime_identity:c.desktop_runtime_identity
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
  const a=requireDesktopCodegenAdmission(admission,c,configBytes);
  if(consumed.has(c.job_id)||consumed.has(c.scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');
  for(const identity of [c.node,c.codex,c.prompt,...Object.entries(c.source_pins).map(([path,pin])=>({path,...pin}))]){
    await ports.verifyFile(identity,ports.reads);
  }
  const proofBytes=await ports.readBytes(a.preflight.evidence_receipt,65536);
  receiptByteLength(proofBytes);
  validateCodexPreflight(parseReceiptJson(proofBytes),c,configBytes,ports.now());
  const promptBytes=await ports.readBytes(c.prompt.path,32768);
  const invocation=buildDesktopCodegenInvocation(c,promptBytes);
  consumed.add(c.job_id);consumed.add(c.scope);
  const retention=ports.retention(c.job_id),gate=await retention.prepare();
  if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  const controller=new AbortController();
  const signal=abortSignal?AbortSignal.any([abortSignal,controller.signal]):controller.signal;
  const counts={generation:0};
  const cancel=ports.clock.schedule(c.outer_observation_ms,()=>controller.abort());
  if(typeof cancel!=='function')throw Error('SCHEDULER_UNAVAILABLE');
  try{
    if(signal.aborted)throw Error('OPERATION_ABORTED');
    await ports.fs.mkdir(c.scope,{mode:0o700});
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
      out('{"schema":"SQUIRE2_DESKTOP_CODEGEN_ACK_V1","status":"CANDIDATE_STAGED","task_correctness":"NOT_EVALUATED","native_app_status":"NOT_QUALIFIED"}\n');
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
  if(args[0]===receiptFlag||args[0]===desktopCodegenFlag){
    process.exitCode=await runProjectEntrypointCli(args,{
      readBytes:readReceiptBytes,runProject:runProjectOneCaseNative,verifyFile:verifyExactFile,
      reads:{lstat:fs.lstat,readChunks:p=>createReadStream(p)},
      writerPorts:{fs:{lstat:fs.lstat,open:fs.open},uid:process.getuid()},
      ...(args[0]===desktopCodegenFlag?{desktopCodegenPorts:nativeDesktopCodegenPorts()}:{}),
      stdout:{write:value=>process.stdout.write(value)},stderr:{write:value=>process.stderr.write(value)}
    });
  }
  else if(projectEntrypointMode(args)!=='EXPLICIT_ADMISSION_REQUIRED')console.log(JSON.stringify(projectDryRun()));
  else try{
    const config=await readReceiptBytes(args[1],65536),admission=parseReceiptJson(await readReceiptBytes(args[2],65536));
    const result=await runProjectOneCaseNative(config,admission);console.log(JSON.stringify(result));if(result.status!=='CANDIDATE_STAGED')process.exitCode=1;
  }catch{console.error('PROJECT_ADMISSION_OR_OPERATION_FAILED');process.exitCode=2;}
}
