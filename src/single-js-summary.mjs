// Versioned generic projection: candidate readiness is never functional task PASS.
import {closed} from './job-spec.mjs';
import {snapshotReceiptData,projectSingleJsEvidence,validateProjectedEvidence} from './offline-run-summary.mjs';
import {diagnosticReport} from './internal/limited-diagnostics.mjs';
const statuses=['CANDIDATE_READY','GENERATION_REJECTED','SYNTAX_REJECTED','INCOMPLETE','FAILED'];
const reasons=[null,'GENERATION_REJECTED','SYNTAX_PROCESS_REJECTED','CANCELED','OPERATION_FAILED_OR_UNCERTAIN'];
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
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
    if(r.schema!=='SQUIRE2_SINGLE_JS_RESULT_V1'||!statuses.includes(r.status)||!reasons.includes(r.reason)||r.task_correctness!=='NOT_EVALUATED'||r.task_outcome_evaluated!==false||r.runtime_admitted!==false||r.descendant_guarantee!=='NONE'||!['DEDICATED_NOT_REUSED','QUARANTINED'].includes(r.workspace_disposition))throw 0;
    if(native){closed(r.direct_child_invocations,['generation','syntax'],[],'single_js_counts');if(typeof r.operator_admitted!=='boolean'||typeof r.operator_receipt!=='string'||r.outer_observation_target_ms!==140000||r.event_loop_condition!=='RESPONSIVE_PARENT_EVENT_LOOP'||Object.values(r.direct_child_invocations).some(v=>!Number.isSafeInteger(v)||v<0||v>1))throw 0;}
    const e=projectSingleJsEvidence({generation:r.generation,syntax:r.syntax,source:r.source});
    if(r.generation===null&&(r.syntax!==null||r.source!==null)||r.syntax!==null&&(e.generation.lifecycle_status!=='LIMITED_SUCCESS'||r.source===null))throw 0;
    if(r.status==='CANDIDATE_READY'&&(r.reason!==null||e.generation.lifecycle_status!=='LIMITED_SUCCESS'||e.syntax.wrapper_status!=='ACCEPTED'||e.syntax.syntax_valid!==true||!e.artifact.witness_present||r.workspace_disposition!=='DEDICATED_NOT_REUSED'))throw 0;
    if(r.status!=='CANDIDATE_READY'&&r.reason===null)throw 0;
    if(native&&(r.direct_child_invocations.generation<(r.generation===null?0:1)||r.direct_child_invocations.syntax<(r.syntax===null?0:1)))throw 0;
    return freeze({schema_version:'squire2.single_js_summary.v1',readiness:r.status,task_correctness:'NOT_EVALUATED',...e,admission_claimed:native?r.operator_admitted:false,has_operator_receipt:native&&r.operator_receipt.length>0,runtime_admitted_marker:false,descendant_guarantee:'NONE'});
  }catch{return freeze({schema_version:'squire2.single_js_summary.v1',readiness:'INVALID_RECEIPT',task_correctness:'NOT_EVALUATED',diagnostic:{stage:'RECEIPT_VALIDATION',reason:'SCHEMA_MISMATCH'}});}
}
export function formatSingleJsSummaryTerminal(summary){
  try{
  summary=snapshotReceiptData(summary);
  if(summary?.readiness==='INVALID_RECEIPT')return 'Squire single-JavaScript receipt: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
  closed(summary,['schema_version','readiness','task_correctness','generation','syntax','artifact','diagnostic','admission_claimed','has_operator_receipt','runtime_admitted_marker','descendant_guarantee'],[],'single_js_summary');
  if(summary.schema_version!=='squire2.single_js_summary.v1'||summary.task_correctness!=='NOT_EVALUATED'||summary.runtime_admitted_marker!==false||summary.descendant_guarantee!=='NONE')throw 0;
  validateProjectedEvidence({generation:summary.generation,syntax:summary.syntax,artifact:summary.artifact,diagnostic:summary.diagnostic??{stage:null,reason:null}});
  if(typeof summary.admission_claimed!=='boolean'||typeof summary.has_operator_receipt!=='boolean')throw 0;
  if(summary.readiness==='CANDIDATE_READY'&&(summary.generation?.lifecycle_status!=='LIMITED_SUCCESS'||summary.generation.task_outcome_evaluated_marker!==false||summary.generation.provider_status!=='turn.completed'||summary.syntax?.wrapper_status!=='ACCEPTED'||summary.syntax.syntax_valid!==true||summary.syntax.observed_exit_code!==0||summary.artifact?.witness_present!==true||typeof summary.artifact.sha256!=='string'||summary.artifact.byte_count===null))throw 0;
  if(![...statuses,'NOT_RUN'].includes(summary.readiness))throw 0;
  const readiness=['CANDIDATE_READY','GENERATION_REJECTED','SYNTAX_REJECTED','INCOMPLETE','FAILED','NOT_RUN','INVALID_RECEIPT'].includes(summary?.readiness)?summary.readiness:'INVALID_RECEIPT';
  const model=v=>v==='gpt-6-luna'?'gpt-6-luna':'UNKNOWN',num=v=>Number.isSafeInteger(v)&&v>=0?String(v):'UNKNOWN';
  const g=summary?.generation,s=summary?.syntax,a=summary?.artifact;
  const diagnostic=summary.diagnostic?.reason===null?'NONE':diagnosticReport(summary.diagnostic?.stage,summary.diagnostic?.reason).reason;
  return [`Squire single-JavaScript receipt: ${readiness}`,'Task correctness: NOT_EVALUATED (no functional oracle or fixture PASS).','Recorded claims only; no artifact, authorization or execution re-verification.',`Generation: ${['LIMITED_SUCCESS','LIMITED_PROCESS_FAILED','LIMITED_TIMEOUT','LIMITED_USER_ABORT','LIMITED_CAPACITY_EXCEEDED','LIMITED_PARSER_ERROR','LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR','NOT_RUN'].includes(g?.lifecycle_status)?g.lifecycle_status:'UNKNOWN'}`,`Requested model: ${model(g?.requested_model)}; reported model: ${model(g?.reported_model)}`,`Process wall ms: ${num(g?.process_wall_ms)}; provider duration seconds: ${typeof g?.provider_duration_sec==='number'&&Number.isFinite(g.provider_duration_sec)&&g.provider_duration_sec>=0?g.provider_duration_sec:'UNKNOWN'}; inference seconds: UNKNOWN`,`Tokens: ${['input','output','cache_read','thinking','total','codex_reasoning'].map(k=>`${k}=${num(g?.tokens?.[k])}`).join(', ')}`,`Syntax: ${['ACCEPTED','UNKNOWN','NOT_RUN'].includes(s?.wrapper_status)?s.wrapper_status:'UNKNOWN'}`,`Artifact: ${typeof a?.sha256==='string'&&/^[a-f0-9]{64}$/.test(a.sha256)?a.sha256:'UNKNOWN'}; bytes: ${num(a?.byte_count)}`,`Diagnostic: ${diagnostic}`,'Limits: direct child only; descendant guarantee NONE; no hostile containment, crash recovery or workspace reuse proof.'].join('\n')+'\n';
  }catch{return 'Squire single-JavaScript receipt: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';}
}
