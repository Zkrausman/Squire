import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {projectRunSummary,formatSummaryTerminal,parseReceiptJson,REPORT_MAX_BYTES,OFFLINE_REPORT_REJECTION_CODES} from '../src/offline-run-summary.mjs';
import {runOfflineReportCli,readReceiptBytes,serializeOfflineReportCapabilities,writeOfflineReportCapabilities} from '../bin/squire-report.mjs';
import {projectNativeProjectLargeObservationRunSummary,projectNativeProjectLargeObservationReceiptBytesSummary,formatNativeProjectLargeObservationSummaryTerminal} from '../src/project-summary.mjs';
import {PROJECT_CODING_OBSERVATION_PROFILE,PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA,PROJECT_LARGE_OBSERVATION_TASK_CLASS,PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';

const encode=v=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const digest='a'.repeat(64),path='/PUBLIC_SYNTHETIC/workspace/src/summarizer.mjs';
const notRun=()=>Array.from({length:17},(_,i)=>({fixture_id:`FIX-${String(i+1).padStart(2,'0')}`,status:'NOT_RUN'}));
function execution(){return {status:'OBSERVED_EXIT',observed_exit_code:0,observed_exit_signal:null,observed_wall_ms:0,observed_termination:true,io_state:{stdout_bytes_observed:0,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},settlement_status:'SETTLED_DIRECT_CHILD_EXIT',signal_attempts:[],deadline_ms:100,runtime_admitted:false,descendant_guarantee:'NONE',workspace_reuse:'NOT_AUTHORIZED'};}
function receipt(){
 const record={job_id:'ba586107-7240-4d89-88d3-d71005bce32f',task_class:'BOUNDED_CODEGEN_SUMMARIZER_V5',lifecycle_status:'LIMITED_SUCCESS',requested_model:'gpt-6-luna',reported_model:'UNKNOWN',process_exit:{pid:1,exit_code:0,exit_signal:null,process_wall_ms:0,observed_termination:true},io_state:{stdout_bytes_observed:100,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'},provider_metadata:{provider_reported_status:'turn.completed',duration_seconds:null,usage_tokens:{input:0,output:8,cache_read:0,thinking:'UNKNOWN',total:'UNKNOWN'},codex_reasoning_output_tokens:3},output_custody:{persisted:true,path,byte_count:100,persistence_error:null},task_outcome_evaluated:false,task_payload_valid:true,error_details:{code:null,classification:null,message:null}};
 const generation={record,diagnostic_retention:{retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,exact_response_bytes:null,retained_bytes_count:null,retained_truncated:false,retention_error:null},runtime_evidence:{deadline_ms:120000,timeout_latched:false,abort_latched:false,signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:'DEDICATED_NOT_REUSED',max_steps:'UNSUPPORTED'},physical_source_witness:{source_path:path,source_sha256:digest,source_byte_count:100,format_status:'FORMAT_VALID',syntax_observation:'UNESTABLISHED_NO_NATIVE_PARSER',witness_locked:true,destination_mode:'0o400',witness_timestamp_ms:0},runtime_admitted:false};
 const fixtures=notRun().map((f,i)=>({...f,status:'PASS',fixture_verdict:'PASS',observed_exit_code:i<10?0:i<13?2:i<16?3:4,observed_exit_signal:null,observed_wall_ms:0,exit_code_matched:true,summary_json_matched:i<10?true:'NOT_APPLICABLE',manifest_json_matched:i<10?true:'NOT_APPLICABLE',zero_files_verified:i<10||i===16?'NOT_APPLICABLE':true}));
 return {status:'PASS',reason:null,generation,syntax:{execution:execution(),wrapper_status:'ACCEPTED',observation:{syntax_status:'SYNTAX_VALID',syntax_valid:true}},source:{source_path:path,source_sha256:digest,source_byte_count:100,inspection:'ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY',safety:'NOT_ESTABLISHED'},fixture_deadline_ms:85000,fixtures,denominator:17,runtime_admitted:false,workspace_disposition:'DEDICATED_NOT_REUSED',descendant_guarantee:'NONE',direct_child_invocations:{generation:1,syntax:1,fixtures:17},outer_observation_target_ms:250000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',operator_receipt:'/PUBLIC_SYNTHETIC/operator',operator_admitted:true};
}
function largeObservationReceipt(){
 const job_id='10000000-0000-4000-8000-000000000001';
 const record={
  job_id,task_class:PROJECT_LARGE_OBSERVATION_TASK_CLASS,output_profile:PROJECT_OUTPUT_LARGE_PROFILE,lifecycle_status:'LIMITED_SUCCESS',
  requested_model:'synthetic-model',reported_model:'UNKNOWN',
  process_exit:{pid:321,exit_code:0,exit_signal:null,process_wall_ms:12,observed_termination:true},
  io_state:{stdout_bytes_observed:1200000,stderr_bytes_observed:70000,stdout_eof:true,stderr_eof:true,io_drained:true},
  containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'},
  provider_metadata:{codex_reasoning_output_tokens:4,provider_reported_status:'turn.completed',duration_seconds:null,usage_tokens:{input:11,output:22,cache_read:3,thinking:'UNKNOWN',total:'UNKNOWN'}},
  output_custody:{persisted:true,path:'/PRIVATE_SYNTHETIC/candidate-envelope.json',byte_count:1100000,persistence_error:null},
  task_outcome_evaluated:false,task_payload_valid:true,error_details:{code:null,classification:null,message:null}
 };
 const generation={
  record,
  runtime_evidence:{deadline_ms:null,timeout_latched:false,abort_latched:false,signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:'DEDICATED_NOT_REUSED',max_steps:'UNSUPPORTED'},
  diagnostic_retention:{retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,exact_response_bytes:null,retained_bytes_count:null,retained_truncated:false,retention_error:null}
 };
 const staging={schema_version:'squire4.large_project_stage_receipt.v1',output_profile:PROJECT_OUTPUT_LARGE_PROFILE,stage_operation_id:`stage-${job_id}`,caller_label:'project_candidate_stager',completion_status:'COMPLETE',manifest_sha256:'a'.repeat(64),file_count:1,total_bytes:0,operation_acknowledgement:'ACKNOWLEDGED',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'};
 const result={schema:PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,status:'CANDIDATE_STAGED',reason:null,generation,staging,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,operator_admitted:true,workspace_disposition:'DEDICATED_NOT_REUSED',descendant_guarantee:'NONE',operator_receipt:'/PRIVATE_SYNTHETIC/operator',direct_child_invocations:{generation:1},outer_observation_target_ms:null,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',execution_profile:PROJECT_CODING_OBSERVATION_PROFILE,output_profile:PROJECT_OUTPUT_LARGE_PROFILE,post_generation_closeout:{status:'COMPLETE',limit_ms:20000}};
 return {schema:PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA,result};
}
async function cli(value,overrides={}){let out='',err='';const bytes=encode(value),ports={readFile:async()=>bytes,stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length}),stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},...overrides};const code=await runOfflineReportCli(['/PUBLIC_SYNTHETIC/receipt.json'],ports);return {code,out,err};}
async function invokeReport(argv,value,overrides={}){let out='',err='',readPath=null,stats=0,reads=0;const bytes=encode(value),ports={stat:async path=>{stats++;readPath=path;return {isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length};},readFile:async path=>{reads++;readPath=path;return bytes;},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},...overrides};const code=await runOfflineReportCli(argv,ports);return {code,out,err,readPath,stats,reads};}

const expectedRouteIds=['native_project_large_observation','native_project_coding_observation','native_project','project','single_js','courier_handoff','legacy_campaign'];
const expectedInputSchemas=[
 'SQUIRE3_NATIVE_PROJECT_LARGE_OBSERVATION_RESULT_RECEIPT_V1',
 'SQUIRE3_NATIVE_PROJECT_CODING_OBSERVATION_RESULT_RECEIPT_V1',
 'SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1','SQUIRE2_PROJECT_RESULT_V1',
 'SQUIRE2_SINGLE_JS_RESULT_V1','SQUIRE2_SINGLE_JS_DRY_RUN_V1',
 'SQUIRE3_COURIER_HANDOFF_REPORT_V1'
];
const expectedOutputKinds=['native_project_large_observation_text','native_project_coding_observation_text','native_project_text','project_text','single_js_text','courier_handoff_text','legacy_campaign_text'];
const expectedInvalidPrefixes={
 native_project_large_observation:'Squire native offline project large observation result: INVALID_RECEIPT',
 native_project_coding_observation:'Squire native offline project coding observation result: INVALID_RECEIPT',
 native_project:'Squire native offline project result: INVALID_RECEIPT',
 project:'Squire offline project result: INVALID_RECEIPT',
 single_js:'Squire single-JavaScript receipt: INVALID_RECEIPT',
 legacy_campaign:'Squire offline receipt summary: INVALID_RECEIPT'
};
function assertCapabilitiesContract(manifest){
 assert.deepEqual(Object.keys(manifest),['schema','interface','invocation','receipt_input_max_bytes','routes','rejection_codes','exit_meanings']);
 assert.equal(manifest.schema,'SQUIRE_OFFLINE_REPORT_CAPABILITIES_V1');assert.equal(manifest.interface,'squire-report');assert.deepEqual(manifest.invocation,['--capabilities','--json']);assert.equal(manifest.receipt_input_max_bytes,REPORT_MAX_BYTES);
 assert.equal(manifest.routes.length,7);assert.deepEqual(manifest.routes.map(x=>x.route_id),expectedRouteIds);assert.deepEqual(manifest.routes.flatMap(x=>x.input_schemas),expectedInputSchemas);assert.deepEqual(manifest.routes.map(x=>x.terminal_output_kind),expectedOutputKinds);
 const legacy=manifest.routes.at(-1);assert.deepEqual(legacy.input_schemas,[]);assert.deepEqual(legacy.legacy_shape_names,['Q218_CAMPAIGN','NATIVE_Q218_CAMPAIGN','NATIVE_DISABLED_DRY_RUN']);
 assert.deepEqual(manifest.routes.filter(x=>x.route_id!=='legacy_campaign').map(x=>x.valid_exit_codes),[[1],[1],[1],[1],[1],[1]]);assert.deepEqual(manifest.routes.map(x=>x.invalid_exit_code),Array(7).fill(2));
 const byCode=new Map(manifest.rejection_codes.map(x=>[x.code,x]));assert.deepEqual(byCode.get('SCHEMA_MISMATCH').route_ids,expectedRouteIds.filter(x=>x!=='courier_handoff'));
 assert.deepEqual(byCode.get('INVALID_INPUT').route_ids,['courier_handoff']);assert.deepEqual(byCode.get('CAPABILITIES_INTERNAL_ERROR').route_ids,['capabilities']);
 for(const code of OFFLINE_REPORT_REJECTION_CODES)assert.deepEqual(byCode.get(code)?.route_ids,code==='SCHEMA_MISMATCH'?expectedRouteIds.filter(x=>x!=='courier_handoff'):['legacy_campaign']);
 for(const record of manifest.rejection_codes)assert.equal(record.stability,'V1_DISCOVERY_CONTRACT');
 assert.deepEqual(manifest.exit_meanings.map(x=>x.exit_code),[0,1,2]);assert.deepEqual(manifest.exit_meanings[0].route_meanings.map(x=>x.route_id),['legacy_campaign']);
 assert.ok(manifest.exit_meanings[2].route_meanings.some(x=>x.route_id==='usage'));
}

test('capabilities bytes are static, bounded, minified, and never dispatch receipt ports',async()=>{
 let out='',err='',reads=0,stats=0,spawns=0;
 const ports={readFile:async()=>{reads++;throw Error('PRIVATE_READ_SENTINEL');},stat:async()=>{stats++;throw Error('PRIVATE_STAT_SENTINEL');},spawn:()=>{spawns++;throw Error('PRIVATE_SPAWN_SENTINEL');},receipt_path:'/PRIVATE_PATH_SENTINEL',environment:{TOKEN:'PRIVATE_ENV_SENTINEL'},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}};
 assert.equal(await runOfflineReportCli(['--capabilities','--json'],ports),0);
 assert.equal(await runOfflineReportCli(['--capabilities','--json'],{...ports,environment:{TOKEN:'OTHER_PRIVATE_SENTINEL'}}),0);
 assert.equal(err,'');assert.equal(reads,0);assert.equal(stats,0);assert.equal(spawns,0);
 const first=out.slice(0,out.indexOf('\n')+1),second=out.slice(out.indexOf('\n')+1);assert.equal(first,second);assert.equal(first.endsWith('\n'),true);assert.equal(first.endsWith('\n\n'),false);
 const bytes=new TextEncoder().encode(first);assert.ok(bytes.length<=16*1024);const manifest=JSON.parse(first);assert.equal(first,JSON.stringify(manifest)+'\n');assertCapabilitiesContract(manifest);
 assert.doesNotMatch(first,/PRIVATE_|PRIVATE_PATH|PRIVATE_ENV|PRIVATE_READ|PRIVATE_STAT|PRIVATE_SPAWN|stack|\/home\//i);
});

test('capability selectors dispatch every listed route and preserve route rejection labels',async()=>{
 const manifest=JSON.parse(serializeOfflineReportCapabilities());assertCapabilitiesContract(manifest);
 const codeRoutes=new Map();for(const record of manifest.rejection_codes)for(const id of record.route_ids){if(!codeRoutes.has(id))codeRoutes.set(id,[]);codeRoutes.get(id).push(record.code);}
 for(const route of manifest.routes){
  for(const schema of route.input_schemas){
   const result=await invokeReport(['/PUBLIC_SYNTHETIC/route.json'],{schema,private_path:'/PRIVATE_ROUTE_SENTINEL'});
   assert.equal(result.code,route.invalid_exit_code,`${route.route_id} ${schema}`);
   assert.ok(codeRoutes.get(route.route_id).includes(result.err.trim()),`${route.route_id} ${result.err}`);
   if(route.route_id==='courier_handoff')assert.equal(result.out,'');
   else assert.ok(result.out.startsWith(expectedInvalidPrefixes[route.route_id]),`${route.route_id} formatter`);
   assert.doesNotMatch(result.out+result.err,/PRIVATE_ROUTE_SENTINEL|PUBLIC_SYNTHETIC/);
  }
 }
 const validText=JSON.stringify(largeObservationReceipt()),validReceipt=JSON.parse(validText);
 assert.equal(projectNativeProjectLargeObservationRunSummary(validReceipt).readiness,'CANDIDATE_STAGED');
 const validRoute=await invokeReport(['/PRIVATE_LARGE/valid.json'],validReceipt);
 assert.equal(validRoute.code,1);assert.equal(validRoute.err,'');assert.match(validRoute.out,/native offline project large observation result: CANDIDATE_STAGED/i);
 const lexicalText=validText.replace('"output":22','"output":1.00000000000000001'),lexicalBytes=encode(lexicalText),lexicalObject=JSON.parse(lexicalText);
 assert.equal(lexicalObject.result.generation.record.provider_metadata.usage_tokens.output,1);
 assert.equal(projectNativeProjectLargeObservationRunSummary(lexicalObject).readiness,'CANDIDATE_STAGED');
 const byteSummary=projectNativeProjectLargeObservationReceiptBytesSummary(lexicalBytes);
 assert.equal(byteSummary.readiness,'INVALID_RECEIPT');
 const expected=formatNativeProjectLargeObservationSummaryTerminal(byteSummary);
 let out='',err='';const code=await runOfflineReportCli(['/SYNTHETIC/large.json'],{stat:async()=>({isFile:()=>true,size:lexicalBytes.length}),readFile:async()=>lexicalBytes,stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}});
 assert.equal(code,2);assert.equal(out,expected);assert.equal(err,'SCHEMA_MISMATCH\n');assert.match(out,/native offline project large observation result: INVALID_RECEIPT/i);
});

test('unknown routes, extra fields, missing files, and oversize reads remain closed and private',async()=>{
 const unknown=await invokeReport(['/PRIVATE_UNKNOWN/receipt.json'],{schema:'SQUIRE9_UNKNOWN_RECEIPT_V9',private_path:'/PRIVATE_SENTINEL',provider_message:'PRIVATE_ERROR_SENTINEL'});
 assert.equal(unknown.code,2);assert.equal(unknown.err,'SCHEMA_MISMATCH\n');assert.match(unknown.out,/INVALID_RECEIPT/);assert.doesNotMatch(unknown.out+unknown.err,/PRIVATE_SENTINEL|PRIVATE_ERROR_SENTINEL|PRIVATE_UNKNOWN/);
 const knownExtra=await invokeReport(['/PRIVATE_TYPED/receipt.json'],{schema:'SQUIRE2_PROJECT_RESULT_V1',private_path:'/PRIVATE_SENTINEL'});
 assert.equal(knownExtra.code,2);assert.equal(knownExtra.err,'SCHEMA_MISMATCH\n');assert.doesNotMatch(knownExtra.out+knownExtra.err,/PRIVATE_SENTINEL|PRIVATE_TYPED/);
 let reads=0;const missingBytes=encode('{}');let out='',err='';
 const missingCode=await runOfflineReportCli(['/PRIVATE_MISSING'],{stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:missingBytes.length}),readFile:async()=>{reads++;throw Object.assign(Error('PRIVATE_MISSING_ERROR'),{code:'ENOENT'});},stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}});
 assert.equal(missingCode,2);assert.equal(reads,1);assert.equal(err,'FILE_NOT_FOUND\n');assert.match(out,/INVALID_RECEIPT/);assert.doesNotMatch(out+err,/PRIVATE_MISSING/);
 reads=0;out='';err='';const sizeCode=await runOfflineReportCli(['/PRIVATE_LARGE'],{stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:REPORT_MAX_BYTES+1}),readFile:async()=>{reads++;throw Error('SHOULD_NOT_READ');},stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}});
 assert.equal(sizeCode,2);assert.equal(reads,0);assert.equal(err,'FILE_TOO_LARGE\n');assert.match(out,/INVALID_RECEIPT/);assert.doesNotMatch(out+err,/PRIVATE_LARGE|SHOULD_NOT_READ/);
});

