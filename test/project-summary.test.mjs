import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProjectRunSummary,formatProjectSummaryTerminal} from '../src/project-summary.mjs';
import {runOfflineReportCli} from '../bin/squire-report.mjs';
import {REPORT_MAX_BYTES} from '../src/offline-run-summary.mjs';
import {validateLimitedJobRecord} from '../src/limited-job-record.mjs';

const jobId='ba586107-7240-4d89-88d3-d71005bce32f';
const digest='a'.repeat(64);
const invalidTerminal='Squire offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
const encode=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));

function record(lifecycle='LIMITED_SUCCESS'){
  const success=lifecycle==='LIMITED_SUCCESS';
  const timed=['LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(lifecycle);
  return {
    job_id:jobId,task_class:'PROJECT_CODEGEN_V1',lifecycle_status:lifecycle,
    requested_model:'gpt-6-luna',reported_model:'PRIVATE_MODEL_SENTINEL',
    process_exit:{pid:success?41:null,exit_code:success?0:timed?null:1,exit_signal:null,process_wall_ms:0,observed_termination:!timed},
    io_state:{stdout_bytes_observed:success?100:0,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},
    containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:success||!timed?'SETTLED_DIRECT_CHILD_EXIT':'ABANDONED_UNSETTLED',descendant_guarantee:'NONE'},
    provider_metadata:{provider_reported_status:success?'turn.completed':timed?'turn.failed':'ERROR',duration_seconds:null,usage_tokens:{input:0,output:8,cache_read:0,thinking:'UNKNOWN',total:'UNKNOWN'}},
    output_custody:{persisted:success,path:'/PRIVATE_SENTINEL/envelope.json',byte_count:success?100:null,persistence_error:null},
    task_outcome_evaluated:false,task_payload_valid:success?true:false,
    error_details:{code:null,classification:null,message:null}
  };
}
function generation(lifecycle='LIMITED_SUCCESS'){
  return {
    record:record(lifecycle),
    runtime_evidence:{deadline_ms:120000,timeout_latched:false,abort_latched:false,signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:lifecycle==='LIMITED_SUCCESS'?'DEDICATED_NOT_REUSED':'QUARANTINED',max_steps:'UNSUPPORTED'},
    diagnostic_retention:{retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,exact_response_bytes:null,retained_bytes_count:null,retained_truncated:false,retention_error:null}
  };
}
function ack(){
  return {schema_version:'squire4.stage_receipt.v1',stage_operation_id:`stage-${jobId}`,caller_label:'project_candidate_stager',completion_status:'COMPLETE',manifest_sha256:digest,file_count:1,total_bytes:0,operation_acknowledgement:'ACKNOWLEDGED',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'};
}
function receipt(status='CANDIDATE_STAGED',reason=null,gen=generation(),count=1,staging=ack()){
  return {schema:'SQUIRE2_PROJECT_RESULT_V1',status,reason,generation:gen,staging,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,operator_admitted:false,workspace_disposition:status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE',operator_receipt:'/PRIVATE_SENTINEL/operator-receipt',direct_child_invocations:{generation:count},outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'};
}
function clone(value){return structuredClone(value);}
async function cli(value,{bytes=encode(value)}={}){
  let out='',err='',statCalls=0,readCalls=0;
  const path='/PRIVATE_SENTINEL/receipt.json';
  const code=await runOfflineReportCli([path],{
    stat:async()=>{statCalls++;return {isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length};},
    readFile:async()=>{readCalls++;return bytes;},
    stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}
  });
  return {code,out,err,statCalls,readCalls,path};
}

