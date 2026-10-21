// One explicitly injected generation followed by local staging. Never runs files.
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {closed,fail} from './job-spec.mjs';
import {prepareCodexArgv,validateCodexPrompt,codexEnvironment} from './codex-profile.mjs';
import {PROJECT_PREFIX_IDENTITY,validateProjectPayloadJson} from './project-task.mjs';
import {DESKTOP_TARGET,DESKTOP_PREFIX_IDENTITY,validateDesktopRuntimeIdentity} from './desktop-profile.mjs';
import {createCodexProjectStreamCollector} from './project-stream-collector.mjs';
import {planStaging,writeStage,safeMultifileErrorCode} from './multifile-staging.mjs';
import {runForeground} from './internal/limited-core.mjs';
import {GENERATION_SHUTDOWN,canonicalBytes,hash} from './bounded-codegen-plan.mjs';
const usedJobs=new Set(),usedScopes=new Set();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const absolute=v=>typeof v==='string'&&v!=='/'&&v.startsWith('/')&&resolve(v)===v&&!v.includes('\0');
export function admitProjectCodexTask(s){closed(s,['job_id','task_scope','requested_model','effort','max_wall_clock_sec','prompt_bytes'],['runtime_target','desktop_runtime_identity'],'project_spec');if(!uuid(s.job_id)||!absolute(s.task_scope)||typeof s.requested_model!=='string'||typeof s.effort!=='string'||s.max_wall_clock_sec!==120||!validateCodexPrompt(s.prompt_bytes).valid)fail('project_spec');const target=Object.hasOwn(s,'runtime_target')?s.runtime_target:'node24-esm';if(!['node24-esm',DESKTOP_TARGET].includes(target))fail('project_spec');const prefix=target===DESKTOP_TARGET?DESKTOP_PREFIX_IDENTITY:PROJECT_PREFIX_IDENTITY;let desktop;if(target===DESKTOP_TARGET)desktop=validateDesktopRuntimeIdentity(s.desktop_runtime_identity);else if(Object.hasOwn(s,'desktop_runtime_identity'))fail('project_spec');const b=new Uint8Array(s.prompt_bytes);if(b.length<prefix.bytes+1||hash(b.subarray(0,prefix.bytes))!==prefix.sha256)fail('project_prompt_binding');return Object.freeze({...s,...(desktop?{desktop_runtime_identity:desktop}:{}),prompt_bytes:b});}
const clearFiles=payload=>{for(const f of payload?.files??[])f.content.fill(0);};
async function persistEnvelope(fs,path,input,signal){
 const bytes=new Uint8Array(input);let handle,payload,back;
 const check=()=>{if(signal.aborted)throw Error('PERSISTENCE_ABORTED');};
 try{
  check();payload=validateProjectPayloadJson(bytes);handle=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);check();await handle.writeFile(bytes);check();await handle.close();handle=null;check();
  const before=await fs.lstat(path);check();if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==bytes.length||(before.mode&0o777)!==0o600)throw Error('ENVELOPE_CHANGED');
  handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);check();const opened=await handle.stat();check();if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error('ENVELOPE_CHANGED');
  back=new Uint8Array(bytes.length+1);let offset=0;
  while(offset<back.length){const n=Math.min(4096,back.length-offset),r=await handle.read(back,offset,n,offset);check();if(!Number.isSafeInteger(r.bytesRead)||r.bytesRead<0||r.bytesRead>n)throw Error('ENVELOPE_CHANGED');if(!r.bytesRead)break;offset+=r.bytesRead;}
  const after=await handle.stat();check();if(offset!==bytes.length||hash(back.subarray(0,offset))!==hash(bytes)||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw Error('ENVELOPE_CHANGED');back.fill(0);
  await handle.close();handle=null;check();await fs.chmod(path,0o400);check();const leaf=await fs.lstat(path);check();if(!leaf.isFile()||leaf.isSymbolicLink()||leaf.ino!==opened.ino||leaf.dev!==opened.dev||leaf.nlink!==1||(leaf.mode&0o777)!==0o400)throw Error('ENVELOPE_CHANGED');
  const result=payload;payload=null;return result;
 }finally{try{if(handle)await handle.close();}finally{bytes.fill(0);back?.fill(0);clearFiles(payload);}}
}
export async function runProjectCodexTask(specification,options,ports){
 const spec=admitProjectCodexTask(specification);if(spec.runtime_target===DESKTOP_TARGET&&(ports?.mode!=='SOURCE_SIMULATION'||ports.executable===spec.desktop_runtime_identity.executable.path))fail('desktop_source_only');closed(options,['clock','shutdown','abortSignal'],[],'project_options');closed(options.clock,['now','schedule'],[],'project_clock');
 if(typeof options.clock.now!=='function'||typeof options.clock.schedule!=='function'||!(options.abortSignal instanceof AbortSignal)||hash(canonicalBytes(options.shutdown))!==hash(canonicalBytes(GENERATION_SHUTDOWN)))fail('project_options');
 if(!ports||typeof ports.spawn!=='function'||!ports.fs||!Number.isSafeInteger(ports.uid)||ports.uid<0||!absolute(ports.executable))fail('project_ports');
 const profile=prepareCodexArgv({...ports.codex,requested_model:spec.requested_model,effort:spec.effort,prompt_bytes:spec.prompt_bytes}),operatorReceipt=ports.codex.authorization.operator_receipt;
 if(usedJobs.has(spec.job_id)||usedScopes.has(spec.task_scope))fail('project_nonreuse');usedJobs.add(spec.job_id);usedScopes.add(spec.task_scope);
 const run=join(spec.task_scope,'output','run-'+spec.job_id),envelopePath=join(run,'candidate-envelope.json'),fs=ports.fs,controller=new AbortController();
 let generation=null,staging=null,payload=null,spawns=0,cancel=null,last=-1,deadline=null,expired=false,finished=false;
 const now=()=>{const n=options.clock.now();if(!Number.isSafeInteger(n)||n<0||n<last)throw Error('CLOCK_UNAVAILABLE');last=n;return n;};
 const abort=()=>controller.abort();options.abortSignal.addEventListener('abort',abort,{once:true});
 const finish=(status,reason)=>{finished=true;try{if(typeof cancel==='function')cancel();}catch{status='FAILED';reason='CLEANUP_FAILED_OR_UNCERTAIN';}cancel=null;
  if(status==='CANDIDATE_STAGED')try{if(now()>=deadline){expired=true;controller.abort();}}catch{status='FAILED';reason='CLOCK_UNAVAILABLE';}
  if(controller.signal.aborted&&status!=='FAILED'){status='INCOMPLETE';reason=expired?'OBSERVATION_DEADLINE':'CANCELED';}
  return Object.freeze({schema:'SQUIRE2_PROJECT_RESULT_V1',status,reason,generation,staging,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,workspace_disposition:status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE',operator_admitted:false,operator_receipt:operatorReceipt,direct_child_invocations:Object.freeze({generation:spawns}),outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'});};
 try{
  if(options.abortSignal.aborted)return finish('INCOMPLETE','CANCELED');deadline=now()+140000;let returned=false,inline=false;
  cancel=options.clock.schedule(140000,()=>{if(finished)return;if(!returned){inline=true;return;}expired=true;controller.abort();});returned=true;if(typeof cancel!=='function'||inline)throw Error('SCHEDULER_UNAVAILABLE');
  const check=()=>{if(now()>=deadline){expired=true;controller.abort();}if(controller.signal.aborted)throw Error('OPERATION_ABORTED');};check();
  const st=await fs.lstat(spec.task_scope);check();if(!st.isDirectory()||st.isSymbolicLink())throw Error('SCOPE_REQUIRED');
  await fs.mkdir(join(spec.task_scope,'output'),{mode:0o700});check();await fs.mkdir(run,{mode:0o700});check();await fs.mkdir(join(spec.task_scope,'.tmp'),{mode:0o700});check();
  generation=await runForeground({...spec,provider_id:'native_codex',task_class:'PROJECT_CODEGEN_V1'},{executable:ports.executable,args:profile.argv,stdin_bytes:spec.prompt_bytes},
   {clock:options.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:controller.signal,output_path:envelopePath,enableDiagnosticRetention:true},
   {clock:options.clock,spawn(...args){if(controller.signal.aborted||++spawns>1)throw Error('PROJECT_SPAWN_LIMIT');return ports.spawn(...args);},environment:codexEnvironment(spec.task_scope,ports.environment??{}),createCollector:createCodexProjectStreamCollector,retainRejected:ports.retainRejected,persist:async(bytes,signal)=>{const p=await persistEnvelope(fs,envelopePath,bytes,signal);if(finished||controller.signal.aborted){clearFiles(p);throw Error('PERSISTENCE_ABORTED');}payload=p;}});
  if(generation.record.lifecycle_status!=='LIMITED_SUCCESS')return finish(['LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(generation.record.lifecycle_status)?'INCOMPLETE':'GENERATION_REJECTED','GENERATION_REJECTED');check();
  if(!payload)throw Error('PROJECT_PAYLOAD_UNAVAILABLE');const plan=planStaging({stage_operation_id:'stage-'+spec.job_id,caller_label:'project_candidate_stager',files:payload.files.map(f=>({path:f.path,classification:f.classification,content:f.content}))});clearFiles(payload);payload=null;
  let onAbort;const abortPromise=new Promise((_,reject)=>{onAbort=()=>reject(Error('STAGE_ABORTED'));controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();});abortPromise.catch(()=>{});
  const operation=Promise.resolve().then(()=>{check();return writeStage(plan,join(run,'stage'),{fs,uid:ports.uid,signal:controller.signal});});
  operation.then(()=>{for(const f of plan.files)f.content.fill(0);},()=>{for(const f of plan.files)f.content.fill(0);});
  try{const ack=await Promise.race([operation,abortPromise]);check();const expected={schema_version:'squire4.stage_receipt.v1',stage_operation_id:plan.stage_operation_id,caller_label:plan.caller_label,completion_status:'COMPLETE',manifest_sha256:plan.manifest_sha256,file_count:plan.file_count,total_bytes:plan.total_bytes,operation_acknowledgement:'ACKNOWLEDGED',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'};
   if(hash(canonicalBytes(ack))!==hash(canonicalBytes(expected)))throw Error('INVALID_STAGE_RECEIPT');staging=ack;return finish('CANDIDATE_STAGED',null);
  }catch(e){staging=null;if(controller.signal.aborted)return finish('INCOMPLETE',expired?'OBSERVATION_DEADLINE':'CANCELED');return finish('STAGING_REJECTED','STAGING:'+safeMultifileErrorCode(e));}finally{controller.signal.removeEventListener('abort',onAbort);}
 }catch{return finish(controller.signal.aborted?'INCOMPLETE':'FAILED',controller.signal.aborted?(expired?'OBSERVATION_DEADLINE':'CANCELED'):'OPERATION_FAILED_OR_UNCERTAIN');}
 finally{finished=true;clearFiles(payload);options.abortSignal.removeEventListener('abort',abort);try{if(typeof cancel==='function')cancel();}catch{}}
}
