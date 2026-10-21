// One generation and syntax-only verification through explicit ports; no native defaults.
import {join,resolve} from 'node:path';
import {closed,fail} from './job-spec.mjs';
import {prepareCodexArgv,validateCodexPrompt,codexEnvironment} from './codex-profile.mjs';
import {createCodexCodegenStreamCollector,validateGeneratedSourcePayload} from './limited-stream-collector.mjs';
import {stageSingleJsGeneratedSource} from './limited-source-staging.mjs';
import {runForeground} from './internal/limited-core.mjs';
import {executeSingleJsSyntax} from './limited-generated-executor.mjs';
import {GENERATION_SHUTDOWN,hash,canonicalBytes} from './bounded-codegen-plan.mjs';
import {SINGLE_JS_PREFIX_IDENTITY} from './single-js-task.mjs';
export {executeSingleJsSyntax};
export {requireSingleJsCodexAdmission} from './single-js-configuration.mjs';
const usedJobs=new Set(),usedScopes=new Set();
export function admitSingleJsCodexTask(s){
  closed(s,['job_id','task_scope','requested_model','effort','max_wall_clock_sec','prompt_bytes'],[],'single_js_spec');
  if(typeof s.job_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s.job_id)||typeof s.task_scope!=='string'||!s.task_scope.startsWith('/')||resolve(s.task_scope)!==s.task_scope||s.task_scope==='/'||s.task_scope.includes('\0')||typeof s.requested_model!=='string'||typeof s.effort!=='string'||s.max_wall_clock_sec!==120||!validateCodexPrompt(s.prompt_bytes).valid)fail('single_js_spec');
  const prompt_bytes=new Uint8Array(s.prompt_bytes);
  if(prompt_bytes.length<887||hash(prompt_bytes.subarray(0,SINGLE_JS_PREFIX_IDENTITY.bytes))!==SINGLE_JS_PREFIX_IDENTITY.sha256)fail('single_js_prompt_binding');
  return Object.freeze({...s,prompt_bytes});
}
export async function runSingleJsCodexTask(specification,options,ports){
  const spec=admitSingleJsCodexTask(specification);
  closed(options,['clock','shutdown','abortSignal'],[],'single_js_options');closed(options.clock,['now','schedule'],[],'single_js_clock');
  if(typeof options.clock.now!=='function'||typeof options.clock.schedule!=='function'||!(options.abortSignal instanceof AbortSignal)||hash(canonicalBytes(options.shutdown))!==hash(canonicalBytes(GENERATION_SHUTDOWN)))fail('single_js_options');
  if(!ports||typeof ports.spawn!=='function'||!ports.fs||typeof ports.syntax!=='function'||typeof ports.executable!=='string'||!ports.executable.startsWith('/'))fail('single_js_ports');
  const profile=prepareCodexArgv({...ports.codex,requested_model:spec.requested_model,effort:spec.effort,prompt_bytes:spec.prompt_bytes});
  if(usedJobs.has(spec.job_id)||usedScopes.has(spec.task_scope))fail('single_js_nonreuse');usedJobs.add(spec.job_id);usedScopes.add(spec.task_scope);
  const run=join(spec.task_scope,'output','run-'+spec.job_id),target=join(run,'workspace','src','task.mjs');
  const fs=ports.fs;let generation=null,syntax=null,source=null;
  const finish=(status,reason)=>Object.freeze({schema:'SQUIRE2_SINGLE_JS_RESULT_V1',status,reason,generation,syntax,source,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,workspace_disposition:status==='CANDIDATE_READY'?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE'});
  try{
    if(options.abortSignal.aborted)return finish('INCOMPLETE','CANCELED');
    const st=await fs.lstat(spec.task_scope);if(!st.isDirectory()||st.isSymbolicLink())throw Error('SCOPE_REQUIRED');
    await fs.mkdir(join(spec.task_scope,'output'),{mode:0o700});await fs.mkdir(run,{mode:0o700});await fs.mkdir(join(spec.task_scope,'.tmp'),{mode:0o700});
    let witness=null;
    generation=await runForeground({...spec,provider_id:'native_codex',task_class:'SINGLE_JS_CODEGEN_V1'},
      {executable:ports.executable,args:profile.argv,stdin_bytes:spec.prompt_bytes},
      {clock:options.clock,shutdown:options.shutdown,abortSignal:options.abortSignal,output_path:target,enableDiagnosticRetention:true},
      {clock:options.clock,spawn:ports.spawn,environment:codexEnvironment(spec.task_scope,ports.environment??{}),createCollector:createCodexCodegenStreamCollector,retainRejected:ports.retainRejected,persist:async(bytes,signal)=>{witness=await stageSingleJsGeneratedSource({run_root:run,source_bytes:bytes,signal},{fs,clock:options.clock});}});
    generation=Object.freeze({...generation,physical_source_witness:generation.record.output_custody.persisted?witness:null,runtime_admitted:false});
    if(generation.record.lifecycle_status!=='LIMITED_SUCCESS')return finish(['LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(generation.record.lifecycle_status)?'INCOMPLETE':'GENERATION_REJECTED','GENERATION_REJECTED');
    async function inspect(){
      const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('SOURCE_CHANGED');
      const bytes=await fs.readFile(target);if(bytes.length!==witness.source_byte_count||hash(bytes)!==witness.source_sha256)throw Error('SOURCE_CHANGED');
      validateGeneratedSourcePayload(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
      return Object.freeze({source_path:target,source_sha256:witness.source_sha256,source_byte_count:witness.source_byte_count,inspection:'ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY',safety:'NOT_ESTABLISHED'});
    }
    source=await inspect();if(options.abortSignal.aborted)return finish('INCOMPLETE','CANCELED');
    await fs.mkdir(join(run,'.tmp'),{mode:0o700});const observed=await ports.syntax(target,{clock:options.clock,abortSignal:options.abortSignal});
    syntax=Object.freeze({execution:observed,wrapper_status:'UNKNOWN',observation:Object.freeze({syntax_status:'UNESTABLISHED_NO_NATIVE_PARSER',syntax_valid:null})});
    await inspect();if(options.abortSignal.aborted)return finish('INCOMPLETE','CANCELED');
    const e=observed;
    if(e.status!=='OBSERVED_EXIT'||e.observed_termination!==true||e.observed_exit_code!==0||e.observed_exit_signal!==null||e.io_state?.io_drained!==true||e.io_state.stdout_bytes_observed!==0||e.io_state.stderr_bytes_observed!==0||e.settlement_status!=='SETTLED_DIRECT_CHILD_EXIT')return finish('SYNTAX_REJECTED','SYNTAX_PROCESS_REJECTED');
    syntax=Object.freeze({execution:observed,wrapper_status:'ACCEPTED',observation:Object.freeze({syntax_status:'SYNTAX_VALID',syntax_valid:true})});return finish('CANDIDATE_READY',null);
  }catch{return finish(options.abortSignal.aborted?'INCOMPLETE':'FAILED',options.abortSignal.aborted?'CANCELED':'OPERATION_FAILED_OR_UNCERTAIN');}
}