test('projects a staged result as frozen recorded claims and formats finite output',()=>{
  const summary=projectProjectRunSummary(receipt());
  assert.equal(summary.readiness,'CANDIDATE_STAGED');
  assert.equal(summary.task_correctness,'NOT_EVALUATED');
  assert.equal(summary.task_outcome_evaluated,false);
  assert.equal(summary.generation.requested_model,'gpt-6-luna');
  assert.equal(summary.generation.task_class,'PROJECT_CODEGEN_V1');
  assert.equal(summary.generation.reported_model,'UNKNOWN');
  assert.equal(summary.generation.provider_metadata.usage_tokens.input,0);
  assert.equal(summary.generation.provider_metadata.usage_tokens.thinking,null);
  assert.equal(summary.generation.provider_metadata.inference_duration_seconds,'UNKNOWN');
  assert.equal(summary.generation.output_custody.envelope_sha256,'UNKNOWN');
  assert.equal(summary.staging.total_bytes,0);
  assert.equal(Object.hasOwn(summary.staging,'stage_operation_id'),false);
  assert.equal(Object.hasOwn(summary.generation.process_exit,'pid'),false);
  assert.equal(Object.isFrozen(summary.generation.runtime_evidence.signal_attempts),true);
  assert.equal(Object.isFrozen(summary.staging),true);
  const terminal=formatProjectSummaryTerminal(summary);
  assert.match(terminal,/Task correctness: NOT_EVALUATED/);
  assert.match(terminal,/Staging ACK history: COMPLETE/);
  assert.match(terminal,/inference duration seconds: UNKNOWN/);
  assert.doesNotMatch(terminal,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
  assert.doesNotMatch(terminal,/\x1b|\0|[^\x20-\x7e\n]/);
});

test('accepts all eight finite PR184 final-status/reason rows',()=>{
  const rows=[
    receipt('CANDIDATE_STAGED',null,generation(),1,ack()),
    receipt('GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_PROCESS_FAILED'),1,null),
    receipt('STAGING_REJECTED','STAGING:DESTINATION_ALREADY_EXISTS',generation(),1,null),
    receipt('INCOMPLETE','GENERATION_REJECTED',generation('LIMITED_TIMEOUT'),0,null),
    receipt('INCOMPLETE','CANCELED',null,0,null),
    receipt('FAILED','OPERATION_FAILED_OR_UNCERTAIN',null,0,null),
    receipt('FAILED','CLEANUP_FAILED_OR_UNCERTAIN',generation(),1,ack()),
    receipt('FAILED','CLOCK_UNAVAILABLE',generation(),1,ack()),
    receipt('INCOMPLETE','OBSERVATION_DEADLINE',generation('LIMITED_USER_ABORT'),0,null)
  ];
  for(const value of rows)assert.notEqual(projectProjectRunSummary(value).readiness,'INVALID_RECEIPT');
});

test('accepts only finite staging rejection reasons across projection, formatter, and CLI',async()=>{
  const reason='STAGING:DESTINATION_ALREADY_EXISTS';
  const value=receipt('STAGING_REJECTED',reason,generation(),1,null);
  const summary=projectProjectRunSummary(value);
  assert.equal(summary.readiness,'STAGING_REJECTED');
  assert.equal(summary.reason,reason);
  assert.match(formatProjectSummaryTerminal(summary),/Reason: STAGING:DESTINATION_ALREADY_EXISTS/);
  const reported=await cli(value);
  assert.equal(reported.code,1);
  assert.match(reported.out,/Squire offline project result: STAGING_REJECTED/);
  assert.match(reported.out,/Reason: STAGING:DESTINATION_ALREADY_EXISTS/);

  const invalidText='Squire offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
  for(const invalidReason of ['STAGING:UNKNOWN_CODE','STAGINGX:DESTINATION_ALREADY_EXISTS']){
    const invalid=receipt('STAGING_REJECTED',invalidReason,generation(),1,null);
    assert.equal(projectProjectRunSummary(invalid).readiness,'INVALID_RECEIPT');
    const forged=clone(summary);forged.reason=invalidReason;
    assert.equal(formatProjectSummaryTerminal(forged),invalidText);
    const rejected=await cli(invalid);
    assert.equal(rejected.code,2);
    assert.equal(rejected.err,'SCHEMA_MISMATCH\n');
  }
});

test('retains ACK history after allowed later cancellation or cleanup failure',()=>{
  for(const [status,reason] of [['INCOMPLETE','CANCELED'],['INCOMPLETE','OBSERVATION_DEADLINE'],['FAILED','CLEANUP_FAILED_OR_UNCERTAIN']]){
    const summary=projectProjectRunSummary(receipt(status,reason,generation(),1,ack()));
    assert.notEqual(summary.readiness,'INVALID_RECEIPT');
    assert.equal(summary.staging.operation_acknowledgement,'ACKNOWLEDGED');
    assert.equal(summary.task_correctness,'NOT_EVALUATED');
  }
});

