import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ContractError} from '../src/job-spec.mjs';
import {createCodegenStreamCollector,createLimitedStreamCollector} from '../src/limited-stream-collector.mjs';
import {runForeground} from '../src/internal/limited-core.mjs';
import {collectorDiagnostic,sanitizeDiagnosticMetadata,diagnosticReport} from '../src/internal/limited-diagnostics.mjs';
import {decodeAgyJson,AGY_BYTE_LIMITS} from '../src/agy-profile.mjs';
const enc=x=>new TextEncoder().encode(typeof x==='string'?x:JSON.stringify(x));
const source='// synthetic owned source only\n'+'export const value = 1;\n'.repeat(5);
const meta={usage:{input_tokens:0,output_tokens:7,cache_read_tokens:0,thinking_tokens:3,total_tokens:10},duration_seconds:0};
const env=(response=source,status='SUCCESS',extra=meta)=>enc({status,response,...extra});
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture({bytes=env(),factory=createCodegenStreamCollector,mode='normal',decoderHook,persistHook}={}){
 let time=0;const timers=[],child=new EventEmitter(),abort=new AbortController();let writes=0;
 const clock={now:()=>time,schedule(ms,cb){const t={at:time+ms,cb,active:true};timers.push(t);return()=>{t.active=false;};}};
 child.pid=123;child.unref=()=>{};child.kill=signal=>{child.emit('exit',null,signal);return true;};
 for(const key of ['stdout','stderr']){child[key]=new EventEmitter();child[key].destroy=()=>{};}
 let c=factory(abort);if(decoderHook){const original=c;c={...original,decode(raw){return decoderHook(original,raw,abort);}};}
 const result=runForeground({job_id:'12345678-1234-4abc-8def-123456789abc',task_scope:'/synthetic',task_class:'BOUNDED_CODEGEN_SUMMARIZER_V5',requested_model:'gemini-3.8-flash-high',max_wall_clock_sec:1},
 {executable:'/synthetic/agy',args:[]},{shutdown:{term_grace_ms:20,kill_grace_ms:20,stream_drain_timeout_ms:10,persistence_timeout_ms:20},output_path:'/synthetic/source',abortSignal:abort.signal},
 {clock,createCollector:()=>c,spawn(){queueMicrotask(()=>{if(mode==='spawn_error'){child.emit('error',Error('synthetic'));return;}child.emit('spawn');
 if(mode==='capacity'){child.stdout.emit('data',new Uint8Array(1048577));return;}
 if(mode==='timeout'||mode==='abort')return;
 child.stdout.emit('data',bytes);child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',mode==='nonzero'?4:0,null);});return child;},persist:async bytes=>{writes++;persistHook?.(bytes);}});
 return {result,child,abort,writes:()=>writes,async tick(n){time=n;for(const t of [...timers])if(t.active&&t.at<=n){t.active=false;t.cb();}await flush();}};
}
function collected(bytes=env(),factory=createCodegenStreamCollector){const c=factory();c.chunk('stdout',bytes);c.eof('stdout');c.eof('stderr');return c;}
const code=r=>r.record.error_details.code;
const assertPrivate=r=>{const text=JSON.stringify(r);assert.ok(!text.includes('SENTINEL_SECRET'));assert.equal(r.record.error_details.message,null);};

test('collection failure report is finite and close clears per-attempt report',()=>{
 const c=createCodegenStreamCollector();assert.throws(()=>c.decode({}));assert.deepEqual(c.diagnosticReport(),{stage:'COLLECTION',reason:'COLLECTION_FAILED',metadata:null});c.close();assert.equal(c.diagnosticReport(),null);
 assert.equal(createCodegenStreamCollector().diagnosticReport(),null);
});
test('standalone decoder oversize remains distinct from transport capacity',async()=>{
 const d=decodeAgyJson({raw_payload_bytes:new Uint8Array(1048577),max_response_bytes:1048576,wrapper_exit_code:0,wrapper_signal:null,wrapper_wall_ms:0});assert.equal(d.diagnostic_code,'PAYLOAD_SIZE_EXCEEDED');
 const f=fixture({mode:'capacity'});await flush();await f.tick(10);const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_CAPACITY_EXCEEDED');assert.equal(code(r),'LIMITED_CAPACITY_EXCEEDED');
});
for(const [name,bytes,expected]of [
 ['utf8',new Uint8Array([255,254]),'MALFORMED_UTF8'],['json',enc('{'),'MALFORMED_JSON'],['BOM',enc('\uFEFF{}'),'MALFORMED_JSON'],
 ['surrogate',enc('{"status":"SUCCESS","response":"\\uD800"}'),'MALFORMED_JSON'],
 ['duplicate',enc('{"status":"SUCCESS","\\u0073tatus":"ERROR"}'),'DUPLICATE_KEY_CONFLICT'],['root',enc('[]'),'INVALID_ROOT_SHAPE']]){
 test('envelope '+name+' keeps only bounded reason and no metadata',async()=>{const f=fixture({bytes});const r=await f.result;assert.equal(code(r),'ENVELOPE:'+expected);assert.equal(r.record.provider_metadata.provider_reported_status,null);assert.equal(f.writes(),0);assertPrivate(r);});
}
test('provider failure retains validated status/duration/all five counters without promoting success',async()=>{
 const f=fixture({bytes:env(source,'ERROR')});const r=await f.result;assert.equal(code(r),'PROVIDER_STATUS:PROVIDER_NON_SUCCESS');assert.equal(r.record.provider_metadata.provider_reported_status,'ERROR');assert.equal(r.record.provider_metadata.duration_seconds,0);assert.deepEqual(r.record.provider_metadata.usage_tokens,{input:0,output:7,cache_read:0,thinking:3,total:10});assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.equal(f.writes(),0);
});
test('unrecognized provider strings and invalid/missing counters cannot leak or synthesize zeros',async()=>{
 const f=fixture({bytes:env(source,'SENTINEL_SECRET',{duration_seconds:-1,usage:{input_tokens:-2,output_tokens:'secret',cache_read_tokens:1.5}})});const r=await f.result;assert.equal(code(r),'PROVIDER_STATUS:PROVIDER_NON_SUCCESS');assert.equal(r.record.provider_metadata.provider_reported_status,null);assert.equal(r.record.provider_metadata.duration_seconds,null);assert.ok(Object.values(r.record.provider_metadata.usage_tokens).every(v=>v==='UNKNOWN'));assertPrivate(r);
});
for(const response of [null,17])test('missing/nonstring response reports RESPONSE stage '+response,async()=>{const f=fixture({bytes:env(response)});const r=await f.result;assert.equal(code(r),'RESPONSE:RESPONSE_STRING_REQUIRED');assert.equal(r.record.provider_metadata.usage_tokens.input,0);assert.equal(f.writes(),0);});
for(const [name,response,expected]of [['markdown','```'+source,'CODEGEN_MARKDOWN_REJECTED'],['NUL',source+'\0','CODEGEN_ENCODING_REJECTED'],['BOM',source+'\uFEFF','CODEGEN_ENCODING_REJECTED'],['small','x','CODEGEN_PAYLOAD_TOO_SMALL'],['large','x'.repeat(65537),'CODEGEN_PAYLOAD_TOO_LARGE']]){
 test('payload '+name+' retains only typed provider metadata',async()=>{const bytes=name==='BOM'?enc(new TextDecoder().decode(env(response)).replace('\uFEFF','\\uFEFF')):env(response);const f=fixture({bytes});const r=await f.result;assert.equal(code(r),'PAYLOAD:'+expected);assert.equal(r.record.provider_metadata.provider_reported_status,'SUCCESS');assert.equal(f.writes(),0);assert.equal(r.record.task_payload_valid,false);assertPrivate(r);});
}
test('summary payload/prototype rejection keeps closed error details and sanitized report',()=>{
 const c=collected(env('{"constructor":"SENTINEL_SECRET"}'),createLimitedStreamCollector);assert.throws(()=>c.decode({}));const report=c.diagnosticReport();assert.equal(report.reason,'TASK_PAYLOAD_INVALID');assert.ok(!JSON.stringify(report).includes('SENTINEL_SECRET'));assert.ok(Object.isFrozen(report));assert.ok(Object.isFrozen(report.metadata.usage));
});
test('explicit zero counters and duration preserved in report and existing wire ABI',async()=>{
 const zero={duration_seconds:0,usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,thinking_tokens:0,total_tokens:0}};
 const f=fixture({bytes:env('```','SUCCESS',zero)});const r=await f.result;assert.equal(r.record.provider_metadata.duration_seconds,0);assert.ok(Object.values(r.record.provider_metadata.usage_tokens).every(v=>v===0));assert.deepEqual(Object.keys(r.record.error_details),['code','classification','message']);
});
function fakeCollector(error,report){const c={chunk:()=>true,eof(){},snapshot:()=>({stdout_bytes_observed:1,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true}),decode(){throw error;},close(){}};if(report!==undefined)Object.defineProperty(c,'diagnosticReport',report);return c;}
test('legacy error mapping is finite, unknown exceptions never serialize arbitrary properties',async()=>{
 for(const error of [new Error('SENTINEL_SECRET'),new ContractError('SENTINEL_SECRET','SENTINEL_SECRET'),new Proxy({}, {get(){throw Error('SENTINEL_SECRET');},getPrototypeOf(){throw Error('SENTINEL_SECRET');}})]){
  const f=fixture({factory:()=>fakeCollector(error)}),r=await f.result;assert.equal(code(r),'UNCLASSIFIED:UNKNOWN_REJECTION');assertPrivate(r);
 }
 const f=fixture({factory:()=>fakeCollector(new ContractError('invalid_contract','limited_envelope'))});assert.equal(code(await f.result),'ENVELOPE:ENVELOPE_PARSE_ERROR');
});
test('throwing seam/report/error getters and proxies settle rather than cause secondary faults',async()=>{
 const secret=()=>{throw Error('SENTINEL_SECRET');};
 const badError=new ContractError('invalid_contract','limited_envelope');Object.defineProperty(badError,'field',{get:secret});
 const badReport=Object.defineProperty({},'stage',{get:secret});
 for(const descriptor of [{get:secret},{value:()=>badReport},{value:()=>new Proxy({}, {get:secret})}]){
  const f=fixture({factory:()=>fakeCollector(badError,descriptor)}),r=await f.result;assert.equal(code(r),'UNCLASSIFIED:UNKNOWN_REJECTION');assertPrivate(r);
 }
});
test('stage/reason cross-product mismatches cannot export metadata',async()=>{
 for(const [stage,reason]of [['COLLECTION','CODEGEN_MARKDOWN_REJECTED'],['PAYLOAD','COLLECTION_FAILED']]){
 const f=fixture({factory:()=>fakeCollector(Error('SENTINEL_SECRET'),{value:()=>({stage,reason,metadata:{provider_reported_status:'SENTINEL_SECRET'}})})});const r=await f.result;assert.equal(code(r),'UNCLASSIFIED:UNKNOWN_REJECTION');assertPrivate(r);
 }
});
test('nested metadata getter/proxy defenses normalize before storage and again before wire',async()=>{
 const secret=()=>{throw Error('SENTINEL_SECRET');};
 const values=[Object.defineProperty({},'provider_reported_status',{get:secret}),Object.defineProperty({},'duration_seconds',{get:secret}),Object.defineProperty({},'usage',{get:secret}),{provider_reported_status:'SUCCESS',usage:Object.defineProperty({},'input',{get:secret})},{usage:new Proxy({}, {get:secret})},new Proxy({}, {get:secret})];
 for(const metadata of values){assert.equal(sanitizeDiagnosticMetadata(metadata),null);const f=fixture({factory:()=>fakeCollector(Error('secret'),{value:()=>({stage:'PAYLOAD',reason:'TASK_PAYLOAD_INVALID',metadata})})});const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.ok(Object.values(r.record.provider_metadata.usage_tokens).every(v=>v==='UNKNOWN'));assertPrivate(r);}
});
test('seam reentrant abort remains primary and record always completes',async()=>{
 const f=fixture({decoderHook(c,raw,abort){try{return c.decode(raw);}finally{abort.abort();}} ,bytes:env('```')});const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_USER_ABORT');assert.equal(code(r),'LIMITED_USER_ABORT');assert.equal(f.writes(),0);
});
test('success and primary process/spawn/deadline/IO paths retain previous status behavior',async()=>{
 const success=fixture();const r=await success.result;assert.equal(r.record.lifecycle_status,'LIMITED_SUCCESS');assert.deepEqual(r.record.error_details,{code:null,classification:null,message:null});assert.equal(success.writes(),1);
 for(const [mode,status]of [['spawn_error','LIMITED_SPAWN_FAILED'],['nonzero','LIMITED_PROCESS_FAILED'],['timeout','LIMITED_TIMEOUT'],['abort','LIMITED_USER_ABORT']]){
 const f=fixture({mode});if(mode==='abort'){await flush();f.abort.abort();}if(mode==='timeout')await f.tick(1000);await f.tick(mode==='timeout'?1010:10);assert.equal((await f.result).record.lifecycle_status,status);assert.equal(f.writes(),0);
 }
});


test('report nested accessors and arbitrary error properties are never evaluated or serialized',async()=>{
 let reads=0;const getter=()=>{reads++;throw Error('SENTINEL_SECRET');};
 const error=Object.create(ContractError.prototype);for(const key of ['field','code','message','stack','cause'])Object.defineProperty(error,key,{get:getter});
 for(const key of ['stage','reason','metadata']){
  const report={stage:'PAYLOAD',reason:'TASK_PAYLOAD_INVALID',metadata:null};Object.defineProperty(report,key,{get:getter});
  const f=fixture({factory:()=>fakeCollector(error,{value:()=>report})}),r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assertPrivate(r);
 }
 assert.equal(reads,0);
});
test('cancellation reentrant in diagnosticReport cannot be overwritten or leave result pending',async()=>{
 const f=fixture({factory:abort=>fakeCollector(Error('secret'),{value:()=>{abort.abort();return diagnosticReport('PAYLOAD','TASK_PAYLOAD_INVALID');}})});
 const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_USER_ABORT');assert.equal(code(r),'LIMITED_USER_ABORT');assert.equal(f.writes(),0);
});

 test('throwing decoded metadata rejects before persistence and settles',async()=>{
  const f=fixture({decoderHook(c,raw){const parsed=c.decode(raw);Object.defineProperty(parsed,'metadata',{get(){throw Error('SENTINEL_SECRET');}});return parsed;}});
  const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.equal(f.writes(),0);assertPrivate(r);
 });
 test('unsafe nested decoded metadata cannot escape normalization or persist',async()=>{
  const f=fixture({decoderHook(c,raw){const parsed=c.decode(raw);return {...parsed,metadata:{usage:Object.defineProperty({},'input',{get(){throw Error('SENTINEL_SECRET');}})}};}});
  const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.equal(f.writes(),0);assertPrivate(r);
 });
 test('successful decode with reentrant abort cannot start persistence',async()=>{
  const f=fixture({decoderHook(c,raw,abort){const parsed=c.decode(raw);abort.abort();return parsed;}});
  const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_USER_ABORT');assert.equal(f.writes(),0);
 });
 test('report metadata accessor falls back to finite legacy rejection',()=>{
  const report={stage:'PAYLOAD',reason:'TASK_PAYLOAD_INVALID'};Object.defineProperty(report,'metadata',{get(){throw Error('SENTINEL_SECRET');}});
  assert.deepEqual(collectorDiagnostic({diagnosticReport:()=>report},new ContractError('invalid_contract','limited_envelope')),diagnosticReport('ENVELOPE','ENVELOPE_PARSE_ERROR'));
 });

 test('invalid decoded byte views reject without persistence or secondary finalization fault',async()=>{
  for(const bytes of [new DataView(new ArrayBuffer(8)),new Proxy(new Uint8Array(8),{})]){
   const f=fixture({decoderHook(c,raw){return {...c.decode(raw),bytes};}});const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.equal(f.writes(),0);
  }
 });

 test('detached accepted buffer after injected persistence cannot strand completion',async()=>{
  const f=fixture({persistHook(bytes){structuredClone(bytes.buffer,{transfer:[bytes.buffer]});}});const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_INTERNAL_ERROR');assert.equal(code(r),'BUFFER_CLEAR_FAILED');assert.equal(f.writes(),1);
 });
