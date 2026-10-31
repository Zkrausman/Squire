// Offline projection of recorded SQUIRE2_PROJECT_RESULT_V1 claims only.
import {snapshotReceiptData} from './offline-run-summary.mjs';
import {parseReceiptJson,REPORT_MAX_BYTES} from './offline-run-summary.mjs';
import {types} from 'node:util';
import {validateLimitedJobRecord,validateLargeProjectJobRecord} from './limited-job-record.mjs';
import {diagnosticReport} from './internal/limited-diagnostics.mjs';
import {
  PROJECT_CODING_OBSERVATION_PROFILE,PROJECT_CODING_OBSERVATION_RESULT_SCHEMA,
  PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA,PROJECT_CODING_OBSERVATION_SUMMARY_SCHEMA,
  PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA,
  PROJECT_LARGE_OBSERVATION_SUMMARY_SCHEMA,PROJECT_LARGE_OBSERVATION_TASK_CLASS,
  PROJECT_OUTPUT_LARGE_PROFILE,validateProjectOutputLargeProfile,
  validateProjectCodingObservationProfile,validateProjectCodingObservationOutcome
} from './project-coding-profile.mjs';

const SCHEMA='squire2.project_summary.v1';
const NATIVE_SCHEMA='squire3.native_project_summary.v1';
const TARGET_MS=140000;
const EVENT_LOOP='RESPONSIVE_PARENT_EVENT_LOOP';
const UNKNOWN='UNKNOWN';
const statuses=new Set(['CANDIDATE_STAGED','GENERATION_REJECTED','STAGING_REJECTED','INCOMPLETE','FAILED']);
const reasons=new Set(['GENERATION_REJECTED','CANCELED','OBSERVATION_DEADLINE','OPERATION_FAILED_OR_UNCERTAIN','CLEANUP_FAILED_OR_UNCERTAIN','CLOCK_UNAVAILABLE']);
const stagingErrors=new Set(['DESTINATION_ALREADY_EXISTS','SOURCE_NOT_FOUND','SOURCE_INTEGRITY_MISMATCH','STAGE_INTEGRITY_MISMATCH','STAGE_BINDING_MISMATCH','INVALID_STAGE_SPEC','INVALID_EXPORT_SPEC','INVALID_MANIFEST','SPECIAL_FILE_REJECTED','PATH_TRAVERSAL_REJECTED','PATH_COLLISION_REJECTED','CAPACITY_EXCEEDED','PRIVACY_VIOLATION_REJECTED','PACKAGE_IO_ERROR','PACKAGE_ABORTED']);
const providerStatuses=new Set(['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING','turn.completed','turn.failed','UNKNOWN']);
const lifecycleStatuses=new Set(['LIMITED_SUCCESS','LIMITED_PROCESS_FAILED','LIMITED_TIMEOUT','LIMITED_USER_ABORT','LIMITED_CAPACITY_EXCEEDED','LIMITED_PARSER_ERROR','LIMITED_SPAWN_FAILED','LIMITED_PERSISTENCE_FAILED','LIMITED_INTERNAL_ERROR']);
const settlementStatuses=new Set(['SETTLED_DIRECT_CHILD_EXIT','SIGNALED_DIRECT_CHILD','ABANDONED_UNSETTLED','UNKNOWN']);
const retentionStatuses=new Set(['NOT_REQUESTED','NOT_ELIGIBLE','REQUESTED','PUBLISHED','FAILED','UNKNOWN']);
const retentionErrors=new Set(['RETENTION_IO_FAILED','RETENTION_TIMEOUT_OR_ABORTED','RETENTION_CAPACITY_EXCEEDED','RETENTION_PRIVATE_ROOT_UNAVAILABLE','RETENTION_INVALID_CAPTURE']);
const largeRetentionReasons=new Set([
  'PROJECT_PAYLOAD_TOO_SMALL','PROJECT_MARKDOWN_REJECTED','PROJECT_PAYLOAD_TOO_LARGE'
]);
const diagnosticPairs=[
  ['COLLECTION','COLLECTION_FAILED'],
  ...['PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE','ENVELOPE_PARSE_ERROR','MISSING_TERMINAL','REPEATED_TERMINAL_REJECTED','CONFLICTING_TERMINAL_EVENTS','TRAILING_DATA_AFTER_TERMINAL'].map(x=>['ENVELOPE',x]),
  ...['PROVIDER_NON_SUCCESS','TURN_FAILED'].map(x=>['PROVIDER_STATUS',x]),
  ...['RESPONSE_STRING_REQUIRED','AMBIGUOUS_AGENT_MESSAGE'].map(x=>['RESPONSE',x]),
  ...['CODEGEN_MARKDOWN_REJECTED','CODEGEN_ENCODING_REJECTED','CODEGEN_PAYLOAD_TOO_SMALL','CODEGEN_PAYLOAD_TOO_LARGE','CODEGEN_SOURCE_STRING_REQUIRED','TASK_PAYLOAD_INVALID','PROJECT_PAYLOAD_TOO_SMALL','PROJECT_PAYLOAD_TOO_LARGE','PROJECT_MARKDOWN_REJECTED','PROJECT_ENCODING_REJECTED','PROJECT_SCHEMA_MISMATCH','PROJECT_DUPLICATE_KEY','PROJECT_PATH_INVALID','PROJECT_PATH_TRAVERSAL','PROJECT_PATH_COLLISION','PROJECT_CLASSIFICATION_INVALID','PROJECT_ENCODING_INVALID','PROJECT_BASE64_INVALID','PROJECT_FILE_SIZE_EXCEEDED','PROJECT_AGGREGATE_CAPACITY_EXCEEDED'].map(x=>['PAYLOAD',x]),
  ['UNCLASSIFIED','UNKNOWN_REJECTION']
];
const inputKeys=['schema','status','reason','generation','staging','task_correctness','task_outcome_evaluated','runtime_admitted','operator_admitted','workspace_disposition','descendant_guarantee','operator_receipt','direct_child_invocations','outer_observation_target_ms','event_loop_condition'];
const summaryKeys=['schema_version','readiness','reason','task_correctness','task_outcome_evaluated','runtime_admitted_marker','operator_admitted_marker','has_operator_receipt','workspace_disposition','descendant_guarantee','direct_child_invocations','outer_observation_target_ms','event_loop_condition','generation','staging','diagnostic'];
const nativeSummaryKeys=['schema_version','readiness','reason','task_correctness','task_outcome_evaluated','runtime_admitted_marker','operator_admission_claimed','admission_authority','has_operator_receipt','workspace_disposition','descendant_guarantee','direct_child_invocations','outer_observation_target_ms','event_loop_condition','generation','staging','diagnostic'];
const largeNativeSummaryKeys=[
  ...nativeSummaryKeys,'execution_profile','output_profile','post_generation_closeout'
];
const usageKeys=['input','output','cache_read','thinking','total'];
const runtimeKeys=['deadline_ms','timeout_latched','abort_latched','signal_attempts','event_loop_condition','workspace_reuse','workspace_disposition','max_steps'];
const retentionKeys=['retention_status','rejection_stage','rejection_reason','exact_response_bytes','retained_bytes_count','retained_truncated','retention_error'];
const recordGenerationKeys=['record','runtime_evidence','diagnostic_retention'];
const projectedGenerationKeys=['lifecycle_status','task_class','requested_model','reported_model','process_exit','io_state','containment_evidence','provider_metadata','output_custody','task_outcome_evaluated','task_payload_valid','runtime_evidence','diagnostic_retention'];
const projectedLargeGenerationKeys=[
  'lifecycle_status','task_class','output_profile','requested_model','reported_model',
  'process_exit','io_state','containment_evidence','provider_metadata','output_custody',
  'task_outcome_evaluated','task_payload_valid','runtime_evidence','diagnostic_retention'
];