test('rejects status, reason, invocation, and private ACK-binding contradictions',()=>{
  const mutations=[
    r=>{r.reason='PRIVATE_UNKNOWN_REASON';},
    r=>{r.generation.record.task_class='PRIVATE_TASK_CLASS';},
    r=>{r.status='CANDIDATE_STAGED';r.reason='CANCELED';},
    r=>{r.direct_child_invocations.generation=2;},
    r=>{r.staging.stage_operation_id='stage-wrong';},
    r=>{r.generation.record.lifecycle_status='LIMITED_SPAWN_FAILED';r.direct_child_invocations.generation=0;r.generation.record.process_exit={pid:null,exit_code:null,exit_signal:null,process_wall_ms:null,observed_termination:false};r.generation.record.containment_evidence.settlement_status='ABANDONED_UNSETTLED';r.generation.record.output_custody={persisted:false,path:null,byte_count:null,persistence_error:null};r.generation.record.task_payload_valid=false;r.generation.runtime_evidence.workspace_disposition='QUARANTINED';r.status='GENERATION_REJECTED';r.reason='GENERATION_REJECTED';r.staging=null;r.workspace_disposition='QUARANTINED';},
    r=>{r.direct_child_invocations.generation=0;r.generation.record.process_exit.pid=null;}
  ];
  for(const mutate of mutations){const value=receipt();mutate(value);assert.equal(projectProjectRunSummary(value).readiness,'INVALID_RECEIPT');}
});

test('allows null generation with a recorded invocation count of one',()=>{
  const summary=projectProjectRunSummary(receipt('INCOMPLETE','CANCELED',null,1,null));
  assert.equal(summary.readiness,'INCOMPLETE');
  assert.equal(summary.generation,null);
  assert.equal(summary.direct_child_invocations.generation,1);
});

test('accepts zero-byte ACK totals and inclusive staging limits, rejects overflow',()=>{
  const maximum=receipt();maximum.staging.file_count=50;maximum.staging.total_bytes=1048576;
  assert.notEqual(projectProjectRunSummary(maximum).readiness,'INVALID_RECEIPT');
  for(const [field,value] of [['file_count',51],['total_bytes',1048577]]){
    const bad=receipt();bad.staging[field]=value;
    assert.equal(projectProjectRunSummary(bad).readiness,'INVALID_RECEIPT');
  }
});

test('validates retention pairs and keeps raw diagnostic fallback distinct',()=>{
  const value=receipt('GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_PARSER_ERROR'),1,null);
  value.generation.record.task_payload_valid=false;
  value.generation.record.error_details={code:'PAYLOAD:PROJECT_PAYLOAD_TOO_SMALL',classification:'PRIVATE_CLASS',message:'PRIVATE_ERROR'};
  value.generation.diagnostic_retention={retention_status:'FAILED',rejection_stage:'PAYLOAD',rejection_reason:'PROJECT_PAYLOAD_TOO_SMALL',exact_response_bytes:0,retained_bytes_count:0,retained_truncated:false,retention_error:'RETENTION_IO_FAILED'};
  const summary=projectProjectRunSummary(value);
  assert.deepEqual(summary.diagnostic,{stage:'PAYLOAD',reason:'PROJECT_PAYLOAD_TOO_SMALL'});
  assert.equal(summary.generation.diagnostic_retention.exact_response_bytes,0);
  value.generation.record.error_details={code:'PRIVATE:PRIVATE',classification:'PRIVATE_CLASS',message:'PRIVATE_ERROR'};
  const fallback=projectProjectRunSummary(value);
  assert.deepEqual(fallback.diagnostic,{stage:'UNCLASSIFIED',reason:'UNKNOWN_REJECTION'});
  value.generation.diagnostic_retention.rejection_reason=null;
  assert.equal(projectProjectRunSummary(value).readiness,'INVALID_RECEIPT');
  value.generation.diagnostic_retention.rejection_stage=null;
  assert.notEqual(projectProjectRunSummary(value).readiness,'INVALID_RECEIPT');
});

test('rejects callable raw-wrapper fields, getters, proxies, cycles, and sparse nested arrays without callbacks',()=>{
  let called=0;
  const getter=receipt();Object.defineProperty(getter,'status',{get(){called++;throw 0;}});
  assert.equal(projectProjectRunSummary(getter).readiness,'INVALID_RECEIPT');
  const proxy=new Proxy({}, {get(){called++;throw 0;},ownKeys(){called++;throw 0;}});
  assert.equal(projectProjectRunSummary(proxy).readiness,'INVALID_RECEIPT');
  const cyclic=receipt();cyclic.self=cyclic;
  assert.equal(projectProjectRunSummary(cyclic).readiness,'INVALID_RECEIPT');
  const sparse=receipt();sparse.generation.runtime_evidence.signal_attempts.length=1;
  assert.equal(projectProjectRunSummary(sparse).readiness,'INVALID_RECEIPT');
  const callable=receipt();callable.generation.late_observations=()=>{called++;};
  assert.equal(projectProjectRunSummary(callable).readiness,'INVALID_RECEIPT');
  assert.equal(called,0);
});