test('capability snapshot catches route/code drift and refuses oversized output before writing',()=>{
 const manifest=JSON.parse(serializeOfflineReportCapabilities());
 const descriptors=manifest.routes.map(route=>({
  ...route,
  rejection_codes:manifest.rejection_codes.filter(code=>code.route_ids.includes(route.route_id)).map(code=>code.code),
  exit_meanings:Object.fromEntries(manifest.exit_meanings.flatMap(record=>record.route_meanings.filter(x=>x.route_id===route.route_id).map(x=>[record.exit_code,x.meaning])))
 }));
 assert.throws(()=>assertCapabilitiesContract(JSON.parse(serializeOfflineReportCapabilities(descriptors.slice(1)))));
 const missingCode=descriptors.map(route=>({...route,rejection_codes:[...route.rejection_codes]}));missingCode[0].rejection_codes=missingCode[0].rejection_codes.filter(x=>x!=='SCHEMA_MISMATCH');
 assert.throws(()=>assertCapabilitiesContract(JSON.parse(serializeOfflineReportCapabilities(missingCode))));
 const tooLarge=descriptors.map(route=>({...route,valid_exit_codes:[0,1],invalid_exit_code:2,exit_meanings:{0:'0'.repeat(1024),1:'1'.repeat(1024),2:'2'.repeat(1024)}}));
 assert.ok(tooLarge.every(route=>route.route_id.length<=64&&route.input_schemas.length<=2&&route.input_schemas.every(x=>x.length<=96)&&route.terminal_output_kind.length<=64&&route.valid_exit_codes.length<=3&&route.rejection_codes.length<=OFFLINE_REPORT_REJECTION_CODES.length+1&&Object.values(route.exit_meanings).every(x=>x.length<=1024)));
 assert.ok(new TextEncoder().encode(JSON.stringify(tooLarge.map(route=>route.exit_meanings))).length>16*1024);
 let out='',err='';assert.equal(writeOfflineReportCapabilities({write:s=>out+=s},{write:s=>err+=s},tooLarge),2);
 assert.equal(out,'');assert.equal(err,'CAPABILITIES_INTERNAL_ERROR\n');
});

