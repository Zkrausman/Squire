import {createNativeRejectedRetention} from '../src/local-rejected-retention.mjs';
// Additive explicit entrypoint. Import/default/dry run launch nothing and write nothing.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createMonotonicClock} from '../src/node-process-port.mjs';
import {admitBoundedCodegenCodexTask,runBoundedCodegenCodexTask} from '../src/limited-runner.mjs';
import {executeGeneratedSummarizer,executeGeneratedSyntax} from '../src/limited-generated-executor.mjs';
import {validateGeneratedSourcePayload} from '../src/limited-stream-collector.mjs';
import {NODE_RUNTIME,FIXTURE_FREEZE_SHA256,GENERATION_SHUTDOWN,verifyExactFile,hash,canonicalBytes,requireCodexAdmission,validateCodexPreflight} from '../src/bounded-codegen-plan.mjs';
import {SOURCE_FILES,validateCodexOperationConfig} from '../src/bounded-codegen-configuration.mjs';
import {runCodegenCampaign} from '../src/bounded-codegen-campaign.mjs';
const consumed=new Set();
const nativeReads={lstat:fs.lstat,readChunks:path=>createReadStream(path)};
export const entrypointMode=args=>args.length===3&&args[0]==='--run-admitted'?'EXPLICIT_ADMISSION_REQUIRED':'DRY_RUN_NATIVE_DISABLED';
async function regularBytes(path,max){const st=await fs.lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('REGULAR_BOUNDED_FILE_REQUIRED');const chunks=[];let count=0;for await(const chunk of createReadStream(path)){count+=chunk.length;if(count>max)throw Error('REGULAR_BOUNDED_FILE_REQUIRED');chunks.push(chunk);}
 return Buffer.concat(chunks,count);}