test('formatter rejects forged, malformed, and private-extra projected summaries',()=>{
  const valid=projectProjectRunSummary(receipt());
  const malformed=clone(valid);malformed.generation.runtime_evidence.max_steps='PRIVATE';
  const extra=clone(valid);extra.private_path='/PRIVATE_SENTINEL/path';
  const contradictory=clone(valid);contradictory.staging=null;
  const forgedTaskClass=clone(valid);forgedTaskClass.generation.task_class='PRIVATE_TASK_CLASS';
  const missingTaskClass=clone(valid);delete missingTaskClass.generation.task_class;
  const nullDiagnostic=clone(valid);nullDiagnostic.diagnostic={stage:null,reason:null};
  const halfNullDiagnostic=clone(valid);halfNullDiagnostic.diagnostic={stage:'UNCLASSIFIED',reason:null};
  const noGeneration=projectProjectRunSummary(receipt('INCOMPLETE','CANCELED',null,0,null));
  const orphanedDiagnostic=clone(noGeneration);orphanedDiagnostic.diagnostic={stage:'UNCLASSIFIED',reason:'UNKNOWN_REJECTION'};
  for(const value of [malformed,extra,contradictory,forgedTaskClass,missingTaskClass,nullDiagnostic,halfNullDiagnostic,orphanedDiagnostic,{schema_version:'squire2.project_summary.v1',readiness:'CANDIDATE_STAGED'}]){
    assert.equal(formatProjectSummaryTerminal(value),'Squire offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n');
  }
});

