// Native activation requires exact separate admission; import/default/dry run are inert.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from '../bin/squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {validateCodexPreflight,verifyExactFile,hash} from '../src/bounded-codegen-plan.mjs';
import {validateSingleJsCodexConfig,requireSingleJsCodexAdmission} from '../src/single-js-configuration.mjs';
import {runSingleJsCodexTask,executeSingleJsSyntax} from '../src/single-js-runner.mjs';
import {createMonotonicClock} from '../src/node-process-port.mjs';
import {createNativeRejectedRetention} from '../src/local-rejected-retention.mjs';
const consumed=new Set();
export const singleJsEntrypointMode=args=>args.length===3&&args[0]==='--run-admitted'?'EXPLICIT_ADMISSION_REQUIRED':'DRY_RUN_NATIVE_DISABLED';
export const singleJsDryRun=()=>Object.freeze({schema:'SQUIRE2_SINGLE_JS_DRY_RUN_V1',status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0,task_correctness:'NOT_EVALUATED',runtime_admitted:false});
export async function runSingleJsOneCaseNative(configBytes,admission,abortSignal){
  if(!admission)throw Error('UNADMITTED_NATIVE_OPERATION');
  const c=validateSingleJsCodexConfig(parseReceiptJson(configBytes)),a=requireSingleJsCodexAdmission(admission,c,configBytes);
  if(consumed.has(c.job_id)||consumed.has(c.scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');
  const reads={lstat:fs.lstat,readChunks:p=>createReadStream(p)};
  for(const identity of [c.node,c.codex,c.prompt,...Object.entries(c.source_pins).map(([path,pin])=>({path,...pin}))])await verifyExactFile(identity,reads);
  const proof=parseReceiptJson(await readReceiptBytes(a.preflight.evidence_receipt,65536));validateCodexPreflight(proof,c,configBytes,Date.now());
  const prompt_bytes=await readReceiptBytes(c.prompt.path,32768);if(hash(prompt_bytes)!==c.prompt.sha256||prompt_bytes.length!==c.prompt.bytes)throw Error('PROMPT_CHANGED');
  consumed.add(c.job_id);consumed.add(c.scope);
  const retention=createNativeRejectedRetention(c.job_id),gate=await retention.prepare();if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  const clock=createMonotonicClock(),controller=new AbortController(),signal=abortSignal?AbortSignal.any([abortSignal,controller.signal]):controller.signal;
  const cancel=clock.schedule(c.outer_observation_ms,()=>controller.abort());
  const counts={generation:0,syntax:0};
  const launch=kind=>(exe,argv,opts)=>{if(signal.aborted||++counts[kind]>1||counts.generation+counts.syntax>2)throw Error('SINGLE_JS_SPAWN_LIMIT');return spawn(exe,argv,opts);};
  try{
    await fs.mkdir(c.scope,{mode:0o700});
    const result=await runSingleJsCodexTask({job_id:c.job_id,task_scope:c.scope,requested_model:c.requested_model,effort:c.effort,max_wall_clock_sec:120,prompt_bytes},
      {clock,shutdown:c.generation_shutdown,abortSignal:signal},
      {fs,spawn:launch('generation'),executable:c.codex.path,codex:{observed_cli_version:c.codex.version,authorization:c.authorization,permissions:c.permissions},environment:process.env,retainRejected:retention.retainRejected,syntax:(path,ports)=>executeSingleJsSyntax(path,{...ports,spawn:launch('syntax')})});
    return Object.freeze({...result,operator_admitted:true,operator_receipt:a.operator_receipt,direct_child_invocations:Object.freeze({...counts}),outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'});
  }finally{cancel();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  if(singleJsEntrypointMode(args)!=='EXPLICIT_ADMISSION_REQUIRED')console.log(JSON.stringify(singleJsDryRun()));
  else try{
    const config=await readReceiptBytes(args[1],65536),admission=parseReceiptJson(await readReceiptBytes(args[2],65536));
    const result=await runSingleJsOneCaseNative(config,admission);console.log(JSON.stringify(result));if(result.status!=='CANDIDATE_READY')process.exitCode=1;
  }catch{console.error('SINGLE_JS_ADMISSION_OR_OPERATION_FAILED');process.exitCode=2;}
}