test('capability argv preserves literal one-path and malformed-argv behavior byte for byte',async()=>{
 const bytes=encode(receipt());let literalPath=null,literalStats=0,literalReads=0;
 const pathResult=await invokeReport(['--capabilities'],receipt(),{readFile:async path=>{literalPath=path;literalReads++;assert.equal(path,'--capabilities');return bytes;},stat:async path=>{literalPath=path;literalStats++;assert.equal(path,'--capabilities');return {isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length};}});
 assert.equal(pathResult.code,0);assert.equal(pathResult.err,'');assert.match(pathResult.out,/Squire offline receipt summary: PASS/);assert.equal(literalPath,'--capabilities');assert.equal(literalStats,1);assert.equal(literalReads,1);
 for(const argv of [[],['--capabilities','--json','extra'],['one','two']]){
  const result=await invokeReport(argv,receipt());assert.equal(result.code,2);assert.equal(result.out,'');assert.equal(result.err,'Usage: node bin/squire-report.mjs <receipt-path>\n');assert.equal(result.stats,0);assert.equal(result.reads,0);
 }
});
test('offline full Q218 conformance keeps generation and markers separate, including negative expected exits',async()=>{
 const r=receipt(),s=projectRunSummary(r);assert.equal(s.overall_outcome,'PASS');assert.equal(s.fixtures.passed_count,17);assert.equal(s.fixtures.cases[16].observed_exit_code,4);assert.equal(s.admission.operator_admitted,true);assert.equal(s.admission.runtime_admitted_marker,false);assert.equal(s.generation.task_outcome_evaluated_marker,false);assert.ok(Object.isFrozen(s.fixtures.cases[0]));assert.equal(s.generation.reported_model,'UNKNOWN');
 const c=await cli(r);assert.equal(c.code,0);assert.equal(c.err,'');assert.match(c.out,/17 PASS/);assert.match(c.out,/no artifact, authorization or execution re-verification/);assert.equal(c.out.includes(path),false);assert.match(c.out,/inference seconds: UNKNOWN/);
});
test('dry run and early abort preserve absent observations without invented fixtures',async()=>{
 const dry={status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0};const s=projectRunSummary(dry);assert.equal(s.overall_outcome,'INCOMPLETE');assert.equal(s.campaign.denominator,null);assert.equal(s.fixtures.cases,null);assert.equal(s.generation.tokens,null);assert.equal(s.admission.runtime_admitted_marker,null);assert.equal((await cli(dry)).code,1);
 const r=receipt();for(const k of ['direct_child_invocations','outer_observation_target_ms','event_loop_condition','operator_receipt','operator_admitted'])delete r[k];Object.assign(r,{status:'FAIL',reason:'CANCELED',generation:null,syntax:null,source:null,fixtures:notRun(),fixture_deadline_ms:null,workspace_disposition:'QUARANTINED'});const a=projectRunSummary(r);assert.equal(a.overall_outcome,'INCOMPLETE');assert.equal(a.fixtures.not_run_count,17);assert.equal(a.generation.lifecycle_status,'NOT_RUN');assert.equal(a.syntax.wrapper_status,'NOT_RUN');assert.equal(a.artifact.witness_present,false);assert.equal(a.execution.child_invocations.generation,null);
});
test('cancellation, parser failures, and fixture failures obey outcome precedence',()=>{
 const partial=receipt();partial.status='FAIL';partial.reason='CANCELED';partial.workspace_disposition='QUARANTINED';partial.fixtures=partial.fixtures.map((x,i)=>i<3?x:notRun()[i]);partial.direct_child_invocations.fixtures=3;assert.equal(projectRunSummary(partial).overall_outcome,'INCOMPLETE');
 const failed=receipt();failed.status='FAIL';failed.reason='CANCELED';failed.fixtures[3].status=failed.fixtures[3].fixture_verdict='FAIL';failed.fixtures[3].exit_code_matched=false;assert.equal(projectRunSummary(failed).overall_outcome,'FAIL');
 const parser=receipt();Object.assign(parser,{status:'FAIL',reason:'GENERATION_REJECTED',source:null,syntax:null,fixtures:notRun(),fixture_deadline_ms:null});Object.assign(parser.direct_child_invocations,{syntax:0,fixtures:0});const g=parser.generation;g.record.lifecycle_status='LIMITED_PARSER_ERROR';g.record.task_payload_valid=false;g.record.output_custody={persisted:false,path:null,byte_count:null,persistence_error:null};g.physical_source_witness=null;g.record.error_details.code='PAYLOAD:CODEGEN_PAYLOAD_TOO_SMALL';assert.equal(projectRunSummary(parser).overall_outcome,'FAIL');assert.equal(projectRunSummary(parser).diagnostic.reason,'CODEGEN_PAYLOAD_TOO_SMALL');
});
test('matrices, counts, wrappers, hashes and success contradictions reject closed',()=>{
 for(const mutate of [r=>{r.fixtures=[];},r=>{delete r.fixtures;},r=>{r.fixtures[1].fixture_id='FIX-01';},r=>{r.fixtures.reverse();},r=>{r.denominator=16;},r=>{r.debug_logs='PRIVATE';},r=>{r.direct_child_invocations.fixtures=16;},r=>{r.source.source_sha256='broken';},r=>{r.source.source_sha256='b'.repeat(64);},r=>{r.reason='CANCELED';},r=>{r.syntax.execution.observed_exit_code=1;},r=>{r.fixtures[0].summary_json_matched=false;},r=>{r.generation=null;},r=>{r.generation.record.task_outcome_evaluated=true;}]){const r=receipt();mutate(r);assert.equal(projectRunSummary(r).overall_outcome,'INVALID_RECEIPT');}
});
test('null/unknown and explicit zero counters stay distinct without inferred totals',()=>{
 const r=receipt();r.generation.record.provider_metadata.usage_tokens.input=null;const s=projectRunSummary(r);assert.equal(s.overall_outcome,'PASS');assert.equal(s.generation.tokens.input,null);assert.equal(s.generation.tokens.cache_read,0);assert.equal(s.generation.tokens.thinking,null);assert.equal(s.generation.tokens.total,null);assert.equal(s.generation.tokens.codex_reasoning,3);
 for(const v of [-1,true,{},'0',1.5]){const r=receipt();r.generation.record.provider_metadata.usage_tokens.input=v;assert.equal(projectRunSummary(r).overall_outcome,'INVALID_RECEIPT');}
});
test('latched abort or timeout cannot coexist with successful generation',()=>{
 for(const key of ['abort_latched','timeout_latched']){const r=receipt();r.generation.runtime_evidence[key]=true;assert.equal(projectRunSummary(r).overall_outcome,'INVALID_RECEIPT');}
 const r=receipt();r.generation.runtime_evidence.workspace_disposition='QUARANTINED';assert.equal(projectRunSummary(r).overall_outcome,'INVALID_RECEIPT');
});
test('private labels, paths, errors and terminal controls never echo',async()=>{
 const r=receipt();r.operator_receipt='/home/PRIVATE_SENTINEL\0\x1b[31m';r.generation.record.requested_model='PRIVATE_MODEL\x1b[31m';r.generation.record.error_details.message='PRIVATE_ERROR_STACK';const c=await cli(r);assert.equal(c.code,0);assert.equal(/PRIVATE|\x1b|\0/.test(c.out+c.err),false);assert.match(c.out,/Requested model: UNKNOWN/);assert.equal(/[^\x20-\x7e\n]/.test(c.out),false);
 const forged={schema_version:'squire1.offline_summary.v1',overall_outcome:'PASS'};assert.match(formatSummaryTerminal(forged),/INVALID_RECEIPT/);
});
test('strict bounded parser rejects duplicate decoded keys, pollution, malformed UTF8/JSON and limits',()=>{
 for(const raw of ['{"status":1,"sta\\u0074us":2}','{"__proto__":{}}','{"constructor":{}}','[1,]','{"a":NaN}','{} trailing','\uFEFF{}',JSON.stringify({x:'x'.repeat(4097)}),'['.repeat(12)+'0'+']'.repeat(12),JSON.stringify(Array(65).fill(0))])assert.throws(()=>parseReceiptJson(encode(raw)));
 assert.throws(()=>parseReceiptJson(new Uint8Array([255])));assert.throws(()=>parseReceiptJson(new Uint8Array(REPORT_MAX_BYTES+1)));assert.deepEqual(Object.keys(parseReceiptJson(encode('{}'))),[]);
});
test('pure object intake rejects getters, proxies, sparse/cyclic inputs without user callbacks',()=>{
 let called=0;const r=receipt();Object.defineProperty(r,'status',{get(){called++;throw 0;}});assert.equal(projectRunSummary(r).overall_outcome,'INVALID_RECEIPT');assert.equal(called,0);
 const p=new Proxy({}, {get(){called++;throw 0;},ownKeys(){called++;throw 0;}});assert.equal(projectRunSummary(p).overall_outcome,'INVALID_RECEIPT');assert.equal(called,0);
 const cyclic={};cyclic.self=cyclic;assert.equal(projectRunSummary(cyclic).overall_outcome,'INVALID_RECEIPT');const sparse=receipt();delete sparse.fixtures[0];assert.equal(projectRunSummary(sparse).overall_outcome,'INVALID_RECEIPT');
});
test('CLI failures use fixed diagnostics and never echo paths or exception text',async()=>{
 for(const [ports,expected]of [[{readFile:async()=>{throw Error('PRIVATE_MESSAGE');}},'READ_FAILED'],[{stat:async()=>({isFile:()=>false})},'SPECIAL_FILE_REJECTED'],[{stat:async()=>({isFile:()=>true,size:REPORT_MAX_BYTES+1})},'FILE_TOO_LARGE'],[{readFile:async()=>encode('{"x":1,"x":2}')},'DUPLICATE_KEY_CONFLICT']]){const r=await cli(receipt(),ports);assert.equal(r.code,2);assert.equal(r.err,expected+'\n');assert.equal(r.out.includes('PRIVATE_MESSAGE'),false);}
 let out='',err='';assert.equal(await runOfflineReportCli([],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}}),2);assert.equal(out,'');assert.match(err,/Usage:/);
});
test('native offline reader uses only owned synthetic files and refuses symlink/directory/oversize',async()=>{
 const root=await fs.mkdtemp(new URL('./offline-report-fixture-',import.meta.url));
 try{const p=join(root,'receipt.json');await fs.writeFile(p,encode(receipt()));assert.equal(projectRunSummary(parseReceiptJson(await readReceiptBytes(p))).overall_outcome,'PASS');await fs.symlink(p,join(root,'link'));await assert.rejects(readReceiptBytes(join(root,'link')));await assert.rejects(readReceiptBytes(root));await fs.writeFile(join(root,'large'),new Uint8Array(REPORT_MAX_BYTES+1));await assert.rejects(readReceiptBytes(join(root,'large')));await assert.rejects(readReceiptBytes(join(root,'absent')));}
 finally{await fs.rm(root,{recursive:true});}
});