const reject=()=>{throw 0;};
const integer=v=>Number.isSafeInteger(v);
const nonnegative=v=>integer(v)&&v>=0;
const nullableNonnegative=v=>v===null||nonnegative(v);
const nullableExit=v=>v===null||integer(v);
const bool=v=>typeof v==='boolean';
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const model=v=>v==='gpt-6-luna'?'gpt-6-luna':UNKNOWN;
const validFinalReason=(value,observation=false)=>value===null||reasons.has(value)||
  observation&&value==='POST_GENERATION_CLOSEOUT_DEADLINE'||
  typeof value==='string'&&value.startsWith('STAGING:')&&stagingErrors.has(value.slice(8));

function closed(value,required,optional=[]){
  if(!value||typeof value!=='object'||Array.isArray(value))reject();
  const names=Object.keys(value);
  if(required.some(k=>!Object.hasOwn(value,k))||names.some(k=>!required.includes(k)&&!optional.includes(k)))reject();
}
function freeze(value){
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}
function invalidSummary(native=false,observation=false,largeObservation=false){
  if(native)return freeze({schema_version:largeObservation?PROJECT_LARGE_OBSERVATION_SUMMARY_SCHEMA:
    observation?PROJECT_CODING_OBSERVATION_SUMMARY_SCHEMA:NATIVE_SCHEMA,readiness:'INVALID_RECEIPT',
    diagnostic:{stage:'RECEIPT_VALIDATION',reason:'SCHEMA_MISMATCH'}});
  return freeze({
    schema_version:SCHEMA,readiness:'INVALID_RECEIPT',reason:null,
    task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,
    runtime_admitted_marker:false,operator_admitted_marker:false,has_operator_receipt:false,
    workspace_disposition:'UNKNOWN',descendant_guarantee:'NONE',
    direct_child_invocations:{generation:null},outer_observation_target_ms:TARGET_MS,
    event_loop_condition:EVENT_LOOP,generation:null,staging:null,
    diagnostic:{stage:'RECEIPT_VALIDATION',reason:'SCHEMA_MISMATCH'}
  });
}
function pairIsValid(stage,reason){
  if(stage===null||reason===null)return stage===null&&reason===null;
  if(!diagnosticPairs.some(([s,r])=>s===stage&&r===reason))return false;
  const safe=diagnosticReport(stage,reason);
  return safe.stage===stage&&safe.reason===reason;
}
function checkSignals(value){
  if(!Array.isArray(value)||value.length>64)reject();
  return value.map(item=>{
    closed(item,['signal','accepted'],['elapsed_ms']);
    if(!['SIGTERM','SIGKILL'].includes(item.signal)||!bool(item.accepted)||
       Object.hasOwn(item,'elapsed_ms')&&!nullableNonnegative(item.elapsed_ms))reject();
    return Object.hasOwn(item,'elapsed_ms')
      ?{signal:item.signal,accepted:item.accepted,elapsed_ms:item.elapsed_ms}
      :{signal:item.signal,accepted:item.accepted};
  });
}
function checkRuntime(value,lifecycle){
  closed(value,runtimeKeys);
  if(!nullableNonnegative(value.deadline_ms)||!bool(value.timeout_latched)||!bool(value.abort_latched)||
     value.event_loop_condition!==EVENT_LOOP||value.workspace_reuse!=='NOT_AUTHORIZED'||
     !['DEDICATED_NOT_REUSED','QUARANTINED'].includes(value.workspace_disposition)||
     value.max_steps!=='UNSUPPORTED')reject();
  if((lifecycle==='LIMITED_SUCCESS')!==(value.workspace_disposition==='DEDICATED_NOT_REUSED'))reject();
  if(lifecycle==='LIMITED_SUCCESS'&&(value.timeout_latched||value.abort_latched))reject();
  return {
    deadline_ms:value.deadline_ms,timeout_latched:value.timeout_latched,abort_latched:value.abort_latched,
    signal_attempts:checkSignals(value.signal_attempts),event_loop_condition:value.event_loop_condition,
    workspace_reuse:value.workspace_reuse,workspace_disposition:value.workspace_disposition,max_steps:value.max_steps
  };
}
function checkRetention(value){
  closed(value,retentionKeys);
  if(!retentionStatuses.has(value.retention_status)||!nullableNonnegative(value.exact_response_bytes)||
     !nullableNonnegative(value.retained_bytes_count)||!bool(value.retained_truncated)||
     value.retention_error!==null&&!retentionErrors.has(value.retention_error)||
     !pairIsValid(value.rejection_stage,value.rejection_reason))reject();
  return Object.fromEntries(retentionKeys.map(k=>[k,value[k]]));
}
function checkLargeRetention(value){
  const retention=checkRetention(value);
  const {
    retention_status:status,rejection_stage:stage,rejection_reason:reason,
    exact_response_bytes:exact,retained_bytes_count:retained,
    retained_truncated:truncated,retention_error:error
  }=retention;
  const eligibleReason=stage==='PAYLOAD'&&largeRetentionReasons.has(reason);
  const validExact=nonnegative(exact)&&exact<=1048576;
  const noCapture=stage===null&&reason===null&&exact===null&&retained===null&&
    truncated===false;
  const unretained=eligibleReason&&validExact&&retained===null&&truncated===false;
  switch(status){
    case 'NOT_REQUESTED':
      if(!noCapture||error!==null)reject();
      break;
    case 'NOT_ELIGIBLE':
      if((!noCapture&&
          (stage!=='PAYLOAD'||!largeRetentionReasons.has(reason)))||
         exact!==null||retained!==null||truncated||error!==null)reject();
      break;
    case 'REQUESTED':
      if(!unretained||error!==null)reject();
      break;
    case 'PUBLISHED':
      if(!eligibleReason||!validExact||
         retained!==Math.min(exact,65536)||truncated!==(exact>65536)||
         error!==null)reject();
      break;
    case 'FAILED':
      if(noCapture){
        if(error!=='RETENTION_INVALID_CAPTURE')reject();
      }else if(!unretained)reject();
      break;
    case 'UNKNOWN':
      if(!unretained)reject();
      break;
    default:
      reject();
  }
  return retention;
}
function projectRecordDiagnostic(errorDetails){
  if(Object.values(errorDetails).every(value=>value===null))return null;
  const code=errorDetails.code;
  if(typeof code==='string'){
    const parts=code.split(':');
    if(parts.length===2){
      try{
        const safe=diagnosticReport(parts[0],parts[1]);
        if(safe.stage===parts[0]&&safe.reason===parts[1])return {stage:safe.stage,reason:safe.reason};
      }catch{}
    }
  }
  return {stage:'UNCLASSIFIED',reason:'UNKNOWN_REJECTION'};
}
function projectGeneration(value){
  if(value===null)return null;
  closed(value,recordGenerationKeys);
  const record=validateLimitedJobRecord(value.record);
  if(record.task_class!=='PROJECT_CODEGEN_V1'||record.task_outcome_evaluated!==false)reject();
  const process=record.process_exit;
  const runtime=checkRuntime(value.runtime_evidence,record.lifecycle_status);
  const retention=checkRetention(value.diagnostic_retention);
  const metadata=record.provider_metadata;
  const tokens=metadata.usage_tokens;
  const providerStatus=metadata.provider_reported_status===null?null:
    providerStatuses.has(metadata.provider_reported_status)?metadata.provider_reported_status:UNKNOWN;
  const errorDetails=record.error_details;
  return {
    value:{
      lifecycle_status:record.lifecycle_status,
      task_class:'PROJECT_CODEGEN_V1',
      requested_model:model(record.requested_model),reported_model:model(record.reported_model),
      process_exit:{exit_code:process.exit_code,process_wall_ms:process.process_wall_ms,observed_termination:process.observed_termination},
      io_state:{stdout_bytes_observed:record.io_state.stdout_bytes_observed,stderr_bytes_observed:record.io_state.stderr_bytes_observed,stdout_eof:record.io_state.stdout_eof,stderr_eof:record.io_state.stderr_eof,io_drained:record.io_state.io_drained},
      containment_evidence:{containment_level:record.containment_evidence.containment_level,settlement_status:record.containment_evidence.settlement_status,descendant_guarantee:record.containment_evidence.descendant_guarantee},
      provider_metadata:{
        provider_reported_status:providerStatus,duration_seconds:metadata.duration_seconds,
        inference_duration_seconds:UNKNOWN,
        usage_tokens:Object.fromEntries(usageKeys.map(k=>[k,tokens[k]==='UNKNOWN'?null:tokens[k]])),
        codex_reasoning_output_tokens:metadata.codex_reasoning_output_tokens===undefined||metadata.codex_reasoning_output_tokens==='UNKNOWN'?null:metadata.codex_reasoning_output_tokens
      },
      output_custody:{persisted:record.output_custody.persisted,byte_count:record.output_custody.byte_count,envelope_sha256:UNKNOWN},
      task_outcome_evaluated:false,task_payload_valid:record.task_payload_valid,
      runtime_evidence:runtime,diagnostic_retention:retention
    },
    jobId:record.job_id,taskClass:record.task_class,rawRecord:record,
    diagnostic:projectRecordDiagnostic(errorDetails)
  };
}
function projectLargeGeneration(value){
  if(value===null)return null;
  closed(value,recordGenerationKeys);
  const record=validateLargeProjectJobRecord(value.record);
  if(record.task_class!==PROJECT_LARGE_OBSERVATION_TASK_CLASS||
     record.task_outcome_evaluated!==false)reject();
  const runtime=checkRuntime(value.runtime_evidence,record.lifecycle_status);
  const retention=checkLargeRetention(value.diagnostic_retention);
  const metadata=record.provider_metadata,tokens=metadata.usage_tokens;
  const providerStatus=metadata.provider_reported_status===null?null:
    providerStatuses.has(metadata.provider_reported_status)?metadata.provider_reported_status:UNKNOWN;
  return {
    value:{
      lifecycle_status:record.lifecycle_status,
      task_class:PROJECT_LARGE_OBSERVATION_TASK_CLASS,
      output_profile:PROJECT_OUTPUT_LARGE_PROFILE,
      requested_model:model(record.requested_model),reported_model:model(record.reported_model),
      process_exit:{
        exit_code:record.process_exit.exit_code,
        process_wall_ms:record.process_exit.process_wall_ms,
        observed_termination:record.process_exit.observed_termination
      },
      io_state:{
        stdout_bytes_observed:record.io_state.stdout_bytes_observed,
        stderr_bytes_observed:record.io_state.stderr_bytes_observed,
        stdout_eof:record.io_state.stdout_eof,
        stderr_eof:record.io_state.stderr_eof,
        io_drained:record.io_state.io_drained
      },
      containment_evidence:{
        containment_level:record.containment_evidence.containment_level,
        settlement_status:record.containment_evidence.settlement_status,
        descendant_guarantee:record.containment_evidence.descendant_guarantee
      },
      provider_metadata:{
        provider_reported_status:providerStatus,duration_seconds:metadata.duration_seconds,
        inference_duration_seconds:UNKNOWN,
        usage_tokens:Object.fromEntries(usageKeys.map(k=>[k,tokens[k]==='UNKNOWN'?null:tokens[k]])),
        codex_reasoning_output_tokens:
          metadata.codex_reasoning_output_tokens===undefined||
          metadata.codex_reasoning_output_tokens==='UNKNOWN'
            ?null:metadata.codex_reasoning_output_tokens
      },
      output_custody:{
        persisted:record.output_custody.persisted,
        byte_count:record.output_custody.byte_count,envelope_sha256:UNKNOWN
      },
      task_outcome_evaluated:false,task_payload_valid:record.task_payload_valid,
      runtime_evidence:runtime,diagnostic_retention:retention
    },
    jobId:record.job_id,taskClass:record.task_class,rawRecord:record,
    diagnostic:projectRecordDiagnostic(record.error_details)
  };
}
function projectStaging(value,jobId){
  if(value===null)return null;
  if(typeof jobId!=='string')reject();
  const keys=['schema_version','stage_operation_id','caller_label','completion_status','manifest_sha256','file_count','total_bytes','operation_acknowledgement','provenance_authenticity','crash_durability'];
  closed(value,keys);
  if(value.schema_version!=='squire4.stage_receipt.v1'||value.stage_operation_id!==`stage-${jobId}`||
     value.caller_label!=='project_candidate_stager'||value.completion_status!=='COMPLETE'||
     value.operation_acknowledgement!=='ACKNOWLEDGED'||!sha(value.manifest_sha256)||
     !integer(value.file_count)||value.file_count<1||value.file_count>50||
     !nonnegative(value.total_bytes)||value.total_bytes>1048576||
     value.provenance_authenticity!=='NOT_ESTABLISHED'||value.crash_durability!=='NOT_ESTABLISHED')reject();
  return {
    schema_version:value.schema_version,completion_status:value.completion_status,
    operation_acknowledgement:value.operation_acknowledgement,caller_label:value.caller_label,
    manifest_sha256:value.manifest_sha256,file_count:value.file_count,total_bytes:value.total_bytes,
    provenance_authenticity:value.provenance_authenticity,crash_durability:value.crash_durability
  };
}
function projectLargeStaging(value,jobId){
  if(value===null)return null;
  if(typeof jobId!=='string')reject();
  const keys=[
    'schema_version','output_profile','stage_operation_id','caller_label',
    'completion_status','manifest_sha256','file_count','total_bytes',
    'operation_acknowledgement','provenance_authenticity','crash_durability'
  ];
  closed(value,keys);
  const profile=validateProjectOutputLargeProfile(value.output_profile);
  if(value.schema_version!=='squire4.large_project_stage_receipt.v1'||
     value.stage_operation_id!==`stage-${jobId}`||value.caller_label!=='project_candidate_stager'||
     value.completion_status!=='COMPLETE'||value.operation_acknowledgement!=='ACKNOWLEDGED'||
     !sha(value.manifest_sha256)||!integer(value.file_count)||value.file_count<1||
     value.file_count>profile.max_all_files||!nonnegative(value.total_bytes)||
     value.total_bytes>profile.max_decoded_project_bytes||
     value.provenance_authenticity!=='NOT_ESTABLISHED'||
     value.crash_durability!=='NOT_ESTABLISHED')reject();
  return {
    schema_version:value.schema_version,output_profile:profile,
    completion_status:value.completion_status,
    operation_acknowledgement:value.operation_acknowledgement,
    caller_label:value.caller_label,manifest_sha256:value.manifest_sha256,
    file_count:value.file_count,total_bytes:value.total_bytes,
    provenance_authenticity:value.provenance_authenticity,
    crash_durability:value.crash_durability
  };
}
function category(lifecycle){
  if(lifecycle===null)return 'N';
  if(lifecycle==='LIMITED_SUCCESS')return 'S';
  if(lifecycle==='LIMITED_TIMEOUT'||lifecycle==='LIMITED_USER_ABORT')return 'T';
  return 'R';
}
function finalMatrix(status,reason,life,count,hasStaging){
  const c=category(life),stagingError=typeof reason==='string'&&reason.startsWith('STAGING:')&&stagingErrors.has(reason.slice(8));
  switch(status){
    case 'CANDIDATE_STAGED':return reason===null&&c==='S'&&count===1&&hasStaging;
    case 'GENERATION_REJECTED':return reason==='GENERATION_REJECTED'&&c==='R'&&!hasStaging;
    case 'STAGING_REJECTED':return stagingError&&c==='S'&&!hasStaging;
    case 'INCOMPLETE':
      if(reason==='GENERATION_REJECTED')return c==='T'&&!hasStaging;
      return (reason==='CANCELED'||reason==='OBSERVATION_DEADLINE')&&['N','T','R','S'].includes(c)&&(!hasStaging||c==='S');
    case 'FAILED':
      if(reason==='OPERATION_FAILED_OR_UNCERTAIN')return ['N','S'].includes(c)&&!hasStaging;
      if(reason==='CLEANUP_FAILED_OR_UNCERTAIN')return ['N','T','R','S'].includes(c)&&(!hasStaging||c==='S');
      return reason==='CLOCK_UNAVAILABLE'&&c==='S'&&hasStaging;
    default:return false;
  }
}
function noSpawnEvidence(generation,count){
  if(!generation||count!==0)return;
  const record=generation.rawRecord;
  const process=record.process_exit;
  if(process.pid!==null||process.observed_termination||process.exit_code!==null||process.exit_signal!==null||
     record.containment_evidence.settlement_status==='SETTLED_DIRECT_CHILD_EXIT')reject();
}
function checkObservationOutcome(status,reason,lifecycle,count,staging,closeout){
  return validateProjectCodingObservationOutcome({
    status,reason,lifecycle,generation_invocations:count,has_staging:staging!==null,
    post_generation_closeout:closeout
  });
}
function projectInput(value,native=false,observation=false){
  const raw=snapshotReceiptData(value);
  closed(raw,[...inputKeys,...(observation?['execution_profile','post_generation_closeout']:[])]);
  if(observation)validateProjectCodingObservationProfile(raw.execution_profile);
  const target=observation?null:TARGET_MS;
  if(raw.schema!==(observation?PROJECT_CODING_OBSERVATION_RESULT_SCHEMA:'SQUIRE2_PROJECT_RESULT_V1')||!statuses.has(raw.status)||
      !validFinalReason(raw.reason,observation)||observation&&raw.reason==='OBSERVATION_DEADLINE'||raw.task_correctness!=='NOT_EVALUATED'||
     raw.task_outcome_evaluated!==false||raw.runtime_admitted!==false||
     (native?!bool(raw.operator_admitted):raw.operator_admitted!==false)||
     raw.descendant_guarantee!=='NONE'||typeof raw.operator_receipt!=='string'||
     !['DEDICATED_NOT_REUSED','QUARANTINED'].includes(raw.workspace_disposition)||
     raw.outer_observation_target_ms!==target||raw.event_loop_condition!==EVENT_LOOP)reject();
  closed(raw.direct_child_invocations,['generation']);
  const count=raw.direct_child_invocations.generation;
  if(!integer(count)||count<0||count>1)reject();
  const generation=projectGeneration(raw.generation);
  const life=generation?.value.lifecycle_status??null;
  if(observation&&generation&&(generation.value.runtime_evidence.deadline_ms!==null||
     generation.value.runtime_evidence.timeout_latched||life==='LIMITED_TIMEOUT'))reject();
  const staging=projectStaging(raw.staging,generation?.jobId);
  if(raw.workspace_disposition!==(raw.status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED'))reject();
  if(generation?.taskClass==='PROJECT_CODEGEN_V1'&&life==='LIMITED_SPAWN_FAILED'&&count!==1)reject();
  noSpawnEvidence(generation,count);
  if(!observation&&!finalMatrix(raw.status,raw.reason,life,count,staging!==null))reject();
  const closeout=observation?checkObservationOutcome(raw.status,raw.reason,life,count,staging,raw.post_generation_closeout):null;
  const diagnostic=generation?.diagnostic??null;
  const hasOperatorReceipt=raw.operator_receipt.length>0;
  if(native)return freeze({
    schema_version:observation?PROJECT_CODING_OBSERVATION_SUMMARY_SCHEMA:NATIVE_SCHEMA,readiness:raw.status,reason:raw.reason,
    task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted_marker:false,
    operator_admission_claimed:raw.operator_admitted,admission_authority:'NOT_ESTABLISHED',
    has_operator_receipt:hasOperatorReceipt,
    workspace_disposition:raw.workspace_disposition,descendant_guarantee:'NONE',
    direct_child_invocations:{generation:count},outer_observation_target_ms:target,
    event_loop_condition:EVENT_LOOP,generation:generation?.value??null,staging,diagnostic,
    ...(observation?{execution_profile:PROJECT_CODING_OBSERVATION_PROFILE,post_generation_closeout:closeout}:{})
  });
  return freeze({
    schema_version:SCHEMA,readiness:raw.status,reason:raw.reason,
    task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,
    runtime_admitted_marker:false,operator_admitted_marker:false,
    has_operator_receipt:hasOperatorReceipt,
    workspace_disposition:raw.workspace_disposition,descendant_guarantee:'NONE',
    direct_child_invocations:{generation:count},outer_observation_target_ms:TARGET_MS,
    event_loop_condition:EVENT_LOOP,generation:generation?.value??null,staging,diagnostic
  });
}

function projectLargeInput(value){
  const raw=snapshotReceiptData(value);
  closed(raw,[...inputKeys,'execution_profile','output_profile','post_generation_closeout']);
  validateProjectCodingObservationProfile(raw.execution_profile);
  const outputProfile=validateProjectOutputLargeProfile(raw.output_profile);
  if(raw.schema!==PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA||!statuses.has(raw.status)||
     !validFinalReason(raw.reason,true)||raw.reason==='OBSERVATION_DEADLINE'||
     raw.task_correctness!=='NOT_EVALUATED'||raw.task_outcome_evaluated!==false||
     raw.runtime_admitted!==false||!bool(raw.operator_admitted)||
     raw.descendant_guarantee!=='NONE'||typeof raw.operator_receipt!=='string'||
     !['DEDICATED_NOT_REUSED','QUARANTINED'].includes(raw.workspace_disposition)||
     raw.outer_observation_target_ms!==null||raw.event_loop_condition!==EVENT_LOOP)reject();
  closed(raw.direct_child_invocations,['generation']);
  const count=raw.direct_child_invocations.generation;
  if(!integer(count)||count<0||count>1)reject();
  const generation=projectLargeGeneration(raw.generation);
  const lifecycle=generation?.value.lifecycle_status??null;
  if(generation&&(generation.value.runtime_evidence.deadline_ms!==null||
     generation.value.runtime_evidence.timeout_latched||lifecycle==='LIMITED_TIMEOUT'))reject();
  const staging=projectLargeStaging(raw.staging,generation?.jobId);
  if(raw.workspace_disposition!==(raw.status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED'))reject();
  if(generation?.taskClass===PROJECT_LARGE_OBSERVATION_TASK_CLASS&&
     lifecycle==='LIMITED_SPAWN_FAILED'&&count!==1)reject();
  noSpawnEvidence(generation,count);
  const closeout=checkObservationOutcome(
    raw.status,raw.reason,lifecycle,count,staging,raw.post_generation_closeout
  );
  const diagnostic=generation?.diagnostic??null;
  if(raw.operator_receipt.length>4096)reject();
  return freeze({
    schema_version:PROJECT_LARGE_OBSERVATION_SUMMARY_SCHEMA,
    readiness:raw.status,reason:raw.reason,
    task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,
    runtime_admitted_marker:false,operator_admission_claimed:raw.operator_admitted,
    admission_authority:'NOT_ESTABLISHED',has_operator_receipt:raw.operator_receipt.length>0,
    workspace_disposition:raw.workspace_disposition,descendant_guarantee:'NONE',
    direct_child_invocations:{generation:count},outer_observation_target_ms:null,
    event_loop_condition:EVENT_LOOP,generation:generation?.value??null,staging,diagnostic,
    execution_profile:PROJECT_CODING_OBSERVATION_PROFILE,
    output_profile:outputProfile,post_generation_closeout:closeout
  });
}

export function projectProjectRunSummary(value){
  try{return projectInput(value,false);}catch{return invalidSummary(false);}
}
export function projectNativeProjectRunSummary(savedEnvelope){
  try{
    const envelope=snapshotReceiptData(savedEnvelope);
    closed(envelope,['schema','result']);
    if(envelope.schema!=='SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1')reject();
    return projectInput(envelope.result,true);
  }catch{return invalidSummary(true);}
}
export function projectNativeProjectCodingObservationRunSummary(savedEnvelope){
  try{
    const envelope=snapshotReceiptData(savedEnvelope);
    closed(envelope,['schema','result']);
    if(envelope.schema!==PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA)reject();
    return projectInput(envelope.result,true,true);
  }catch{return invalidSummary(true,true);}
}
export function projectNativeProjectLargeObservationRunSummary(savedEnvelope){
  try{
    const envelope=snapshotReceiptData(savedEnvelope);
    closed(envelope,['schema','result']);
    if(envelope.schema!==PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA)reject();
    return projectLargeInput(envelope.result);
  }catch{return invalidSummary(true,false,true);}
}
const largeReceiptCounterPaths=new Set([
  ['result','generation','record','provider_metadata','usage_tokens','input'],
  ['result','generation','record','provider_metadata','usage_tokens','output'],
  ['result','generation','record','provider_metadata','usage_tokens','cache_read'],
  ['result','generation','record','provider_metadata','usage_tokens','thinking'],
  ['result','generation','record','provider_metadata','usage_tokens','total'],
  ['result','generation','record','provider_metadata','codex_reasoning_output_tokens']
].map(path=>JSON.stringify(path)));
function validLargeReceiptCounterLexemes(text){
  let index=0;
  const counters=[];
  const whitespace=()=>{while(index<text.length&&/[\x20\t\r\n]/.test(text[index]))index++;};
  function string(){
    if(text[index]!=='"')throw 0;
    const start=index++;
    while(index<text.length){
      if(text[index]==='\\'){index+=2;continue;}
      if(text[index]==='"'){
        index++;
        return JSON.parse(text.slice(start,index));
      }
      index++;
    }
    throw 0;
  }
  function value(path,depth){
    if(depth>10)throw 0;
    whitespace();
    const character=text[index];
    if(character==='"'){string();return;}
    if(character==='{'){
      index++;whitespace();
      if(text[index]==='}'){index++;return;}
      while(index<text.length){
        const key=string();
        whitespace();
        if(text[index++]!==':')throw 0;
        value([...path,key],depth+1);
        whitespace();
        const delimiter=text[index++];
        if(delimiter==='}')return;
        if(delimiter!==',')throw 0;
        whitespace();
      }
      throw 0;
    }
    if(character==='['){
      index++;whitespace();
      if(text[index]===']'){index++;return;}
      while(index<text.length){
        value([...path,'[]'],depth+1);
        whitespace();
        const delimiter=text[index++];
        if(delimiter===']')return;
        if(delimiter!==',')throw 0;
      }
      throw 0;
    }
    if(character==='-'||character>='0'&&character<='9'){
      const match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
      if(!match)throw 0;
      index+=match[0].length;
      if(largeReceiptCounterPaths.has(JSON.stringify(path)))counters.push(match[0]);
      return;
    }
    for(const literal of ['true','false','null']){
      if(text.startsWith(literal,index)){index+=literal.length;return;}
    }
    throw 0;
  }
  try{
    value([],0);
    whitespace();
    if(index!==text.length)return false;
    const max=String(Number.MAX_SAFE_INTEGER);
    return counters.every(counter=>
      /^(?:0|[1-9][0-9]*)$/.test(counter)&&
      (counter.length<max.length||
       counter.length===max.length&&counter<=max)
    );
  }catch{return false;}
}
export function projectNativeProjectLargeObservationReceiptBytesSummary(bytes){
  let copy=null;
  try{
    if(types.isProxy(bytes)||!types.isUint8Array(bytes))reject();
    const length=Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),'byteLength'
    ).get.call(bytes);
    if(length>REPORT_MAX_BYTES)reject();
    copy=new Uint8Array(length);
    Uint8Array.prototype.set.call(copy,bytes);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy);
    if(!validLargeReceiptCounterLexemes(text))reject();
    return projectNativeProjectLargeObservationRunSummary(parseReceiptJson(copy));
  }catch{return invalidSummary(true,false,true);}
  finally{copy?.fill(0);}
}

function validateProjectedRuntime(value,lifecycle){
  closed(value,runtimeKeys);
  if(!nullableNonnegative(value.deadline_ms)||!bool(value.timeout_latched)||!bool(value.abort_latched)||
     value.event_loop_condition!==EVENT_LOOP||value.workspace_reuse!=='NOT_AUTHORIZED'||
     !['DEDICATED_NOT_REUSED','QUARANTINED'].includes(value.workspace_disposition)||
     value.max_steps!=='UNSUPPORTED'||(lifecycle==='LIMITED_SUCCESS')!==(value.workspace_disposition==='DEDICATED_NOT_REUSED')||
     lifecycle==='LIMITED_SUCCESS'&&(value.timeout_latched||value.abort_latched))reject();
  checkSignals(value.signal_attempts);
}
function validateProjectedRetention(value){
  closed(value,retentionKeys);
  if(!retentionStatuses.has(value.retention_status)||!nullableNonnegative(value.exact_response_bytes)||
     !nullableNonnegative(value.retained_bytes_count)||!bool(value.retained_truncated)||
     value.retention_error!==null&&!retentionErrors.has(value.retention_error)||
     !pairIsValid(value.rejection_stage,value.rejection_reason))reject();
}
function validateProjectedGeneration(value){
  closed(value,projectedGenerationKeys);
  if(!lifecycleStatuses.has(value.lifecycle_status)||value.task_class!=='PROJECT_CODEGEN_V1'||
     !['gpt-6-luna',UNKNOWN].includes(value.requested_model)||
     !['gpt-6-luna',UNKNOWN].includes(value.reported_model)||value.task_outcome_evaluated!==false||
     value.task_payload_valid!==null&&!bool(value.task_payload_valid))reject();
  const p=value.process_exit;
  closed(p,['exit_code','process_wall_ms','observed_termination']);
  if(!nullableExit(p.exit_code)||!nullableNonnegative(p.process_wall_ms)||!bool(p.observed_termination)||
     !p.observed_termination&&p.exit_code!==null)reject();
  const io=value.io_state;
  closed(io,['stdout_bytes_observed','stderr_bytes_observed','stdout_eof','stderr_eof','io_drained']);
  if(!nonnegative(io.stdout_bytes_observed)||!nonnegative(io.stderr_bytes_observed)||
     ![io.stdout_eof,io.stderr_eof,io.io_drained].every(bool)||
     io.io_drained&&(!io.stdout_eof||!io.stderr_eof))reject();
  const containment=value.containment_evidence;
  closed(containment,['containment_level','settlement_status','descendant_guarantee']);
  if(containment.containment_level!=='DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING'||
     !settlementStatuses.has(containment.settlement_status)||containment.descendant_guarantee!=='NONE'||
     containment.settlement_status==='SETTLED_DIRECT_CHILD_EXIT'&&!p.observed_termination||
     containment.settlement_status==='ABANDONED_UNSETTLED'&&p.observed_termination)reject();
  const provider=value.provider_metadata;
  closed(provider,['provider_reported_status','duration_seconds','inference_duration_seconds','usage_tokens','codex_reasoning_output_tokens']);
  if(provider.provider_reported_status!==null&&!providerStatuses.has(provider.provider_reported_status)||
     provider.duration_seconds!==null&&(typeof provider.duration_seconds!=='number'||!Number.isFinite(provider.duration_seconds)||provider.duration_seconds<0)||
     provider.inference_duration_seconds!==UNKNOWN||provider.codex_reasoning_output_tokens!==null&&!nonnegative(provider.codex_reasoning_output_tokens))reject();
  const tokens=provider.usage_tokens;
  closed(tokens,usageKeys);
  if(usageKeys.some(k=>tokens[k]!==null&&!nonnegative(tokens[k])))reject();
  if(typeof provider.provider_reported_status==='string'&&provider.provider_reported_status.startsWith('turn.')&&
     (provider.duration_seconds!==null||tokens.thinking!==null||tokens.total!==null))reject();
  const custody=value.output_custody;
  closed(custody,['persisted','byte_count','envelope_sha256']);
  if(!bool(custody.persisted)||!nullableNonnegative(custody.byte_count)||custody.envelope_sha256!==UNKNOWN||
     custody.persisted&&custody.byte_count===null)reject();
  validateProjectedRuntime(value.runtime_evidence,value.lifecycle_status);
  validateProjectedRetention(value.diagnostic_retention);
  if(value.lifecycle_status==='LIMITED_SUCCESS'&&
     (!p.observed_termination||p.exit_code!==0||!io.io_drained||io.stdout_bytes_observed>1048576||
      io.stderr_bytes_observed>65536||provider.provider_reported_status!=='turn.completed'||
      tokens.thinking!==null||tokens.total!==null||value.task_payload_valid!==true||
      !custody.persisted||containment.settlement_status!=='SETTLED_DIRECT_CHILD_EXIT'))reject();
  if(value.lifecycle_status==='LIMITED_SUCCESS'&&
     (value.runtime_evidence.timeout_latched||value.runtime_evidence.abort_latched||
      value.runtime_evidence.workspace_disposition!=='DEDICATED_NOT_REUSED'))reject();
}
function validateProjectedLargeGeneration(value){
  closed(value,projectedLargeGenerationKeys);
  if(!lifecycleStatuses.has(value.lifecycle_status)||
     value.task_class!==PROJECT_LARGE_OBSERVATION_TASK_CLASS||
     validateProjectOutputLargeProfile(value.output_profile)!==PROJECT_OUTPUT_LARGE_PROFILE||
     !['gpt-6-luna',UNKNOWN].includes(value.requested_model)||
     !['gpt-6-luna',UNKNOWN].includes(value.reported_model)||
     value.task_outcome_evaluated!==false||
     value.task_payload_valid!==null&&!bool(value.task_payload_valid))reject();
  const process=value.process_exit;
  closed(process,['exit_code','process_wall_ms','observed_termination']);
  if(!nullableExit(process.exit_code)||!nullableNonnegative(process.process_wall_ms)||
     !bool(process.observed_termination)||!process.observed_termination&&process.exit_code!==null)reject();
  const io=value.io_state;
  closed(io,['stdout_bytes_observed','stderr_bytes_observed','stdout_eof','stderr_eof','io_drained']);
  if(!nonnegative(io.stdout_bytes_observed)||!nonnegative(io.stderr_bytes_observed)||
     ![io.stdout_eof,io.stderr_eof,io.io_drained].every(bool)||
     io.io_drained&&(!io.stdout_eof||!io.stderr_eof))reject();
  const containment=value.containment_evidence;
  closed(containment,['containment_level','settlement_status','descendant_guarantee']);
  if(containment.containment_level!=='DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING'||
     !settlementStatuses.has(containment.settlement_status)||containment.descendant_guarantee!=='NONE'||
     containment.settlement_status==='SETTLED_DIRECT_CHILD_EXIT'&&!process.observed_termination||
     containment.settlement_status==='ABANDONED_UNSETTLED'&&process.observed_termination)reject();
  const provider=value.provider_metadata;
  closed(provider,['provider_reported_status','duration_seconds','inference_duration_seconds',
    'usage_tokens','codex_reasoning_output_tokens']);
  if(provider.provider_reported_status!==null&&!providerStatuses.has(provider.provider_reported_status)||
     provider.duration_seconds!==null&&(typeof provider.duration_seconds!=='number'||
       !Number.isFinite(provider.duration_seconds)||provider.duration_seconds<0)||
     provider.inference_duration_seconds!==UNKNOWN||
     provider.codex_reasoning_output_tokens!==null&&
       !nonnegative(provider.codex_reasoning_output_tokens))reject();
  const tokens=provider.usage_tokens;
  closed(tokens,usageKeys);
  if(usageKeys.some(key=>tokens[key]!==null&&!nonnegative(tokens[key])))reject();
  if(typeof provider.provider_reported_status==='string'&&
     provider.provider_reported_status.startsWith('turn.')&&
     (provider.duration_seconds!==null||tokens.thinking!==null||tokens.total!==null))reject();
  const custody=value.output_custody;
  closed(custody,['persisted','byte_count','envelope_sha256']);
  if(!bool(custody.persisted)||!nullableNonnegative(custody.byte_count)||
     custody.byte_count!==null&&custody.byte_count>PROJECT_OUTPUT_LARGE_PROFILE.max_envelope_bytes||
     custody.envelope_sha256!==UNKNOWN||custody.persisted&&custody.byte_count===null)reject();
  validateProjectedRuntime(value.runtime_evidence,value.lifecycle_status);
  checkLargeRetention(value.diagnostic_retention);
  if(value.lifecycle_status==='LIMITED_SUCCESS'&&
     (!process.observed_termination||process.exit_code!==0||!io.io_drained||
      io.stdout_bytes_observed>PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes||
      io.stderr_bytes_observed>PROJECT_OUTPUT_LARGE_PROFILE.max_stderr_bytes||
      provider.provider_reported_status!=='turn.completed'||
      tokens.thinking!==null||tokens.total!==null||value.task_payload_valid!==true||
      !custody.persisted||containment.settlement_status!=='SETTLED_DIRECT_CHILD_EXIT'||
      value.runtime_evidence.timeout_latched||value.runtime_evidence.abort_latched||
      value.runtime_evidence.workspace_disposition!=='DEDICATED_NOT_REUSED'))reject();
}
function validateProjectedStaging(value){
  closed(value,['schema_version','completion_status','operation_acknowledgement','caller_label','manifest_sha256','file_count','total_bytes','provenance_authenticity','crash_durability']);
  if(value.schema_version!=='squire4.stage_receipt.v1'||value.completion_status!=='COMPLETE'||
     value.operation_acknowledgement!=='ACKNOWLEDGED'||value.caller_label!=='project_candidate_stager'||
     !sha(value.manifest_sha256)||!integer(value.file_count)||value.file_count<1||value.file_count>50||
     !nonnegative(value.total_bytes)||value.total_bytes>1048576||
     value.provenance_authenticity!=='NOT_ESTABLISHED'||value.crash_durability!=='NOT_ESTABLISHED')reject();
}
function validateProjectedLargeStaging(value){
  closed(value,['schema_version','output_profile','completion_status',
    'operation_acknowledgement','caller_label','manifest_sha256','file_count',
    'total_bytes','provenance_authenticity','crash_durability']);
  const profile=validateProjectOutputLargeProfile(value.output_profile);
  if(value.schema_version!=='squire4.large_project_stage_receipt.v1'||
     value.completion_status!=='COMPLETE'||value.operation_acknowledgement!=='ACKNOWLEDGED'||
     value.caller_label!=='project_candidate_stager'||!sha(value.manifest_sha256)||
     !integer(value.file_count)||value.file_count<1||value.file_count>profile.max_all_files||
     !nonnegative(value.total_bytes)||value.total_bytes>profile.max_decoded_project_bytes||
     value.provenance_authenticity!=='NOT_ESTABLISHED'||
     value.crash_durability!=='NOT_ESTABLISHED')reject();
}
function validateLargeSummary(value){
  if(value&&typeof value==='object'&&!Array.isArray(value)&&
     value.readiness==='INVALID_RECEIPT'){
    closed(value,['schema_version','readiness','diagnostic']);
    if(value.schema_version!==PROJECT_LARGE_OBSERVATION_SUMMARY_SCHEMA)reject();
    closed(value.diagnostic,['stage','reason']);
    if(value.diagnostic.stage!=='RECEIPT_VALIDATION'||
       value.diagnostic.reason!=='SCHEMA_MISMATCH')reject();
    return;
  }
  closed(value,largeNativeSummaryKeys);
  if(value.schema_version!==PROJECT_LARGE_OBSERVATION_SUMMARY_SCHEMA||
     !statuses.has(value.readiness)||!validFinalReason(value.reason,true)||
     value.reason==='OBSERVATION_DEADLINE'||value.task_correctness!=='NOT_EVALUATED'||
     value.task_outcome_evaluated!==false||value.runtime_admitted_marker!==false||
     !bool(value.operator_admission_claimed)||value.admission_authority!=='NOT_ESTABLISHED'||
     !bool(value.has_operator_receipt)||
     !['DEDICATED_NOT_REUSED','QUARANTINED'].includes(value.workspace_disposition)||
     value.descendant_guarantee!=='NONE'||value.outer_observation_target_ms!==null||
     value.event_loop_condition!==EVENT_LOOP)reject();
  validateProjectCodingObservationProfile(value.execution_profile);
  validateProjectOutputLargeProfile(value.output_profile);
  closed(value.direct_child_invocations,['generation']);
  const count=value.direct_child_invocations.generation;
  if(!integer(count)||count<0||count>1)reject();
  if(value.generation!==null)validateProjectedLargeGeneration(value.generation);
  if(value.staging!==null)validateProjectedLargeStaging(value.staging);
  const lifecycle=value.generation?.lifecycle_status??null;
  if(value.generation&&(value.generation.runtime_evidence.deadline_ms!==null||
     value.generation.runtime_evidence.timeout_latched||lifecycle==='LIMITED_TIMEOUT'))reject();
  checkObservationOutcome(value.readiness,value.reason,lifecycle,count,
    value.staging,value.post_generation_closeout);
  if(value.workspace_disposition!==
     (value.readiness==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED'))reject();
  if(lifecycle==='LIMITED_SPAWN_FAILED'&&count!==1)reject();
  if(count===0&&value.generation!==null){
    const process=value.generation.process_exit;
    if(process.observed_termination||process.exit_code!==null||
       value.generation.containment_evidence.settlement_status==='SETTLED_DIRECT_CHILD_EXIT')reject();
  }
  if(value.diagnostic!==null){
    closed(value.diagnostic,['stage','reason']);
    if(value.generation===null||value.diagnostic.stage===null||
       value.diagnostic.reason===null||
       !pairIsValid(value.diagnostic.stage,value.diagnostic.reason))reject();
  }
}
function validateSummary(value,native=false,observation=false){
  const nativeSchema=observation?PROJECT_CODING_OBSERVATION_SUMMARY_SCHEMA:NATIVE_SCHEMA;
  const target=observation?null:TARGET_MS;
  if(native&&value&&typeof value==='object'&&!Array.isArray(value)&&value.readiness==='INVALID_RECEIPT'){
    closed(value,['schema_version','readiness','diagnostic']);
    if(value.schema_version!==nativeSchema)reject();
    closed(value.diagnostic,['stage','reason']);
    if(value.diagnostic.stage!=='RECEIPT_VALIDATION'||value.diagnostic.reason!=='SCHEMA_MISMATCH')reject();
    return;
  }
  closed(value,[...(native?nativeSummaryKeys:summaryKeys),...(observation?['execution_profile','post_generation_closeout']:[])]);
  if(observation)validateProjectCodingObservationProfile(value.execution_profile);
  if(value.schema_version!==(native?nativeSchema:SCHEMA))reject();
  if(value.readiness==='INVALID_RECEIPT'){
    const d=value.diagnostic;
    closed(d,['stage','reason']);
    if(value.reason!==null||value.task_correctness!=='NOT_EVALUATED'||value.task_outcome_evaluated!==false||
       value.runtime_admitted_marker!==false||value.operator_admitted_marker!==false||value.has_operator_receipt!==false||
       value.workspace_disposition!=='UNKNOWN'||value.descendant_guarantee!=='NONE'||
       value.direct_child_invocations?.generation!==null||Object.keys(value.direct_child_invocations??{}).length!==1||
       value.outer_observation_target_ms!==TARGET_MS||value.event_loop_condition!==EVENT_LOOP||
       value.generation!==null||value.staging!==null||d.stage!=='RECEIPT_VALIDATION'||d.reason!=='SCHEMA_MISMATCH')reject();
    return;
  }
  if(!statuses.has(value.readiness)||!validFinalReason(value.reason,observation)||observation&&value.reason==='OBSERVATION_DEADLINE'||
     value.task_correctness!=='NOT_EVALUATED'||value.task_outcome_evaluated!==false||
     value.runtime_admitted_marker!==false||
     (native?(!bool(value.operator_admission_claimed)||value.admission_authority!=='NOT_ESTABLISHED'):value.operator_admitted_marker!==false)||
     !bool(value.has_operator_receipt)||!['DEDICATED_NOT_REUSED','QUARANTINED'].includes(value.workspace_disposition)||
     value.descendant_guarantee!=='NONE'||value.outer_observation_target_ms!==target||
     value.event_loop_condition!==EVENT_LOOP)reject();
  closed(value.direct_child_invocations,['generation']);
  const count=value.direct_child_invocations.generation;
  if(!integer(count)||count<0||count>1)reject();
  if(value.generation!==null)validateProjectedGeneration(value.generation);
  if(value.staging!==null)validateProjectedStaging(value.staging);
  const life=value.generation?.lifecycle_status??null;
  if(observation&&value.generation&&(value.generation.runtime_evidence.deadline_ms!==null||
     value.generation.runtime_evidence.timeout_latched||life==='LIMITED_TIMEOUT'))reject();
  if(observation)checkObservationOutcome(value.readiness,value.reason,life,count,value.staging,value.post_generation_closeout);
  if(!observation&&!finalMatrix(value.readiness,value.reason,life,count,value.staging!==null)||
     value.workspace_disposition!==(value.readiness==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED'))reject();
  if(value.generation?.lifecycle_status==='LIMITED_SPAWN_FAILED'&&count!==1)reject();
  if(count===0&&value.generation!==null){
    const p=value.generation.process_exit,c=value.generation.containment_evidence;
    if(p.observed_termination||p.exit_code!==null||c.settlement_status==='SETTLED_DIRECT_CHILD_EXIT')reject();
  }
  if(value.diagnostic!==null){
    closed(value.diagnostic,['stage','reason']);
    if(value.generation===null||value.diagnostic.stage===null||value.diagnostic.reason===null||
       !pairIsValid(value.diagnostic.stage,value.diagnostic.reason))reject();
  }
}

const INVALID_TEXT='Squire offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
const NATIVE_INVALID_TEXT='Squire native offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
const OBSERVATION_INVALID_TEXT='Squire native offline project coding observation result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
function formatProject(summary,native,observation=false){
  const invalidText=observation?OBSERVATION_INVALID_TEXT:native?NATIVE_INVALID_TEXT:INVALID_TEXT;
  try{
    const captured=snapshotReceiptData(summary);
    validateSummary(captured,native,observation);
    if(captured.readiness==='INVALID_RECEIPT')return invalidText;
    const g=captured.generation,p=g?.process_exit,m=g?.provider_metadata,c=g?.output_custody,s=captured.staging;
    const number=v=>v===null?'UNKNOWN':String(v);
    const yes=v=>v?'true':'false';
    const reason=captured.reason??'NONE';
    const diagnostic=captured.diagnostic===null?'NONE':`${captured.diagnostic.stage}/${captured.diagnostic.reason}`;
    const lines=[
      `${observation?'Squire native offline project coding observation result':native?'Squire native offline project result':'Squire offline project result'}: ${captured.readiness}`,
      ...(observation?[
        'Execution profile: PROJECT_CODING_OBSERVE_V1',
        'NO SQUIRE ELAPSED GENERATION CUTOFF; user cancellation available.',
        `Local closeout: ${captured.post_generation_closeout.status}; limit ms=20000 after generation.`,
        'External platform/provider limits: UNKNOWN; cost: UNKNOWN.'
      ]:[]),
      'Task correctness: NOT_EVALUATED',
      `Task outcome evaluated: ${yes(captured.task_outcome_evaluated)}`,
      `Reason: ${reason}`,
      `Generation: ${g?.lifecycle_status??'UNKNOWN'}`,
      `Requested model: ${g?.requested_model??'UNKNOWN'}; reported model: ${g?.reported_model??'UNKNOWN'}`,
      `Process exit code: ${number(p?.exit_code??null)}; wall ms: ${number(p?.process_wall_ms??null)}; observed termination: ${p?yes(p.observed_termination):'UNKNOWN'}`,
      `Provider status: ${m?.provider_reported_status??'UNKNOWN'}; provider duration seconds: ${number(m?.duration_seconds??null)}; inference duration seconds: UNKNOWN`,
      `Tokens: input=${number(m?.usage_tokens.input??null)}, output=${number(m?.usage_tokens.output??null)}, cache_read=${number(m?.usage_tokens.cache_read??null)}, thinking=${number(m?.usage_tokens.thinking??null)}, total=${number(m?.usage_tokens.total??null)}, codex_reasoning_output=${number(m?.codex_reasoning_output_tokens??null)}`,
      `Envelope custody: persisted=${c?yes(c.persisted):'UNKNOWN'}; bytes=${number(c?.byte_count??null)}; SHA-256=${c?.envelope_sha256??'UNKNOWN'}`,
      `Staging ACK history: ${s?.completion_status??'NONE'}; operation=${s?.operation_acknowledgement??'NONE'}; files=${number(s?.file_count??null)}; decoded bytes=${number(s?.total_bytes??null)}; manifest SHA-256=${s?.manifest_sha256??'UNKNOWN'}`,
      `Operator receipt present: ${yes(captured.has_operator_receipt)}; runtime admitted marker: false; ${native?`operator admission claimed: ${yes(captured.operator_admission_claimed)}; authority: ${captured.admission_authority}`:'operator admitted marker: false'}`,
      `Direct child invocations: generation=${countText(captured.direct_child_invocations.generation)}; observation target ms=${observation?'NONE':TARGET_MS}; event loop=${EVENT_LOOP}`,
      `Workspace: ${captured.workspace_disposition}; descendant guarantee: NONE`,
      `Diagnostic: ${diagnostic}`,
      'Recorded claims only; no task outcome, artifact, authorization, or execution re-verification.'
    ];
    const output=lines.join('\n')+'\n';
    if(!/^[\x20-\x7e\n]+$/.test(output))return invalidText;
    if(native&&new TextEncoder().encode(output).length>8192)return invalidText;
    return output;
  }catch{return invalidText;}
}
export function formatProjectSummaryTerminal(summary){return formatProject(summary,false);}
export function formatNativeProjectSummaryTerminal(summary){return formatProject(summary,true);}
export function formatNativeProjectCodingObservationSummaryTerminal(summary){return formatProject(summary,true,true);}
export function formatNativeProjectLargeObservationSummaryTerminal(summary){
  const invalidText='Squire native offline project large observation result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
  try{
    const captured=snapshotReceiptData(summary);
    validateLargeSummary(captured);
    if(captured.readiness==='INVALID_RECEIPT')return invalidText;
    const generation=captured.generation,process=generation?.process_exit;
    const metadata=generation?.provider_metadata,custody=generation?.output_custody;
    const staging=captured.staging;
    const number=value=>value===null?'UNKNOWN':String(value);
    const yes=value=>value?'true':'false';
    const diagnostic=captured.diagnostic===null?'NONE':
      `${captured.diagnostic.stage}/${captured.diagnostic.reason}`;
    const lines=[
      `Squire native offline project large observation result: ${captured.readiness}`,
      'Execution profile: PROJECT_CODING_OBSERVE_V1; no Squire elapsed generation cutoff; user cancellation available.',
      'Output profile: PROJECT_OUTPUT_LARGE_V1.',
      `Protective ceilings: stdout=${PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes} bytes; stderr=${PROJECT_OUTPUT_LARGE_PROFILE.max_stderr_bytes} bytes; envelope=${PROJECT_OUTPUT_LARGE_PROFILE.max_envelope_bytes} bytes; source file=${PROJECT_OUTPUT_LARGE_PROFILE.max_source_file_bytes} bytes; source total=${PROJECT_OUTPUT_LARGE_PROFILE.max_source_total_bytes} bytes; decoded project=${PROJECT_OUTPUT_LARGE_PROFILE.max_decoded_project_bytes} bytes; source files=${PROJECT_OUTPUT_LARGE_PROFILE.max_source_files}; all files=${PROJECT_OUTPUT_LARGE_PROFILE.max_all_files}.`,
      'Ceilings are protective parser, collector, and staging bounds; they are not a provider output guarantee or a hard RSS quota.',
      `Local closeout: ${captured.post_generation_closeout.status}; limit ms=20000 after generation.`,
      'External provider limits: UNKNOWN; cost: UNKNOWN.',
      'Task correctness: NOT_EVALUATED; task outcome evaluated: false.',
      `Reason: ${captured.reason??'NONE'}`,
      `Generation: ${generation?.lifecycle_status??'UNKNOWN'}; task class: ${generation?.task_class??'UNKNOWN'}.`,
      `Requested model: ${generation?.requested_model??'UNKNOWN'}; reported model: ${generation?.reported_model??'UNKNOWN'}.`,
      `Process exit code: ${number(process?.exit_code??null)}; wall ms: ${number(process?.process_wall_ms??null)}; observed termination: ${process?yes(process.observed_termination):'UNKNOWN'}.`,
      `Provider status: ${metadata?.provider_reported_status??'UNKNOWN'}; provider duration seconds: ${number(metadata?.duration_seconds??null)}; inference duration: UNKNOWN.`,
      `Tokens: input=${number(metadata?.usage_tokens.input??null)}, output=${number(metadata?.usage_tokens.output??null)}, cache_read=${number(metadata?.usage_tokens.cache_read??null)}, thinking=${number(metadata?.usage_tokens.thinking??null)}, total=${number(metadata?.usage_tokens.total??null)}, codex reasoning=${number(metadata?.codex_reasoning_output_tokens??null)}.`,
      `Observed output bytes: stdout=${number(generation?.io_state.stdout_bytes_observed??null)}; stderr=${number(generation?.io_state.stderr_bytes_observed??null)}; persisted envelope=${number(custody?.byte_count??null)}; persisted=${custody?yes(custody.persisted):'UNKNOWN'}.`,
      `Large staging ACK: ${staging?.completion_status??'NONE'}; operation=${staging?.operation_acknowledgement??'NONE'}; files=${number(staging?.file_count??null)}; decoded bytes=${number(staging?.total_bytes??null)}; manifest SHA-256=${staging?.manifest_sha256??'UNKNOWN'}.`,
      `Claimed operator admission: ${yes(captured.operator_admission_claimed)}; authority: NOT_ESTABLISHED; operator receipt present: ${yes(captured.has_operator_receipt)}.`,
      `Generation invocations: ${countText(captured.direct_child_invocations.generation)}; elapsed generation target: NONE; event loop: ${EVENT_LOOP}.`,
      `Workspace: ${captured.workspace_disposition}; descendant guarantee: NONE.`,
      `Diagnostic: ${diagnostic}`,
      'Recorded claims only; no task outcome, artifact, authorization, or execution re-verification.'
    ];
    const output=lines.join('\n')+'\n';
    if(!/^[\x20-\x7e\n]+$/.test(output)||new TextEncoder().encode(output).length>8192)return invalidText;
    return output;
  }catch{return invalidText;}
}
function countText(value){return value===null?'UNKNOWN':String(value);}
