// Offline receipt projection only. No artifact reads, execution or admission authority.
import {types} from 'node:util';
import {validateLimitedJobRecord} from './limited-job-record.mjs';

export const REPORT_MAX_BYTES = 262144;
const reasons = new Set(['CANCELED','GENERATION_REJECTED','SYNTAX_PROCESS_REJECTED','SOURCE_IDENTITY_CHANGED','AGGREGATE_EXPIRED','FIXTURE_REJECTED','OPERATION_FAILED_OR_UNCERTAIN']);
const diagnosticReasons = new Set(['COLLECTION_FAILED','PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE','ENVELOPE_PARSE_ERROR','MISSING_TERMINAL','REPEATED_TERMINAL_REJECTED','CONFLICTING_TERMINAL_EVENTS','TRAILING_DATA_AFTER_TERMINAL','PROVIDER_NON_SUCCESS','TURN_FAILED','RESPONSE_STRING_REQUIRED','AMBIGUOUS_AGENT_MESSAGE','CODEGEN_MARKDOWN_REJECTED','CODEGEN_ENCODING_REJECTED','CODEGEN_PAYLOAD_TOO_SMALL','CODEGEN_PAYLOAD_TOO_LARGE','CODEGEN_SOURCE_STRING_REQUIRED','TASK_PAYLOAD_INVALID','UNKNOWN_REJECTION']);
const stages = new Set(['COLLECTION','ENVELOPE','PROVIDER_STATUS','RESPONSE','PAYLOAD','UNCLASSIFIED']);
const providerStatuses = new Set(['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING','turn.completed','turn.failed','UNKNOWN']);
const campaignKeys = ['status','reason','generation','syntax','source','fixture_deadline_ms','fixtures','denominator','runtime_admitted','workspace_disposition','descendant_guarantee'];
const nativeKeys = ['direct_child_invocations','outer_observation_target_ms','event_loop_condition','operator_receipt','operator_admitted'];
const sourceKeys = ['source_path','source_sha256','source_byte_count','inspection','safety'];
const fixtureKeys = ['fixture_id','observed_exit_code','observed_exit_signal','observed_wall_ms','exit_code_matched','summary_json_matched','manifest_json_matched','zero_files_verified','fixture_verdict','status'];
const executionKeys = ['status','observed_exit_code','observed_exit_signal','observed_wall_ms','observed_termination','io_state','settlement_status','signal_attempts','deadline_ms','runtime_admitted','descendant_guarantee','workspace_reuse'];
const invalid = reason => {throw reason;};
const integer = v => Number.isSafeInteger(v) && v >= 0;
const nullableInteger = v => v === null || integer(v);
const exit = v => v === null || Number.isSafeInteger(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const isString = v => typeof v === 'string';
function keys(v, required, optional = []) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k=>!Object.hasOwn(v,k)) ||
      Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k))) invalid('SCHEMA_MISMATCH');
}
function freeze(v) {if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function scalar(v) {if(v!==null&&!['string','number','boolean'].includes(typeof v))invalid('SCHEMA_MISMATCH');if(typeof v==='number'&&!Number.isFinite(v))invalid('SCHEMA_MISMATCH');if(typeof v==='string'&&v.length>4096)invalid('SCHEMA_MISMATCH');return v;}
// Descriptor-only capture keeps object callers from running getters/toJSON/Proxy traps.
function copy(v, depth=0, seen=new Set(), budget={remaining:REPORT_MAX_BYTES}) {
  budget.remaining-=8;if(budget.remaining<0)invalid('FILE_TOO_LARGE');
  if(depth>10)invalid('SCHEMA_MISMATCH');
  if(v===null||typeof v!=='object'){scalar(v);if(typeof v==='string')budget.remaining-=new TextEncoder().encode(v).length;if(budget.remaining<0)invalid('FILE_TOO_LARGE');return v;}
  if(types.isProxy(v)||seen.has(v))invalid('SCHEMA_MISMATCH');
  const array=Array.isArray(v), proto=Object.getPrototypeOf(v);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)invalid('SCHEMA_MISMATCH');
  seen.add(v);const out=array?[]:Object.create(null),names=Reflect.ownKeys(v);
  if(array&&(v.length>64||names.length!==v.length+1))invalid('SCHEMA_MISMATCH');
  for(const k of names){
    if(k==='length'&&array)continue;
    if(typeof k!=='string'||['__proto__','constructor','prototype'].includes(k)||array&&!/^(0|[1-9][0-9]*)$/.test(k))invalid('SCHEMA_MISMATCH');
    const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value'))invalid('SCHEMA_MISMATCH');
    if(k.length>4096)invalid('SCHEMA_MISMATCH');budget.remaining-=k.length;out[k]=copy(d.value,depth+1,seen,budget);
  }
  seen.delete(v);return out;
}