test('CLI reads one explicit receipt and always returns non-success for valid project claims',async()=>{
  const good=await cli(receipt());
  assert.equal(good.code,1);
  assert.equal(good.statCalls,1);
  assert.equal(good.readCalls,1);
  assert.match(good.out,/CANDIDATE_STAGED/);
  assert.doesNotMatch(good.out+good.err,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
  const badValue=receipt();badValue.unlisted='PRIVATE_SENTINEL';
  const bad=await cli(badValue);
  assert.equal(bad.code,2);
  assert.equal(bad.readCalls,1);
  assert.equal(bad.err,'SCHEMA_MISMATCH\n');
});

test('CLI duplicate-key parser failures stay bounded and use fixed invalid reporting',async()=>{
  const duplicate=await cli(null,{bytes:encode('{"schema":"SQUIRE2_PROJECT_RESULT_V1","schema":"SQUIRE2_PROJECT_RESULT_V1"}')});
  assert.equal(duplicate.code,2);
  assert.equal(duplicate.readCalls,1);
  assert.doesNotMatch(duplicate.out+duplicate.err,/PRIVATE_SENTINEL/);
  assert.equal(REPORT_MAX_BYTES,262144);
});

test('existing dry-run campaign and SINGLE_JS CLI dispatch remain non-success reports',async()=>{
  const campaign=await cli({status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0});
  assert.equal(campaign.code,1);
  const single=await cli({schema:'SQUIRE2_SINGLE_JS_DRY_RUN_V1',status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0,task_correctness:'NOT_EVALUATED',runtime_admitted:false});
  assert.equal(single.code,1);
});

function assertProjectAndFormatterReject(mutate){
  const input=receipt();
  mutate(input.generation);
  assert.equal(projectProjectRunSummary(input).readiness,'INVALID_RECEIPT');

  const forged=clone(projectProjectRunSummary(receipt()));
  mutate(forged.generation);
  assert.equal(formatProjectSummaryTerminal(forged),invalidTerminal);
}

test('isolates the project task-class restriction from the legacy record validator and formatter',()=>{
  const legacy=record();
  legacy.task_class='SINGLE_JS_CODEGEN_V1';
  assert.equal(validateLimitedJobRecord(legacy).task_class,'SINGLE_JS_CODEGEN_V1');
  assert.equal(projectProjectRunSummary(receipt()).readiness,'CANDIDATE_STAGED');

  const nonProject=receipt();
  nonProject.generation.record.task_class=legacy.task_class;
  assert.equal(projectProjectRunSummary(nonProject).readiness,'INVALID_RECEIPT');

  const forged=clone(projectProjectRunSummary(receipt()));
  forged.generation.task_class=legacy.task_class;
  assert.equal(formatProjectSummaryTerminal(forged),invalidTerminal);
});

test('rejects invalid runtime and retention counters in projection and formatter',()=>{
  const setters=[
    (g,value)=>{g.runtime_evidence.deadline_ms=value;},
    (g,value)=>{g.runtime_evidence.signal_attempts=[{signal:'SIGTERM',accepted:false,elapsed_ms:value}];},
    (g,value)=>{g.diagnostic_retention.exact_response_bytes=value;},
    (g,value)=>{g.diagnostic_retention.retained_bytes_count=value;}
  ];
  for(const value of [-1,0.5,Number.MAX_SAFE_INTEGER+1]){
    for(const setValue of setters)assertProjectAndFormatterReject(g=>setValue(g,value));
  }

  const zero=receipt();
  zero.generation.runtime_evidence.deadline_ms=0;
  zero.generation.runtime_evidence.signal_attempts=[{signal:'SIGTERM',accepted:false,elapsed_ms:0}];
  zero.generation.diagnostic_retention.exact_response_bytes=0;
  zero.generation.diagnostic_retention.retained_bytes_count=0;
  const zeroSummary=projectProjectRunSummary(zero);
  assert.equal(zeroSummary.generation.runtime_evidence.deadline_ms,0);
  assert.equal(zeroSummary.generation.runtime_evidence.signal_attempts[0].elapsed_ms,0);
  assert.equal(zeroSummary.generation.diagnostic_retention.exact_response_bytes,0);
  assert.equal(zeroSummary.generation.diagnostic_retention.retained_bytes_count,0);
  assert.notEqual(formatProjectSummaryTerminal(zeroSummary),invalidTerminal);

  const nullable=receipt();
  nullable.generation.runtime_evidence.deadline_ms=null;
  nullable.generation.runtime_evidence.signal_attempts=[{signal:'SIGTERM',accepted:false,elapsed_ms:null}];
  nullable.generation.diagnostic_retention.exact_response_bytes=null;
  nullable.generation.diagnostic_retention.retained_bytes_count=null;
  const nullableSummary=projectProjectRunSummary(nullable);
  assert.equal(nullableSummary.generation.runtime_evidence.deadline_ms,null);
  assert.equal(nullableSummary.generation.runtime_evidence.signal_attempts[0].elapsed_ms,null);
  assert.equal(nullableSummary.generation.diagnostic_retention.exact_response_bytes,null);
  assert.equal(nullableSummary.generation.diagnostic_retention.retained_bytes_count,null);
  assert.notEqual(formatProjectSummaryTerminal(nullableSummary),invalidTerminal);
});

test('rejects mismatched known diagnostic retention pairs in projection and formatter',()=>{
  const setPair=(g,stage,reason)=>{
    g.diagnostic_retention.rejection_stage=stage;
    g.diagnostic_retention.rejection_reason=reason;
  };
  for(const [stage,reason] of [['ENVELOPE','PROJECT_PATH_INVALID'],['PAYLOAD','MALFORMED_JSON']]){
    assertProjectAndFormatterReject(g=>setPair(g,stage,reason));
  }

  const valid=receipt();
  setPair(valid.generation,'PAYLOAD','PROJECT_PATH_INVALID');
  const validSummary=projectProjectRunSummary(valid);
  assert.equal(validSummary.readiness,'CANDIDATE_STAGED');
  assert.equal(validSummary.generation.diagnostic_retention.rejection_stage,'PAYLOAD');
  assert.equal(validSummary.generation.diagnostic_retention.rejection_reason,'PROJECT_PATH_INVALID');
  assert.notEqual(formatProjectSummaryTerminal(validSummary),invalidTerminal);

  const nullPair=projectProjectRunSummary(receipt());
  assert.equal(nullPair.generation.diagnostic_retention.rejection_stage,null);
  assert.equal(nullPair.generation.diagnostic_retention.rejection_reason,null);
  assert.notEqual(formatProjectSummaryTerminal(nullPair),invalidTerminal);
});