async function absent(path){try{await fs.lstat(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
export function boundCodexConfig(c,spec){
 validateCodexOperationConfig(c);
 if(c.scope!==spec.task_scope||c.job_id!==spec.job_id||c.requested_model!==spec.requested_model||c.effort!==spec.effort||c.prompt.sha256!==hash(spec.prompt_bytes)||c.prompt.bytes!==spec.prompt_bytes.length)throw Error('FROZEN_CODEX_CONFIG_MISMATCH');
}
export async function runBoundedCodegenOneCaseNativeCodex(specification,runtimeOptions,admissionBundle){
 // Absent admission rejects before even reading a config or touching a native port.
 if(!admissionBundle)throw Error('UNADMITTED_NATIVE_OPERATION');
 const configBytes=new Uint8Array(runtimeOptions.config_bytes),config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(configBytes));
 const admitted=requireCodexAdmission(admissionBundle,config,configBytes),spec=admitBoundedCodegenCodexTask(specification);boundCodexConfig(config,spec);
 if(consumed.has(spec.job_id)||consumed.has(spec.task_scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');
 const sourceRoot=dirname(dirname(fileURLToPath(import.meta.url)));
 const required=SOURCE_FILES.map(name=>join(sourceRoot,name)).sort();
 if(JSON.stringify(Object.keys(config.source_pins).sort())!==JSON.stringify(required))throw Error('SOURCE_FREEZE_REQUIRED');
 for(const [path,pin] of Object.entries(config.source_pins))await verifyExactFile({path,bytes:pin.bytes,sha256:pin.sha256},nativeReads);
 await verifyExactFile(NODE_RUNTIME,nativeReads);await verifyExactFile(config.codex,nativeReads);
 await verifyExactFile(config.prompt,nativeReads);await verifyExactFile(config.fixtures,nativeReads);
 const proofBytes=await regularBytes(admitted.preflight.evidence_receipt,65536),proof=JSON.parse(new TextDecoder().decode(proofBytes));
 validateCodexPreflight(proof,config,configBytes,Date.now());
 const fixtures=JSON.parse(new TextDecoder().decode(await regularBytes(config.fixtures.path,65536))).fixtures;
 if(fixtures.length!==17)throw Error('FINITE_FIXTURE_MATRIX');
 consumed.add(spec.job_id);consumed.add(spec.task_scope);
 const retention=createNativeRejectedRetention(spec.job_id),captureGate=await retention.prepare();
 if(captureGate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
 const clock=createMonotonicClock(),controller=new AbortController();
 const signal=runtimeOptions.abortSignal?AbortSignal.any([controller.signal,runtimeOptions.abortSignal]):controller.signal;
 const cancelOuter=clock.schedule(config.outer_observation_ms,()=>controller.abort());
 const run=join(spec.task_scope,'output','run-'+spec.job_id),sourcePath=join(run,'workspace','src','summarizer.mjs');
 const nativeCounts={generation:0,syntax:0,fixtures:0};let resultSourceHash=null,resultSourceBytes=null;
 const launch=kind=>(exe,argv,opts)=>{
   if(signal.aborted)throw Error('OPERATION_CANCELED');
   nativeCounts[kind]++;const total=Object.values(nativeCounts).reduce((a,b)=>a+b,0);
   if(total>19||nativeCounts.generation>1||nativeCounts.syntax>1||nativeCounts.fixtures>17)throw Error('SPAWN_LIMIT');
   return spawn(exe,argv,opts);
 };
 try{
  await fs.mkdir(spec.task_scope,{mode:0o700}); // no recursive creation; EEXIST consumes this attempt
  const inspectSource=async witness=>{
    if(!witness||witness.source_path!==sourcePath)throw Error('SOURCE_WITNESS_REQUIRED');
    const bytes=await regularBytes(sourcePath,65536),format=validateGeneratedSourcePayload(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
    if(hash(bytes)!==witness.source_sha256||bytes.length!==witness.source_byte_count)throw Error('SOURCE_CHANGED');
    resultSourceHash??=format.source_sha256;resultSourceBytes??=bytes.length;
    return Object.freeze({source_path:sourcePath,source_sha256:format.source_sha256,source_byte_count:bytes.length,
      inspection:'ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY',safety:'NOT_ESTABLISHED'});
  };
  const cfg=(id,timeout_ms=5000,deadline_ms)=>({...config.fixture_configs[id-1],timeout_ms,...(deadline_ms===undefined?{}:{deadline_ms})});
  const result=await runCodegenCampaign({fixtures},{clock,abortSignal:signal,
    generate:()=>runBoundedCodegenCodexTask(spec,{clock,shutdown:config.generation_shutdown,output_path:sourcePath,abortSignal:signal,enableDiagnosticRetention:true},{spawn:launch('generation'),fs,retainRejected:retention.retainRejected,executable:config.codex.path,codex:{observed_cli_version:config.codex.version,authorization:config.authorization,permissions:config.permissions}}),
    inspectSource,
    syntax:async()=>{await fs.mkdir(join(run,'.tmp'),{mode:0o700});return executeGeneratedSyntax(cfg(1),{clock,spawn:launch('syntax'),abortSignal:signal});},
    prepareFixture:async(f,index)=>{
      if(signal.aborted)throw Error('CANCELED');const d=join(run,'runs',`fixture-${index}`);
      if(index===1)await fs.mkdir(join(run,'runs'),{mode:0o700});await fs.mkdir(d,{mode:0o700});
      const binding=config.fixture_configs[index-1];
      if(f.input_sha256!==null){
        const bytes=await regularBytes(config.fixture_inputs[index-1],5242881);
        if(hash(bytes)!==f.input_sha256||bytes.length!==f.input_bytes)throw Error('FIXTURE_INPUT_CHANGED');
        await fs.writeFile(binding.input_path,bytes,{flag:'wx',mode:0o400});
      }
    },
    execute:(f,index,budget,deadline)=>executeGeneratedSummarizer(cfg(index,budget,deadline),{clock,spawn:launch('fixtures'),abortSignal:signal}),
    observeFixture:async(f,index,execution)=>{
      const binding=config.fixture_configs[index-1];
      await inspectSource({source_path:sourcePath,source_sha256:resultSourceHash,source_byte_count:resultSourceBytes});
      if(f.input_sha256!==null&&hash(await regularBytes(binding.input_path,5242881))!==f.input_sha256)throw Error('INPUT_MODIFIED');
      if(index===17)return {execution}; // literal /proc paths are not probed/remapped by the coordinator
      if(f.expected_exit_code!==0)return {execution,summary_absent:await absent(binding.output_path),manifest_absent:await absent(binding.manifest_path)};
      return {execution,summary_bytes:await regularBytes(binding.output_path,65536),manifest_bytes:await regularBytes(binding.manifest_path,65536)};
    }
  });
  return Object.freeze({...result,direct_child_invocations:Object.freeze({...nativeCounts}),outer_observation_target_ms:250000,
    event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',operator_receipt:admitted.operator_receipt,operator_admitted:true});
 }finally{cancelOuter();}
}

export const runBoundedCodegenOneCaseNative=runBoundedCodegenOneCaseNativeCodex;

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);
 if(entrypointMode(args)!=='EXPLICIT_ADMISSION_REQUIRED')console.log(JSON.stringify({status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0}));
 else {
  const config_bytes=await fs.readFile(args[1]),c=JSON.parse(new TextDecoder().decode(config_bytes));
  const admission=JSON.parse(await fs.readFile(args[2],'utf8'));requireCodexAdmission(admission,c,config_bytes);
  const prompt_bytes=await regularBytes(c.prompt.path,32768);
  const result=await runBoundedCodegenOneCaseNativeCodex({job_id:c.job_id,task_scope:c.scope,requested_model:c.requested_model,effort:c.effort,max_wall_clock_sec:120,prompt_bytes},{config_bytes},admission);
  console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;
 }
}