// Small bounded JSON grammar: decoded-key duplicates are rejected before JSON.parse.
export function parseReceiptJson(bytes) {
  if(!types.isUint8Array(bytes)||types.isProxy(bytes))invalid('MALFORMED_JSON');
  const length=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get.call(bytes);
  if(length>REPORT_MAX_BYTES)invalid('FILE_TOO_LARGE');
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{invalid('MALFORMED_UTF8');}
  let i=0;
  const ws=()=>{while(/[\x20\t\r\n]/.test(text[i]??'!'))i++;};
  function string(){
    if(text[i]!== '"')invalid('MALFORMED_JSON');const begin=i++;
    while(i<text.length){const c=text[i++];if(c==='"'){let v;try{v=JSON.parse(text.slice(begin,i));}catch{invalid('MALFORMED_JSON');}scalar(v);return v;}if(c==='\\')i++;}
    invalid('MALFORMED_JSON');
  }
  function value(depth){
    if(depth>10)invalid('SCHEMA_MISMATCH');ws();const c=text[i];
    if(c==='"')return string();
    if(c==='{'){
      i++;ws();const out=Object.create(null),seen=new Set();if(text[i]==='}'){i++;return out;}
      while(i<text.length){const k=string();if(seen.has(k))invalid('DUPLICATE_KEY_CONFLICT');if(['__proto__','constructor','prototype'].includes(k))invalid('SCHEMA_MISMATCH');seen.add(k);ws();if(text[i++]!==':')invalid('MALFORMED_JSON');out[k]=value(depth+1);ws();const t=text[i++];if(t==='}')return out;if(t!==',')invalid('MALFORMED_JSON');ws();}
      invalid('MALFORMED_JSON');
    }
    if(c==='['){i++;ws();const out=[];if(text[i]===']'){i++;return out;}while(i<text.length){if(out.length>=64)invalid('SCHEMA_MISMATCH');out.push(value(depth+1));ws();const t=text[i++];if(t===']')return out;if(t!==',')invalid('MALFORMED_JSON');}invalid('MALFORMED_JSON');}
    const match=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if(!match)invalid('MALFORMED_JSON');i+=match[0].length;return scalar(JSON.parse(match[0]));
  }
  const result=value(0);ws();if(i!==text.length)invalid('MALFORMED_JSON');return result;
}
const tokensEmpty = () => null;
const emptyGeneration = () => ({lifecycle_status:'NOT_RUN',task_outcome_evaluated_marker:null,provider_status:null,requested_model:null,reported_model:null,process_wall_ms:null,provider_duration_sec:null,inference_duration_sec:null,tokens:tokensEmpty()});
const emptySyntax = () => ({wrapper_status:'NOT_RUN',observed_exit_code:null,syntax_valid:null});
const emptyArtifact = () => ({witness_present:false,sha256:null,byte_count:null,format_inspection:null,safety_evidence:null});
const emptyFixtures = () => ({total_matrix:null,passed_count:null,failed_count:null,not_run_count:null,cases:null});
function base() {return {schema_version:'squire1.offline_summary.v1',overall_outcome:'INVALID_RECEIPT',campaign:{raw_status:'UNKNOWN',raw_reason:null,denominator:null},admission:{operator_admitted:false,runtime_admitted_marker:null,has_operator_receipt:false},generation:emptyGeneration(),syntax:emptySyntax(),artifact:emptyArtifact(),fixtures:emptyFixtures(),execution:{child_invocations:{generation:null,syntax:null,fixtures:null},workspace_disposition:'UNKNOWN',descendant_guarantee:'NONE'},diagnostic:{stage:null,reason:null}};}
export function invalidRunSummary(reason='SCHEMA_MISMATCH') {
  const allowed=new Set(['MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','SCHEMA_MISMATCH','FINITE_FIXTURE_MATRIX_REQUIRED','DUPLICATE_FIXTURE_ID','CONTRADICTORY_COUNTS','UNSUPPORTED_NON_NUMERIC_COUNTER','NEGATIVE_COUNTER_REJECTED','SOURCE_IDENTITY_CHANGED','READ_FAILED','FILE_NOT_FOUND','SPECIAL_FILE_REJECTED','FILE_TOO_LARGE']);
  const out=base();out.diagnostic={stage:'RECEIPT_VALIDATION',reason:allowed.has(reason)?reason:'SCHEMA_MISMATCH'};return freeze(out);
}
function counter(v) {if(v===null||v==='UNKNOWN'||v===undefined)return null;if(typeof v!=='number'||!Number.isSafeInteger(v))invalid('UNSUPPORTED_NON_NUMERIC_COUNTER');if(v<0)invalid('NEGATIVE_COUNTER_REJECTED');return v;}
function count(v,max) {if(!integer(v)||v>max)invalid('CONTRADICTORY_COUNTS');return v;}
function validateIO(v) {keys(v,['stdout_bytes_observed','stderr_bytes_observed','stdout_eof','stderr_eof','io_drained']);if(!integer(v.stdout_bytes_observed)||!integer(v.stderr_bytes_observed)||['stdout_eof','stderr_eof','io_drained'].some(k=>typeof v[k]!=='boolean')||v.io_drained&&(!v.stdout_eof||!v.stderr_eof))invalid('SCHEMA_MISMATCH');}
function validateSignals(v) {if(!Array.isArray(v))invalid('SCHEMA_MISMATCH');for(const a of v){keys(a,['signal','accepted'],['elapsed_ms']);if(!['SIGTERM','SIGKILL'].includes(a.signal)||typeof a.accepted!=='boolean'||Object.hasOwn(a,'elapsed_ms')&&!nullableInteger(a.elapsed_ms))invalid('SCHEMA_MISMATCH');}}
function validateExecution(v) {
  keys(v,executionKeys);validateIO(v.io_state);validateSignals(v.signal_attempts);
  if(!['OBSERVED_EXIT','TIMEOUT','CANCELED','INTERNAL_ERROR','IO_INCOMPLETE','SPAWN_FAILED','CAPACITY_EXCEEDED'].includes(v.status)||!exit(v.observed_exit_code)||!nullableInteger(v.observed_wall_ms)||!nullableInteger(v.deadline_ms)||v.observed_exit_signal!==null&&!isString(v.observed_exit_signal)||typeof v.observed_termination!=='boolean'||v.runtime_admitted!==false||v.descendant_guarantee!=='NONE'||v.workspace_reuse!=='NOT_AUTHORIZED'||!['SETTLED_DIRECT_CHILD_EXIT','ABANDONED_UNSETTLED','UNKNOWN'].includes(v.settlement_status))invalid('SCHEMA_MISMATCH');
  if(!v.observed_termination&&(v.observed_exit_code!==null||v.observed_exit_signal!==null)||v.settlement_status==='SETTLED_DIRECT_CHILD_EXIT'&&!v.observed_termination)invalid('SCHEMA_MISMATCH');
}
function projectGeneration(v,out,taskClass='BOUNDED_CODEGEN_SUMMARIZER_V5') {
  if(v===null)return;
  keys(v,['record','diagnostic_retention','runtime_evidence','physical_source_witness','runtime_admitted']);if(v.runtime_admitted!==false)invalid('SCHEMA_MISMATCH');
  const r=v.record,m=r?.provider_metadata,u=m?.usage_tokens;if(!u)invalid('SCHEMA_MISMATCH');
  const token=Object.fromEntries(['input','output','cache_read','thinking','total'].map(k=>[k,counter(u[k])]));token.codex_reasoning=counter(m.codex_reasoning_output_tokens);
  // Null counters are legitimate unavailable observations; the legacy wire validator uses UNKNOWN.
  const normalized={...r,provider_metadata:{...m,usage_tokens:Object.fromEntries(Object.entries(u).map(([k,x])=>[k,x===null?'UNKNOWN':x])),...(m.codex_reasoning_output_tokens===null?{codex_reasoning_output_tokens:'UNKNOWN'}:{})}};
  try{validateLimitedJobRecord(normalized);}catch{invalid('SCHEMA_MISMATCH');}
  if(r.task_class!==taskClass||r.task_outcome_evaluated!==false)invalid('SCHEMA_MISMATCH');
  const runtime=v.runtime_evidence;keys(runtime,['deadline_ms','timeout_latched','abort_latched','signal_attempts','event_loop_condition','workspace_reuse','workspace_disposition','max_steps']);validateSignals(runtime.signal_attempts);
  if(!nullableInteger(runtime.deadline_ms)||typeof runtime.timeout_latched!=='boolean'||typeof runtime.abort_latched!=='boolean'||runtime.event_loop_condition!=='RESPONSIVE_PARENT_EVENT_LOOP'||runtime.workspace_reuse!=='NOT_AUTHORIZED'||!['DEDICATED_NOT_REUSED','QUARANTINED'].includes(runtime.workspace_disposition)||runtime.max_steps!=='UNSUPPORTED')invalid('SCHEMA_MISMATCH');
  if(r.lifecycle_status==='LIMITED_SUCCESS'&&(runtime.timeout_latched||runtime.abort_latched||runtime.workspace_disposition!=='DEDICATED_NOT_REUSED'))invalid('SCHEMA_MISMATCH');
  const d=v.diagnostic_retention;keys(d,['retention_status','rejection_stage','rejection_reason','exact_response_bytes','retained_bytes_count','retained_truncated','retention_error']);
  if(!['NOT_REQUESTED','NOT_ELIGIBLE','REQUESTED','PUBLISHED','FAILED','UNKNOWN'].includes(d.retention_status)||!nullableInteger(d.exact_response_bytes)||!nullableInteger(d.retained_bytes_count)||typeof d.retained_truncated!=='boolean'||d.rejection_stage!==null&&!stages.has(d.rejection_stage)||d.rejection_reason!==null&&!diagnosticReasons.has(d.rejection_reason)||d.retention_error!==null&&!['RETENTION_IO_FAILED','RETENTION_TIMEOUT_OR_ABORTED','RETENTION_CAPACITY_EXCEEDED','RETENTION_PRIVATE_ROOT_UNAVAILABLE','RETENTION_INVALID_CAPTURE'].includes(d.retention_error))invalid('SCHEMA_MISMATCH');
  if(d.rejection_reason!==null)out.diagnostic={stage:d.rejection_stage,reason:d.rejection_reason};
  if(out.diagnostic.reason===null&&typeof r.error_details.code==='string'){
    const parts=r.error_details.code.split(':');if(parts.length===2&&stages.has(parts[0])&&diagnosticReasons.has(parts[1]))out.diagnostic={stage:parts[0],reason:parts[1]};
  }
  const w=v.physical_source_witness;
  if(w!==null){keys(w,['source_path','source_sha256','source_byte_count','format_status','syntax_observation','witness_locked','destination_mode','witness_timestamp_ms']);if(!isString(w.source_path)||!sha(w.source_sha256)||!integer(w.source_byte_count)||w.format_status!=='FORMAT_VALID'||!['UNESTABLISHED_NO_NATIVE_PARSER','SYNTAX_VALID','SYNTAX_ERROR'].includes(w.syntax_observation)||w.witness_locked!==true||w.destination_mode!=='0o400'||!integer(w.witness_timestamp_ms))invalid('SCHEMA_MISMATCH');}
  if(r.output_custody.persisted!==(w!==null))invalid('SOURCE_IDENTITY_CHANGED');
  if(w&&(w.source_path!==r.output_custody.path||w.source_byte_count!==r.output_custody.byte_count))invalid('SOURCE_IDENTITY_CHANGED');
  out.generation={lifecycle_status:r.lifecycle_status,task_outcome_evaluated_marker:false,provider_status:providerStatuses.has(m.provider_reported_status)?m.provider_reported_status:m.provider_reported_status===null?null:'UNKNOWN',requested_model:r.requested_model==='gpt-6-luna'?'gpt-6-luna':'UNKNOWN',reported_model:r.reported_model==='gpt-6-luna'?'gpt-6-luna':'UNKNOWN',process_wall_ms:r.process_exit.process_wall_ms,provider_duration_sec:m.duration_seconds,inference_duration_sec:null,tokens:token};
}
function projectSyntax(v,out) {
  if(v===null)return;
  keys(v,['execution','wrapper_status','observation']);validateExecution(v.execution);keys(v.observation,['syntax_status','syntax_valid']);
  if(!['ACCEPTED','UNKNOWN'].includes(v.wrapper_status)||!['SYNTAX_VALID','SYNTAX_ERROR','UNESTABLISHED_NO_NATIVE_PARSER'].includes(v.observation.syntax_status)||v.observation.syntax_valid!==null&&typeof v.observation.syntax_valid!=='boolean'||(v.observation.syntax_status==='SYNTAX_VALID')!==(v.observation.syntax_valid===true)||(v.observation.syntax_status==='SYNTAX_ERROR')!==(v.observation.syntax_valid===false))invalid('SCHEMA_MISMATCH');
  const e=v.execution;if(v.wrapper_status==='ACCEPTED'&&(e.status!=='OBSERVED_EXIT'||!e.observed_termination||e.observed_exit_code!==0||e.observed_exit_signal!==null||!e.io_state.io_drained||e.io_state.stdout_bytes_observed!==0||e.io_state.stderr_bytes_observed!==0||e.settlement_status!=='SETTLED_DIRECT_CHILD_EXIT'||v.observation.syntax_valid!==true))invalid('SCHEMA_MISMATCH');
  out.syntax={wrapper_status:v.wrapper_status,observed_exit_code:e.observed_exit_code,syntax_valid:v.observation.syntax_valid};
}
function projectFixtures(v,out) {
  if(!Array.isArray(v)||v.length!==17)invalid('FINITE_FIXTURE_MATRIX_REQUIRED');
  const ids=new Set(),cases=[];let passed=0,failed=0,notRun=0;
  for(let i=0;i<17;i++){
    const f=v[i];if(!f||typeof f!=='object')invalid('SCHEMA_MISMATCH');
    if(ids.has(f.fixture_id))invalid('DUPLICATE_FIXTURE_ID');ids.add(f.fixture_id);
    if(f.fixture_id!==`FIX-${String(i+1).padStart(2,'0')}`)invalid('FINITE_FIXTURE_MATRIX_REQUIRED');
    if(f.status==='NOT_RUN'){keys(f,['fixture_id','status']);notRun++;cases.push({fixture_id:f.fixture_id,verdict:'NOT_RUN',observed_exit_code:null});continue;}
    keys(f,fixtureKeys);if(!['PASS','FAIL','TIMEOUT'].includes(f.status)||f.status!==f.fixture_verdict||!exit(f.observed_exit_code)||f.observed_exit_signal!==null&&!isString(f.observed_exit_signal)||!nullableInteger(f.observed_wall_ms)||typeof f.exit_code_matched!=='boolean'||['summary_json_matched','manifest_json_matched','zero_files_verified'].some(k=>!['NOT_APPLICABLE',true,false].includes(f[k])))invalid('SCHEMA_MISMATCH');
    if(f.status==='PASS'&&(!f.exit_code_matched||f.observed_exit_code===null||f.observed_exit_signal!==null||['summary_json_matched','manifest_json_matched','zero_files_verified'].some(k=>f[k]===false)))invalid('SCHEMA_MISMATCH');
    const verdict=f.status==='PASS'?'PASS':'FAIL';if(verdict==='PASS')passed++;else failed++;
    cases.push({fixture_id:f.fixture_id,verdict,observed_exit_code:f.observed_exit_code});
  }
  out.fixtures={total_matrix:17,passed_count:passed,failed_count:failed,not_run_count:notRun,cases};
}
export function projectSingleJsEvidence(value){
  const r=copy(value);keys(r,['generation','syntax','source']);const out=base();
  projectGeneration(r.generation,out,'SINGLE_JS_CODEGEN_V1');projectSyntax(r.syntax,out);
  if(r.source!==null){const s=r.source;keys(s,sourceKeys);const w=r.generation?.physical_source_witness;
    if(!isString(s.source_path)||!sha(s.source_sha256)||!integer(s.source_byte_count)||s.inspection!=='ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY'||s.safety!=='NOT_ESTABLISHED'||!w||s.source_sha256!==w.source_sha256||s.source_byte_count!==w.source_byte_count||s.source_path!==w.source_path)invalid('SOURCE_IDENTITY_CHANGED');
    out.artifact={witness_present:true,sha256:s.source_sha256,byte_count:s.source_byte_count,format_inspection:s.inspection,safety_evidence:s.safety};
  }
  return freeze({generation:out.generation,syntax:out.syntax,artifact:out.artifact,diagnostic:out.diagnostic});
}
export const snapshotReceiptData=value=>copy(value);
export function projectRunSummary(rawReceipt,options={}) {
  try{
    options=copy(options);keys(options,[],['maxInputBytes']);const cap=options.maxInputBytes??REPORT_MAX_BYTES;if(!integer(cap)||cap===0||cap>REPORT_MAX_BYTES)invalid('SCHEMA_MISMATCH');
    const r=copy(rawReceipt);if(new TextEncoder().encode(JSON.stringify(r)).length>cap)invalid('FILE_TOO_LARGE');
    const out=base();
    if(r?.status==='DRY_RUN_NATIVE_DISABLED'){
      keys(r,['status','direct_child_invocations']);if(r.direct_child_invocations!==0)invalid('CONTRADICTORY_COUNTS');out.overall_outcome='INCOMPLETE';out.campaign.raw_status=r.status;out.execution.child_invocations={generation:0,syntax:0,fixtures:0};return freeze(out);
    }
    const native=Object.hasOwn(r??{},'operator_admitted');keys(r,[...campaignKeys,...(native?nativeKeys:[])]);
    if(!['PASS','FAIL'].includes(r.status)||r.reason!==null&&!reasons.has(r.reason)||r.denominator!==17||r.runtime_admitted!==false||!nullableInteger(r.fixture_deadline_ms)||!['DEDICATED_NOT_REUSED','QUARANTINED'].includes(r.workspace_disposition)||r.descendant_guarantee!=='NONE')invalid(r?.denominator!==17?'FINITE_FIXTURE_MATRIX_REQUIRED':'SCHEMA_MISMATCH');
    out.campaign={raw_status:r.status,raw_reason:r.reason,denominator:17};out.admission.runtime_admitted_marker=false;out.execution.workspace_disposition=r.workspace_disposition;
    if(native){keys(r.direct_child_invocations,['generation','syntax','fixtures']);const c=r.direct_child_invocations;out.execution.child_invocations={generation:count(c.generation,1),syntax:count(c.syntax,1),fixtures:count(c.fixtures,17)};if(r.outer_observation_target_ms!==250000||r.event_loop_condition!=='RESPONSIVE_PARENT_EVENT_LOOP'||!isString(r.operator_receipt)||typeof r.operator_admitted!=='boolean')invalid('SCHEMA_MISMATCH');out.admission.operator_admitted=r.operator_admitted;out.admission.has_operator_receipt=r.operator_receipt.length>0;}
    projectGeneration(r.generation,out);projectSyntax(r.syntax,out);projectFixtures(r.fixtures,out);
    if(r.source!==null){keys(r.source,sourceKeys);const s=r.source;if(!isString(s.source_path)||!sha(s.source_sha256)||!integer(s.source_byte_count)||s.inspection!=='ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY'||s.safety!=='NOT_ESTABLISHED')invalid('SCHEMA_MISMATCH');const w=r.generation?.physical_source_witness;if(!w||s.source_sha256!==w.source_sha256||s.source_byte_count!==w.source_byte_count||s.source_path!==w.source_path)invalid('SOURCE_IDENTITY_CHANGED');out.artifact={witness_present:true,sha256:s.source_sha256,byte_count:s.source_byte_count,format_inspection:s.inspection,safety_evidence:s.safety};}
    const f=out.fixtures,g=out.generation,s=out.syntax;
    if(r.generation===null&&(r.syntax!==null||r.source!==null||f.not_run_count!==17)||r.syntax!==null&&(g.lifecycle_status!=='LIMITED_SUCCESS'||r.source===null)||f.not_run_count<17&&s.wrapper_status!=='ACCEPTED')invalid('SCHEMA_MISMATCH');
    if(native){const c=out.execution.child_invocations;if(c.generation<(r.generation===null?0:1)||c.syntax<(r.syntax===null?0:1)||c.fixtures<f.passed_count+f.failed_count)invalid('CONTRADICTORY_COUNTS');}
    const complete=g.lifecycle_status==='LIMITED_SUCCESS'&&s.wrapper_status==='ACCEPTED'&&s.syntax_valid===true&&out.artifact.witness_present&&f.passed_count===17;
    if(r.status==='PASS'&&(r.reason!==null||!complete||r.workspace_disposition!=='DEDICATED_NOT_REUSED')||r.status==='FAIL'&&r.reason===null)invalid('SCHEMA_MISMATCH');
    const failed=f.failed_count>0||['GENERATION_REJECTED','SYNTAX_PROCESS_REJECTED','SOURCE_IDENTITY_CHANGED','FIXTURE_REJECTED','OPERATION_FAILED_OR_UNCERTAIN'].includes(r.reason)||['LIMITED_PROCESS_FAILED','LIMITED_PARSER_ERROR','LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR','LIMITED_CAPACITY_EXCEEDED'].includes(g.lifecycle_status);
    out.overall_outcome=failed?'FAIL':['CANCELED','AGGREGATE_EXPIRED'].includes(r.reason)||['LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(g.lifecycle_status)||f.not_run_count>0?'INCOMPLETE':r.status==='PASS'&&complete?'PASS':'INVALID_RECEIPT';
    if(out.overall_outcome==='INVALID_RECEIPT')invalid('SCHEMA_MISMATCH');return freeze(out);
  }catch(reason){return invalidRunSummary(typeof reason==='string'?reason:'SCHEMA_MISMATCH');}
}

function validateSummary(s) {
  keys(s,['schema_version','overall_outcome','campaign','admission','generation','syntax','artifact','fixtures','execution','diagnostic']);
  if(s.schema_version!=='squire1.offline_summary.v1'||!['PASS','FAIL','INCOMPLETE','INVALID_RECEIPT'].includes(s.overall_outcome))invalid('SCHEMA_MISMATCH');
  keys(s.campaign,['raw_status','raw_reason','denominator']);if(!['PASS','FAIL','DRY_RUN_NATIVE_DISABLED','UNKNOWN'].includes(s.campaign.raw_status)||s.campaign.raw_reason!==null&&!reasons.has(s.campaign.raw_reason)||![17,null].includes(s.campaign.denominator))invalid('SCHEMA_MISMATCH');
  keys(s.admission,['operator_admitted','runtime_admitted_marker','has_operator_receipt']);if(typeof s.admission.operator_admitted!=='boolean'||typeof s.admission.has_operator_receipt!=='boolean'||![false,null].includes(s.admission.runtime_admitted_marker))invalid('SCHEMA_MISMATCH');
  const g=s.generation;if(g!==null){keys(g,['lifecycle_status','task_outcome_evaluated_marker','provider_status','requested_model','reported_model','process_wall_ms','provider_duration_sec','inference_duration_sec','tokens']);if(!['LIMITED_SUCCESS','LIMITED_PROCESS_FAILED','LIMITED_TIMEOUT','LIMITED_USER_ABORT','LIMITED_CAPACITY_EXCEEDED','LIMITED_PARSER_ERROR','LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR','NOT_RUN','UNKNOWN'].includes(g.lifecycle_status)||![false,null].includes(g.task_outcome_evaluated_marker)||g.provider_status!==null&&!providerStatuses.has(g.provider_status)||![g.requested_model,g.reported_model].every(v=>['gpt-6-luna','UNKNOWN',null].includes(v))||!nullableInteger(g.process_wall_ms)||g.provider_duration_sec!==null&&(typeof g.provider_duration_sec!=='number'||!Number.isFinite(g.provider_duration_sec)||g.provider_duration_sec<0)||g.inference_duration_sec!==null)invalid('SCHEMA_MISMATCH');if(g.tokens!==null){keys(g.tokens,['input','output','cache_read','thinking','total','codex_reasoning']);if(Object.values(g.tokens).some(v=>!nullableInteger(v)))invalid('SCHEMA_MISMATCH');}}
  if(s.syntax!==null){keys(s.syntax,['wrapper_status','observed_exit_code','syntax_valid']);if(!['ACCEPTED','UNKNOWN','NOT_RUN'].includes(s.syntax.wrapper_status)||!exit(s.syntax.observed_exit_code)||![true,false,null].includes(s.syntax.syntax_valid))invalid('SCHEMA_MISMATCH');}
  if(s.artifact!==null){keys(s.artifact,['witness_present','sha256','byte_count','format_inspection','safety_evidence']);if(typeof s.artifact.witness_present!=='boolean'||s.artifact.sha256!==null&&!sha(s.artifact.sha256)||!nullableInteger(s.artifact.byte_count)||!['ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY','UNKNOWN',null].includes(s.artifact.format_inspection)||!['NOT_ESTABLISHED','UNKNOWN',null].includes(s.artifact.safety_evidence))invalid('SCHEMA_MISMATCH');}
  const f=s.fixtures;if(f!==null){keys(f,['total_matrix','passed_count','failed_count','not_run_count','cases']);if(![17,null].includes(f.total_matrix)||[f.passed_count,f.failed_count,f.not_run_count].some(v=>!nullableInteger(v)||v>17))invalid('SCHEMA_MISMATCH');if(f.cases!==null){if(!Array.isArray(f.cases)||f.cases.length!==17)invalid('SCHEMA_MISMATCH');for(let i=0;i<17;i++){const c=f.cases[i];keys(c,['fixture_id','verdict','observed_exit_code']);if(c.fixture_id!==`FIX-${String(i+1).padStart(2,'0')}`||!['PASS','FAIL','NOT_RUN','INVALID'].includes(c.verdict)||!exit(c.observed_exit_code))invalid('SCHEMA_MISMATCH');}if(['PASS','FAIL','NOT_RUN'].some((v,i)=>f.cases.filter(c=>c.verdict===v).length!==[f.passed_count,f.failed_count,f.not_run_count][i]))invalid('CONTRADICTORY_COUNTS');}}
  keys(s.execution,['child_invocations','workspace_disposition','descendant_guarantee']);keys(s.execution.child_invocations,['generation','syntax','fixtures']);if(Object.values(s.execution.child_invocations).some(v=>!nullableInteger(v))||!['DEDICATED_NOT_REUSED','QUARANTINED','UNKNOWN'].includes(s.execution.workspace_disposition)||s.execution.descendant_guarantee!=='NONE')invalid('SCHEMA_MISMATCH');
  keys(s.diagnostic,['stage','reason']);if(s.diagnostic.stage!==null&&!stages.has(s.diagnostic.stage)&&s.diagnostic.stage!=='RECEIPT_VALIDATION'||s.diagnostic.reason!==null&&!diagnosticReasons.has(s.diagnostic.reason)&&invalidRunSummary(s.diagnostic.reason).diagnostic.reason!==s.diagnostic.reason)invalid('SCHEMA_MISMATCH');
  if(s.overall_outcome==='PASS'&&(s.campaign.raw_status!=='PASS'||s.campaign.raw_reason!==null||g?.lifecycle_status!=='LIMITED_SUCCESS'||s.syntax?.wrapper_status!=='ACCEPTED'||s.syntax.syntax_valid!==true||s.artifact?.witness_present!==true||!sha(s.artifact.sha256)||f?.passed_count!==17||f.failed_count!==0||f.not_run_count!==0))invalid('SCHEMA_MISMATCH');
}
export function validateProjectedEvidence(value){
  const captured=copy(value);keys(captured,['generation','syntax','artifact','diagnostic']);
  const wrapper={...base(),...captured,overall_outcome:'INCOMPLETE'};
  validateSummary(wrapper);return freeze(captured); // Validates shape only, never supplies a functional outcome.
}
// Fresh descriptor-only validation; arbitrary strings never become terminal labels.
export function formatSummaryTerminal(summary) {
  try{
    const s=copy(summary);validateSummary(s);
    const safe=v=>v===null?'UNKNOWN':typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?String(v):['PASS','FAIL','INCOMPLETE','INVALID_RECEIPT','UNKNOWN','NOT_RUN','ACCEPTED','DEDICATED_NOT_REUSED','QUARANTINED','NONE','gpt-6-luna','LIMITED_SUCCESS','LIMITED_PROCESS_FAILED','LIMITED_TIMEOUT','LIMITED_USER_ABORT','LIMITED_CAPACITY_EXCEEDED','LIMITED_PARSER_ERROR','LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR'].includes(v)?v:'UNKNOWN';
    const yes=v=>v===true?'true':v===false?'false':'UNKNOWN';
    const d=s.diagnostic?.reason,reason=typeof d==='string'&&/^[A-Z_]+$/.test(d)&&Object.hasOwn(invalidRunSummary(d).diagnostic,'reason')?(invalidRunSummary(d).diagnostic.reason===d||diagnosticReasons.has(d)?d:'UNKNOWN_REJECTION'):'NONE';
    const lines=[`Squire offline receipt summary: ${safe(s.overall_outcome)}`,'Recorded claims only; no artifact, authorization or execution re-verification.',`Generation: ${safe(s.generation?.lifecycle_status)}`,`Provider status: ${providerStatuses.has(s.generation?.provider_status)?s.generation.provider_status:'UNKNOWN'}`,`Requested model: ${safe(s.generation?.requested_model)}; reported model: ${safe(s.generation?.reported_model)}`,`Process wall ms: ${safe(s.generation?.process_wall_ms)}; provider duration seconds: ${typeof s.generation?.provider_duration_sec==='number'&&Number.isFinite(s.generation.provider_duration_sec)&&s.generation.provider_duration_sec>=0?s.generation.provider_duration_sec:'UNKNOWN'}; inference seconds: UNKNOWN`,`Tokens: ${['input','output','cache_read','thinking','total','codex_reasoning'].map(k=>`${k}=${safe(s.generation?.tokens?.[k])}`).join(', ')}`,`Syntax: ${safe(s.syntax?.wrapper_status)}; valid: ${yes(s.syntax?.syntax_valid)}`,`Fixtures: ${safe(s.fixtures?.passed_count)} PASS / ${safe(s.fixtures?.failed_count)} FAIL / ${safe(s.fixtures?.not_run_count)} NOT_RUN; denominator: ${safe(s.campaign?.denominator)}`,`Artifact: ${s.artifact?.witness_present===true&&sha(s.artifact.sha256)?s.artifact.sha256:'UNKNOWN'}; bytes: ${safe(s.artifact?.byte_count)}`,`Claimed operator admission: ${yes(s.admission?.operator_admitted)}; static runtime marker: ${yes(s.admission?.runtime_admitted_marker)}`,`Runner task evaluated marker: ${yes(s.generation?.task_outcome_evaluated_marker)}`,`Direct-child calls: generation=${safe(s.execution?.child_invocations?.generation)}, syntax=${safe(s.execution?.child_invocations?.syntax)}, fixtures=${safe(s.execution?.child_invocations?.fixtures)}`,`Workspace: ${safe(s.execution?.workspace_disposition)}`,`Diagnostic: ${reason}`,'Limits: direct child only; descendant guarantee NONE; no hostile containment, crash recovery or workspace reuse proof.'];
    return (lines.join('\n')+'\n').replace(/[^\x20-\x7e\n]/g,'');
  }catch{return 'Squire offline receipt summary: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';}
}
