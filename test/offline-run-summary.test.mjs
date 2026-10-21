import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {projectRunSummary,formatSummaryTerminal,parseReceiptJson,REPORT_MAX_BYTES} from '../src/offline-run-summary.mjs';
import {runOfflineReportCli,readReceiptBytes} from '../bin/squire-report.mjs';

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
async function cli(value,overrides={}){let out='',err='';const bytes=encode(value),ports={readFile:async()=>bytes,stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length}),stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},...overrides};const code=await runOfflineReportCli(['/PUBLIC_SYNTHETIC/receipt.json'],ports);return {code,out,err};}
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
