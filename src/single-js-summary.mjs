// Versioned generic projection: candidate readiness is never functional task PASS.
import {closed} from './job-spec.mjs';
import {LIMITED_STATUSES} from './limited-job-record.mjs';
import {snapshotReceiptData,projectSingleJsEvidence,validateProjectedEvidence} from './offline-run-summary.mjs';
import {diagnosticReport} from './internal/limited-diagnostics.mjs';
const reasonsByStatus=new Map([
  ['CANDIDATE_READY',[null]],
  ['GENERATION_REJECTED',['GENERATION_REJECTED']],
  ['SYNTAX_REJECTED',['SYNTAX_PROCESS_REJECTED']],
  ['INCOMPLETE',['CANCELED','GENERATION_REJECTED']],
  ['FAILED',['OPERATION_FAILED_OR_UNCERTAIN']]
]);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
function syntaxProcessAccepted(execution){
  return execution.status==='OBSERVED_EXIT'&&execution.observed_termination&&
    execution.observed_exit_code===0&&execution.observed_exit_signal===null&&
    execution.io_state.io_drained&&execution.io_state.stdout_bytes_observed===0&&
    execution.io_state.stderr_bytes_observed===0&&execution.settlement_status==='SETTLED_DIRECT_CHILD_EXIT';
}
export function projectSingleJsRunSummary(value){
  try{
    const r=snapshotReceiptData(value);
    if(r.schema==='SQUIRE2_SINGLE_JS_DRY_RUN_V1'){
      closed(r,['schema','status','direct_child_invocations','task_correctness','runtime_admitted'],[],'single_js_dry_run');
      if(r.status!=='DRY_RUN_NATIVE_DISABLED'||r.direct_child_invocations!==0||r.task_correctness!=='NOT_EVALUATED'||r.runtime_admitted!==false)throw 0;
      return freeze({schema_version:'squire2.single_js_summary.v1',readiness:'NOT_RUN',task_correctness:'NOT_EVALUATED',generation:null,syntax:null,artifact:null,admission_claimed:false,has_operator_receipt:false,runtime_admitted_marker:false,diagnostic:null,descendant_guarantee:'NONE'});
    }
    const native=Object.hasOwn(r,'operator_admitted');
    closed(r,['schema','status','reason','generation','syntax','source','task_correctness','task_outcome_evaluated','runtime_admitted','workspace_disposition','descendant_guarantee',...(native?['operator_admitted','operator_receipt','direct_child_invocations','outer_observation_target_ms','event_loop_condition']:[])],[],'single_js_result');
    if(r.schema!=='SQUIRE2_SINGLE_JS_RESULT_V1'||!reasonsByStatus.get(r.status)?.includes(r.reason)||r.task_correctness!=='NOT_EVALUATED'||r.task_outcome_evaluated!==false||r.runtime_admitted!==false||r.descendant_guarantee!=='NONE')throw 0;
    const candidateReady=r.status==='CANDIDATE_READY';
    if(r.workspace_disposition!==(candidateReady?'DEDICATED_NOT_REUSED':'QUARANTINED'))throw 0;
    if(native){closed(r.direct_child_invocations,['generation','syntax'],[],'single_js_counts');if(typeof r.operator_admitted!=='boolean'||typeof r.operator_receipt!=='string'||r.outer_observation_target_ms!==140000||r.event_loop_condition!=='RESPONSIVE_PARENT_EVENT_LOOP'||Object.values(r.direct_child_invocations).some(v=>!Number.isSafeInteger(v)||v<0||v>1))throw 0;}
    const e=projectSingleJsEvidence({generation:r.generation,syntax:r.syntax,source:r.source});
    if(r.generation===null&&(r.syntax!==null||r.source!==null)||r.syntax!==null&&(e.generation.lifecycle_status!=='LIMITED_SUCCESS'||r.source===null))throw 0;
    if(r.status==='GENERATION_REJECTED'){
      if(r.generation===null||r.source!==null||r.syntax!==null||
        ['LIMITED_SUCCESS','LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(e.generation.lifecycle_status))throw 0;
    }
    if(r.status==='SYNTAX_REJECTED'){
      if(r.syntax===null||e.syntax.wrapper_status!=='UNKNOWN'||e.syntax.syntax_valid!==null||
        syntaxProcessAccepted(r.syntax.execution))throw 0;
    }
    if(candidateReady&&(e.generation.lifecycle_status!=='LIMITED_SUCCESS'||e.syntax.wrapper_status!=='ACCEPTED'||e.syntax.syntax_valid!==true||!e.artifact.witness_present))throw 0;
    if(native&&(r.direct_child_invocations.generation<(r.generation===null?0:1)||r.direct_child_invocations.syntax<(r.syntax===null?0:1)))throw 0;
    return freeze({schema_version:'squire2.single_js_summary.v1',readiness:r.status,task_correctness:'NOT_EVALUATED',...e,admission_claimed:native?r.operator_admitted:false,has_operator_receipt:native&&r.operator_receipt.length>0,runtime_admitted_marker:false,descendant_guarantee:'NONE'});
  }catch{return freeze({schema_version:'squire2.single_js_summary.v1',readiness:'INVALID_RECEIPT',task_correctness:'NOT_EVALUATED',diagnostic:{stage:'RECEIPT_VALIDATION',reason:'SCHEMA_MISMATCH'}});}
}
function validateSingleJsReadiness(summary){
  const {readiness,generation,syntax,artifact,diagnostic}=summary;
  if(readiness==='NOT_RUN'){
    if(generation!==null||syntax!==null||artifact!==null||diagnostic!==null||
       summary.admission_claimed||summary.has_operator_receipt)throw 0;
    return;
  }
  if(!reasonsByStatus.has(readiness)||!generation||!syntax||!artifact||!diagnostic)throw 0;
  validateProjectedEvidence({generation,syntax,artifact,diagnostic});

  const lifecycle=generation.lifecycle_status;
  if(lifecycle==='NOT_RUN'){
    if(diagnostic.stage!==null||diagnostic.reason!==null)throw 0;
    if(Object.entries(generation).some(([key,value])=>key!=='lifecycle_status'&&value!==null))throw 0;
  }else if(!LIMITED_STATUSES.includes(lifecycle)||generation.task_outcome_evaluated_marker!==false||
           (lifecycle==='LIMITED_SUCCESS'&&generation.provider_status!=='turn.completed'))throw 0;

  if(artifact.witness_present){
    if(lifecycle==='NOT_RUN'||artifact.sha256===null||artifact.byte_count===null||
       artifact.format_inspection!=='ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY'||artifact.safety_evidence!=='NOT_ESTABLISHED')throw 0;
  }else if(Object.entries(artifact).some(([key,value])=>key!=='witness_present'&&value!==null))throw 0;
  if(syntax.wrapper_status==='NOT_RUN'){
    if(syntax.observed_exit_code!==null||syntax.syntax_valid!==null)throw 0;
  }else if(lifecycle!=='LIMITED_SUCCESS'||!artifact.witness_present)throw 0;
  if(syntax.wrapper_status==='ACCEPTED'&&(syntax.syntax_valid!==true||syntax.observed_exit_code!==0))throw 0;

  if(readiness==='CANDIDATE_READY'&&syntax.wrapper_status!=='ACCEPTED')throw 0;
  if(readiness==='GENERATION_REJECTED'&&(['NOT_RUN','LIMITED_SUCCESS','LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(lifecycle)||
     syntax.wrapper_status!=='NOT_RUN'||artifact.witness_present))throw 0;
  // Exit zero alone cannot rule out rejection: process output and settlement are not projected.
  if(readiness==='SYNTAX_REJECTED'&&(syntax.wrapper_status!=='UNKNOWN'||syntax.syntax_valid!==null))throw 0;
}
export function formatSingleJsSummaryTerminal(summary){
  try{
  summary=snapshotReceiptData(summary);
  if(summary?.readiness==='INVALID_RECEIPT')return 'Squire single-JavaScript receipt: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
  closed(summary,['schema_version','readiness','task_correctness','generation','syntax','artifact','diagnostic','admission_claimed','has_operator_receipt','runtime_admitted_marker','descendant_guarantee'],[],'single_js_summary');
  if(summary.schema_version!=='squire2.single_js_summary.v1'||summary.task_correctness!=='NOT_EVALUATED'||summary.runtime_admitted_marker!==false||summary.descendant_guarantee!=='NONE')throw 0;
  if(typeof summary.admission_claimed!=='boolean'||typeof summary.has_operator_receipt!=='boolean')throw 0;
  validateSingleJsReadiness(summary);
  const readiness=summary.readiness;
  const model=v=>v==='gpt-6-luna'?'gpt-6-luna':'UNKNOWN',num=v=>Number.isSafeInteger(v)&&v>=0?String(v):'UNKNOWN';
  const g=summary?.generation,s=summary?.syntax,a=summary?.artifact;
  const diagnostic=summary.diagnostic===null||summary.diagnostic.reason===null?'NONE':diagnosticReport(summary.diagnostic?.stage,summary.diagnostic?.reason).reason;
  return [`Squire single-JavaScript receipt: ${readiness}`,'Task correctness: NOT_EVALUATED (no functional oracle or fixture PASS).','Recorded claims only; no artifact, authorization or execution re-verification.',`Generation: ${['LIMITED_SUCCESS','LIMITED_PROCESS_FAILED','LIMITED_TIMEOUT','LIMITED_USER_ABORT','LIMITED_CAPACITY_EXCEEDED','LIMITED_PARSER_ERROR','LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR','NOT_RUN'].includes(g?.lifecycle_status)?g.lifecycle_status:'UNKNOWN'}`,`Requested model: ${model(g?.requested_model)}; reported model: ${model(g?.reported_model)}`,`Process wall ms: ${num(g?.process_wall_ms)}; provider duration seconds: ${typeof g?.provider_duration_sec==='number'&&Number.isFinite(g.provider_duration_sec)&&g.provider_duration_sec>=0?g.provider_duration_sec:'UNKNOWN'}; inference seconds: UNKNOWN`,`Tokens: ${['input','output','cache_read','thinking','total','codex_reasoning'].map(k=>`${k}=${num(g?.tokens?.[k])}`).join(', ')}`,`Syntax: ${['ACCEPTED','UNKNOWN','NOT_RUN'].includes(s?.wrapper_status)?s.wrapper_status:'UNKNOWN'}`,`Artifact: ${typeof a?.sha256==='string'&&/^[a-f0-9]{64}$/.test(a.sha256)?a.sha256:'UNKNOWN'}; bytes: ${num(a?.byte_count)}`,`Diagnostic: ${diagnostic}`,'Limits: direct child only; descendant guarantee NONE; no hostile containment, crash recovery or workspace reuse proof.'].join('\n')+'\n';
  }catch{return 'Squire single-JavaScript receipt: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';}
}
