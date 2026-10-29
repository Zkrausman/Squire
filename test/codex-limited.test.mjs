import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {prepareCodexArgv,validateCodexPrompt,codexEnvironment} from '../src/codex-profile.mjs';
import {createCodexCodegenStreamCollector} from '../src/limited-stream-collector.mjs';
import {decodeCodexJsonl} from '../src/provider-metadata.mjs';
import {runForeground} from '../src/internal/limited-core.mjs';
import {runBoundedCodegenCodexTask,runLimitedAgyTask} from '../src/limited-runner.mjs';
import {boundCodexConfig,runBoundedCodegenOneCaseNativeCodex} from '../acceptance/bounded-codegen-entrypoint.mjs';
import {buildBoundedCodegenManifest,prepareBoundedCodegen} from '../acceptance/prepare-bounded-codegen.mjs';
import {validateCodexOperationConfig,codexFixtureConfigurations,CODEX_ENVIRONMENT_POLICY,PUBLIC_FREEZE_ROOT} from '../src/bounded-codegen-configuration.mjs';
import {requireCodexAdmission,validateCodexPreflight,NODE_RUNTIME,GENERATION_SHUTDOWN,canonicalBytes,hash} from '../src/bounded-codegen-plan.mjs';
import {RETENTION_POLICY} from '../src/local-rejected-retention.mjs';
const enc=s=>new TextEncoder().encode(s),flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const MODEL='mock-codex-model-v1',EFFORT='mock-effort-standard';
const authorization={operator_receipt:'/synthetic/operator.json',supported_tuples:[{model:MODEL,effort:EFFORT}]};
const SOURCE='// PUBLIC_SYNTHETIC_SOURCE_ONLY\n'+('export const synthetic = 1;\n').repeat(5);
const message=text=>({type:'item.completed',item:{type:'agent_message',text}}),terminal={type:'turn.completed',usage:{input_tokens:0,output_tokens:5,cached_input_tokens:0,reasoning_output_tokens:2}};
const lines=events=>enc(events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n')+'\n');
const stream=(text=SOURCE)=>lines([{type:'turn.started'},message(text),terminal]);
const profile={requested_model:MODEL,effort:EFFORT,observed_cli_version:'0.160.0',prompt_bytes:enc('public synthetic prompt'),authorization,permissions:{sandbox:'read-only',approval_mode:'on-request',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}};
function collect(bytes){const c=createCodexCodegenStreamCollector();c.chunk('stdout',bytes);c.eof('stdout');c.eof('stderr');return c;}
test('Codex profile requires exact explicit tuple/version and closed non-shell argv',()=>{
 const p=prepareCodexArgv(profile);assert.equal(p.runtime_admitted,false);
 const expected=mode=>['--ask-for-approval',mode,'exec','--json','--ephemeral','--sandbox','read-only','--model',MODEL,'-c','model_reasoning_effort="mock-effort-standard"','-'];
 assert.deepEqual(p.argv,expected('on-request'));
 assert.deepEqual(prepareCodexArgv({...profile,permissions:{...profile.permissions,approval_mode:'never'}}).argv,expected('never'));
 for(const bad of [{requested_model:undefined},{effort:undefined},{requested_model:'gemini-3.8-flash-high'},{effort:'high'},{observed_cli_version:'0.159.0'},{effort:'x";arbitrary'}])assert.throws(()=>prepareCodexArgv({...profile,...bad}));
 const missing={...profile};delete missing.permissions;assert.throws(()=>prepareCodexArgv(missing));
 for(const permissions of [
  {...profile.permissions,approval_mode:'automatic'},
  {...profile.permissions,sandbox:'workspace-write'},
  {...profile.permissions,output_contract:'OTHER'},
  {...profile.permissions,unknown:'value'},
  {...profile.permissions,extra:true}
 ])assert.throws(()=>prepareCodexArgv({...profile,permissions}));
 let reads=0;const accessor={sandbox:'read-only',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'};
 Object.defineProperty(accessor,'approval_mode',{enumerable:true,get(){reads++;return 'never';}});
 assert.throws(()=>prepareCodexArgv({...profile,permissions:accessor}));assert.equal(reads,0);
 let traps=0;const proxy=new Proxy(profile.permissions,{get(){traps++;throw Error('trap');}});
 assert.throws(()=>prepareCodexArgv({...profile,permissions:proxy}));assert.equal(traps,0);
 assert.throws(()=>prepareCodexArgv({...profile,authorization:{operator_receipt:'',supported_tuples:authorization.supported_tuples}}));
});
test('Codex prompt accepts exact bound and rejects encoding, empty and proxy without traps',()=>{
 assert.equal(validateCodexPrompt(new Uint8Array(32768).fill(65)).valid,true);
 for(const v of [enc(''),new Uint8Array(32769),enc('\uFEFFx'),enc('a\0b'),new Uint8Array([0xff]),new Uint8Array([0xed,0xa0,0x80])])assert.equal(validateCodexPrompt(v).valid,false);
 let traps=0;assert.equal(validateCodexPrompt(new Proxy(enc('public'),{get(){traps++;throw 0;}})).valid,false);assert.equal(traps,0);
});
test('Codex environment deletion preserves unrelated synthetic settings without route claims',()=>{
 const a={OPENAI_API_KEY:'fake',CODEX_API_KEY:'fake',OPENAI_BASE_URL:'fake',GEMINI_API_KEY:'fake',GOOGLE_API_KEY:'fake',GOOGLE_GEMINI_BASE_URL:'fake',PUBLIC:'synthetic'};
 assert.deepEqual(codexEnvironment('/synthetic',a),{PUBLIC:'synthetic',TMPDIR:'/synthetic/.tmp'});assert.equal(a.OPENAI_API_KEY,'fake');
});
test('Codex private source collector and pure metadata decoder keep content separate',()=>{
 const bytes=stream(),c=collect(bytes),p=c.decode({exit_code:0,exit_signal:null,process_wall_ms:0});
 assert.deepEqual(p.bytes,enc(SOURCE));assert.equal(p.metadata.provider_reported_status,'turn.completed');
 assert.deepEqual(p.metadata.usage,{input:0,output:5,cache_read:0,thinking:null,total:null});assert.equal(p.metadata.extra_metadata.codex_reasoning_output_tokens,2);
 assert.equal(JSON.stringify(p.metadata).includes('PUBLIC_SYNTHETIC_SOURCE_ONLY'),false);
 const pure=decodeCodexJsonl({raw_payload_bytes:bytes,max_response_bytes:1048576,wrapper_exit_code:0,wrapper_signal:null,wrapper_wall_ms:0});assert.equal(JSON.stringify(pure).includes('PUBLIC_SYNTHETIC_SOURCE_ONLY'),false);
});
for(const [name,events,reason]of [
 ['multiple',[{type:'turn.started'},message(SOURCE),message(SOURCE),terminal],'AMBIGUOUS_AGENT_MESSAGE'],
 ['missing',[{type:'turn.started'},terminal],'RESPONSE_STRING_REQUIRED'],
 ['nonstring',[{type:'turn.started'},message(null),terminal],'RESPONSE_STRING_REQUIRED'],
 ['failed',[{type:'turn.failed',error:{message:'PRIVATE_ERROR_SENTINEL'}}],'TURN_FAILED'],
 ['error',[{type:'error',message:'PRIVATE_ERROR_SENTINEL'}],'MISSING_TERMINAL'],
 ['repeated',[terminal,terminal],'REPEATED_TERMINAL_REJECTED'],
 ['conflicting',[terminal,{type:'turn.failed'}],'CONFLICTING_TERMINAL_EVENTS'],
 ['trailing',[{type:'turn.started'},message(SOURCE),terminal,{type:'thread.started'}],'TRAILING_DATA_AFTER_TERMINAL'],
 ['malformed',[terminal,'{"incomplete":'],'MALFORMED_JSON'],
 ['duplicate',['{"type":"turn.completed","usage":{"input_tokens":1,"\\u0069nput_tokens":2}}'],'DUPLICATE_KEY_CONFLICT'],
 ['missinginit',[message(SOURCE),terminal],'ENVELOPE_PARSE_ERROR'],
 ['standalone-success',[{status:'SUCCESS',response:SOURCE}],'MISSING_TERMINAL']]){
 test('Codex collector fails closed '+name,()=>{const c=collect(lines(events));assert.throws(()=>c.decode({exit_code:0}));assert.equal(c.diagnosticReport().reason,reason);assert.equal(JSON.stringify(c.diagnosticReport()).includes('PRIVATE_ERROR_SENTINEL'),false);});
}
for(const [name,text,reason]of [['empty','','CODEGEN_PAYLOAD_TOO_SMALL'],['short','x','CODEGEN_PAYLOAD_TOO_SMALL'],['markdown','```'+SOURCE,'CODEGEN_MARKDOWN_REJECTED'],['large','x'.repeat(65537),'CODEGEN_PAYLOAD_TOO_LARGE'],['encoding','\ud800','CODEGEN_ENCODING_REJECTED']]){
 test('Codex source payload '+name+' preserves validation and private retention',()=>{const c=collect(stream(text));assert.throws(()=>c.decode({exit_code:0}));assert.equal(c.diagnosticReport().reason,reason);const capture=c.diagnosticCapture();assert.equal(capture.eligible,name!=='encoding');if(name!=='encoding')assert.equal(capture.exact_response_bytes,enc(text).length);assert.equal(JSON.stringify(c.diagnosticReport()).includes(SOURCE),false);c.close();assert.equal(c.diagnosticCapture(),null);assert.throws(()=>c.decode({exit_code:0}));});
}
test('Codex caps and malformed UTF8 never promote accepted prefixes',()=>{
 const c=createCodexCodegenStreamCollector();assert.equal(c.chunk('stdout',new Uint8Array(1048576)),true);assert.equal(c.chunk('stdout',enc('x')),false);c.eof('stdout');c.eof('stderr');assert.throws(()=>c.decode({}));
 const d=collect(new Uint8Array([0xff]));assert.throws(()=>d.decode({}));assert.equal(d.diagnosticReport().reason,'MALFORMED_UTF8');
 const e=createCodexCodegenStreamCollector();assert.equal(e.chunk('stderr',new Uint8Array(65536)),true);assert.equal(e.chunk('stderr',enc('x')),false);
});
let serial=1;
function runtime(mode='normal'){
 let time=0;const timers=[],kills=[],calls=[],writes=[];let saved=null;
 const child=new EventEmitter();child.pid=123;child.unref=()=>{};child.kill=s=>{kills.push(s);return true;};
 for(const n of ['stdout','stderr','stdin']){child[n]=new EventEmitter();child[n].destroy=()=>{};}
 let writeCallback,endCallback;
 child.stdin.write=(bytes,callback)=>{writes.push(new Uint8Array(bytes));writeCallback=callback;if(mode==='error')callback(Error('PRIVATE_PIPE_SENTINEL'));else if(mode!=='pending')callback();return mode!=='backpressure';};
 child.stdin.end=callback=>{endCallback=callback;if(mode!=='endpending')callback();};
 const clock={now:()=>time,schedule(delay,callback){const t={at:time+delay,callback,active:true};timers.push(t);return()=>{t.active=false;};}};
 const controller=new AbortController(),spec={job_id:'12345678-1234-4abc-8def-'+String(serial++).padStart(12,'0'),task_scope:'/synthetic',requested_model:MODEL,effort:EFFORT,max_wall_clock_sec:120,prompt_bytes:profile.prompt_bytes};
 const ports={clock,environment:{TMPDIR:'/synthetic/.tmp'},spawn(executable,args,opts){calls.push({executable,args,opts});queueMicrotask(()=>child.emit('spawn'));return child;},persist:async bytes=>{saved=new Uint8Array(bytes);},createCollector:createCodexCodegenStreamCollector};
 const options={clock,shutdown:{term_grace_ms:30,kill_grace_ms:20,poll_interval_ms:10,stream_drain_timeout_ms:10,persistence_timeout_ms:20},output_path:'/synthetic/source',abortSignal:controller.signal};
 return {spec,ports,options,child,controller,writes,kills,calls,get saved(){return saved;},callback:(e)=>writeCallback?.(e),endCallback:e=>endCallback?.(e),
 run(){return runForeground({...spec,provider_id:'native_codex',task_class:'BOUNDED_CODEGEN_SUMMARIZER_V5'},{executable:'/synthetic/codex',args:prepareCodexArgv(profile).argv,stdin_bytes:spec.prompt_bytes},options,ports);},
 end(bytes=stream(),code=0){child.stdout.emit('data',bytes);child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',code,null);},
 async advance(n){time=n;for(const t of [...timers].sort((a,b)=>a.at-b.at))if(t.active&&t.at<=time){t.active=false;t.callback();}await flush();}};
}
test('fake Codex core writes prompt once, closes stdin, stages source and preserves reasoning separately',async()=>{
 const f=runtime(),p=f.run();await flush();f.end();const r=await p;
 assert.equal(r.record.lifecycle_status,'LIMITED_SUCCESS');assert.deepEqual(f.saved,enc(SOURCE));assert.deepEqual(f.writes,[profile.prompt_bytes]);assert.deepEqual(f.calls[0].opts.stdio,['pipe','pipe','pipe']);assert.equal(f.calls[0].opts.shell,false);
 assert.equal(r.record.provider_metadata.usage_tokens.thinking,'UNKNOWN');assert.equal(r.record.provider_metadata.usage_tokens.total,'UNKNOWN');assert.equal(r.record.provider_metadata.codex_reasoning_output_tokens,2);assert.equal(r.record.provider_metadata.duration_seconds,null);assert.equal(r.record.task_outcome_evaluated,false);assert.equal(JSON.stringify(r).includes('PUBLIC_SYNTHETIC_SOURCE_ONLY'),false);
});
test('stdin backpressure requires drain, and early exit never masquerades as delivery',async()=>{
 const good=runtime('backpressure'),p=good.run();await flush();good.child.stdin.emit('drain');good.end();assert.equal((await p).record.lifecycle_status,'LIMITED_SUCCESS');
 for(const mode of ['pending','backpressure','endpending','error']){const f=runtime(mode),q=f.run();await flush();f.end();const r=await q;assert.equal(r.record.lifecycle_status,'LIMITED_PROCESS_FAILED');assert.equal(r.record.error_details.code,'STDIN_WRITE_FAILED');assert.equal(f.saved,null);f.child.stdin.emit('error',Error('late private'));f.callback();f.endCallback();}
});
test('stdin idle retains original deadline; abort and timeout preserve primary outcomes and bounded stop',async()=>{
 for(const aborted of [false,true]){const f=runtime('pending'),p=f.run();await flush();if(aborted)f.controller.abort();else await f.advance(120000);
 assert.deepEqual(f.kills,['SIGTERM']);await f.advance(aborted?30:120030);assert.deepEqual(f.kills,['SIGTERM','SIGKILL']);await f.advance(aborted?50:120050);
 const r=await p;assert.equal(r.record.lifecycle_status,aborted?'LIMITED_USER_ABORT':'LIMITED_TIMEOUT');assert.equal(r.record.process_exit.observed_termination,false);assert.equal(r.record.containment_evidence.settlement_status,'ABANDONED_UNSETTLED');f.callback();assert.equal(f.saved,null);}
});
test('raw exit and stream drain still gate Codex success independently of terminal',async()=>{
 const f=runtime(),p=f.run();await flush();f.end(stream(),9);assert.equal((await p).record.lifecycle_status,'LIMITED_PROCESS_FAILED');assert.equal(f.saved,null);
 const g=runtime(),q=g.run();await flush();g.child.stdout.emit('data',stream());g.child.emit('exit',0,null);await g.advance(10);const r=await q;assert.equal(r.record.io_state.io_drained,false);assert.notEqual(r.record.lifecycle_status,'LIMITED_SUCCESS');
});
function fakeFS(){
 const dirs=new Set(['/synthetic']),files=new Map(),modes=new Map();const st=(file,mode)=>({isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false,mode});
 const fs={async mkdir(p){if(dirs.has(p))throw Object.assign(Error(),{code:'EEXIST'});dirs.add(p);},async lstat(p){if(files.has(p))return st(true,modes.get(p));if(dirs.has(p))return st(false,0o700);throw Object.assign(Error(),{code:'ENOENT'});},async open(p,flag){assert.equal(flag,'wx');if(files.has(p))throw Object.assign(Error(),{code:'EEXIST'});return {async writeFile(b){files.set(p,new Uint8Array(b));modes.set(p,0o600);},async close(){}};},async readFile(p){return new Uint8Array(files.get(p));},async link(a,b){if(files.has(b))throw Object.assign(Error(),{code:'EEXIST'});files.set(b,new Uint8Array(files.get(a)));modes.set(b,modes.get(a));},async unlink(p){files.delete(p);},async chmod(p,m){modes.set(p,m);}};return {fs,files,dirs};
}
test('Codex runner actually wires explicit private executable, stdin, collector and physical stage through fakes',async()=>{
 const f=runtime(),fs=fakeFS(),path='/synthetic/output/run-'+f.spec.job_id+'/workspace/src/summarizer.mjs';
 const permissions=config().permissions;
 const p=runBoundedCodegenCodexTask(f.spec,{...f.options,output_path:path},{...f.ports,fs:fs.fs,executable:'/synthetic/codex',codex:{observed_cli_version:'0.160.0',authorization,permissions}});
 await flush();f.end();const r=await p;assert.equal(r.record.lifecycle_status,'LIMITED_SUCCESS');assert.equal(r.physical_source_witness.source_path,path);assert.equal(r.runtime_admitted,false);assert.deepEqual(fs.files.get(path),enc(SOURCE));assert.deepEqual(f.writes,[f.spec.prompt_bytes]);assert.equal(f.calls[0].executable,'/synthetic/codex');
 assert.deepEqual(f.calls[0].args,['--ask-for-approval','never','exec','--json','--ephemeral','--sandbox','read-only','--model',MODEL,'-c',`model_reasoning_effort=${JSON.stringify(EFFORT)}`,'-']);
 await assert.rejects(runBoundedCodegenCodexTask(f.spec,{...f.options,output_path:path},{...f.ports,fs:fs.fs,executable:'/synthetic/codex',codex:{observed_cli_version:'0.160.0',authorization,permissions}}));
});
test('bounded runner rejects absent or invalid permissions before fake spawn or runtime filesystem effects',async()=>{
 for(const permissions of [undefined,{sandbox:'workspace-write',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}]){
  const f=runtime(),io=fakeFS(),path='/synthetic/output/run-'+f.spec.job_id+'/workspace/src/summarizer.mjs',codex={observed_cli_version:'0.160.0',authorization,...(permissions===undefined?{}:{permissions})};
  await assert.rejects(runBoundedCodegenCodexTask(f.spec,{...f.options,output_path:path},{...f.ports,fs:io.fs,executable:'/synthetic/codex',codex}));
  assert.equal(f.calls.length,0);assert.deepEqual([...io.files.keys()],[]);assert.deepEqual([...io.dirs],['/synthetic']);
 }
});
function config(){
 const job_id='12345678-1234-4abc-8def-012345678901',scope='/synthetic';
 return {schema:'Q218C_OPERATION_V1',runtime_admitted:false,provider_id:'native_codex',job_id,scope,source_commit:'a'.repeat(40),source_pins:{'/synthetic/source':{bytes:1,sha256:'a'.repeat(64)}},node:NODE_RUNTIME,
 codex:{path:'/synthetic/codex',bytes:1,sha256:'b'.repeat(64),version:'0.160.0'},requested_model:MODEL,effort:EFFORT,authorization,permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'},
 prompt:{path:'/synthetic/prompt',bytes:profile.prompt_bytes.length,sha256:hash(profile.prompt_bytes)},fixtures:{path:PUBLIC_FREEZE_ROOT+'/fixtures-freeze-manifest.json',bytes:20720,sha256:'7c133ceaae9ca7466689f5e612dbd46fd8f0a300bb7fa7807d6c5cbacd4cccc7'},fixture_inputs:Array.from({length:17},(_,i)=>PUBLIC_FREEZE_ROOT+'/fixture-'+String(i+1).padStart(2,'0')+'/input.ndjson'),fixture_configs:codexFixtureConfigurations(job_id,scope),diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,preflight_freshness_ms:300000,outer_observation_ms:250000,fixture_aggregate_ms:85000,max_direct_child_spawns:19,environment_policy:CODEX_ENVIRONMENT_POLICY,task_input:{path:'/synthetic/task',bytes:1,sha256:'c'.repeat(64)}};
}
test('production bounded manifest builder feeds matching fake generation for both approval modes',async()=>{
 for(const mode of ['never','on-request']){
  const f=runtime(),io=fakeFS(),c=config();c.permissions={...c.permissions,approval_mode:mode};
  const manifest=buildBoundedCodegenManifest(c,f.spec.prompt_bytes);
  assert.equal(manifest.schema,'Q218C_PREPARED_OPERATION_MANIFEST_V1');
  assert.equal(manifest.config_sha256,hash(canonicalBytes(c)));
  assert.deepEqual(manifest.prompt,c.prompt);assert.deepEqual(manifest.source_pins,c.source_pins);
  assert.equal(manifest.generation.stdin,c.prompt);assert.equal(manifest.generation.executable,c.codex.path);
  assert.equal(manifest.generation.args[0],'--ask-for-approval');assert.equal(manifest.generation.args[1],mode);
  const path='/synthetic/output/run-'+f.spec.job_id+'/workspace/src/summarizer.mjs';
  const pending=runBoundedCodegenCodexTask(f.spec,{...f.options,output_path:path},{...f.ports,fs:io.fs,executable:c.codex.path,
   codex:{observed_cli_version:c.codex.version,authorization:c.authorization,permissions:c.permissions}});
  await flush();f.end();const result=await pending;
  assert.equal(result.record.lifecycle_status,'LIMITED_SUCCESS');assert.equal(result.runtime_admitted,false);
  assert.equal(f.calls[0].executable,manifest.generation.executable);
  assert.deepEqual(f.calls[0].args,manifest.generation.args);assert.deepEqual(f.writes,[f.spec.prompt_bytes]);
 }
});
test('production bounded manifest builder rejects permission and prompt/config mismatches before fake effects',()=>{
 const c=config(),f=runtime(),io=fakeFS(),path='/synthetic/output/run-'+f.spec.job_id+'/workspace/src/summarizer.mjs';
 const prepareThenLaunch=(candidate,promptBytes)=>{
  const manifest=buildBoundedCodegenManifest(candidate,promptBytes);
  return runBoundedCodegenCodexTask(f.spec,{...f.options,output_path:path},{...f.ports,fs:io.fs,executable:'/synthetic/codex',
   codex:{observed_cli_version:candidate.codex.version,authorization:candidate.authorization,permissions:candidate.permissions}});
 };
 const missing={...c};delete missing.permissions;
 const unsupported={...c,permissions:{...c.permissions,sandbox:'workspace-write'}};
 const badConfigHash={...c,prompt:{...c.prompt,sha256:'f'.repeat(64)}};
 const badPrompt=new Uint8Array(profile.prompt_bytes);badPrompt[0]^=1;
 assert.throws(()=>prepareThenLaunch(missing,profile.prompt_bytes));
 assert.throws(()=>prepareThenLaunch(unsupported,profile.prompt_bytes));
 assert.throws(()=>prepareThenLaunch(badConfigHash,profile.prompt_bytes));
 assert.throws(()=>prepareThenLaunch(c,badPrompt));
 assert.equal(f.calls.length,0);assert.deepEqual([...io.files.keys()],[]);assert.deepEqual([...io.dirs],['/synthetic']);
});
test('Codex config, spec, operator admission and preflight bind exact tuple/identities without CreditsOff',async()=>{
 const c=config(),bytes=enc(JSON.stringify(c)),spec={job_id:c.job_id,task_scope:c.scope,requested_model:MODEL,effort:EFFORT,max_wall_clock_sec:120,prompt_bytes:profile.prompt_bytes};
 assert.equal(validateCodexOperationConfig(c),c);boundCodexConfig(c,spec);
 for(const bad of [{...spec,prompt_bytes:enc('different')},{...spec,effort:'high'}])assert.throws(()=>boundCodexConfig(c,bad));
 const a={provider_id:'native_codex',operator_receipt:authorization.operator_receipt,config_sha256:hash(bytes),job_id:c.job_id,scope:c.scope,fix17_paths_admitted:true,preflight:{evidence_receipt:'/synthetic/preflight'}};
 assert.equal(requireCodexAdmission(a,c,bytes).provider_id,'native_codex');assert.throws(()=>requireCodexAdmission({...a,config_sha256:'f'.repeat(64)},c,bytes));
 const proof={operation_config_sha256:hash(bytes),observed_at_ms:1000,provider_id:'native_codex',cli_version:'0.160.0',executable_sha256:c.codex.sha256,requested_model:MODEL,effort:EFFORT,operator_receipt:authorization.operator_receipt,subscription:true,allowance_available:true,effective_provider:'openai_subscription',no_api_or_paid_fallback:true,sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1',installed_flags_verified:true};
 assert.equal(validateCodexPreflight(proof,c,bytes,1000),true);
 for(const bad of [{...proof,observed_at_ms:1001},{...proof,no_api_or_paid_fallback:false},{...proof,effective_provider:'api'},{...proof,effort:'high'},{...proof,approval_mode:'on-request'},{...proof,sandbox:'workspace-write'},{...proof,credits_off:true}])assert.throws(()=>validateCodexPreflight(bad,c,bytes,1000));
 let fakeDispatches=0;for(const bad of [{...proof,approval_mode:'on-request'},{...proof,sandbox:'workspace-write'}]){
  assert.throws(()=>{validateCodexPreflight(bad,c,bytes,1000);fakeDispatches++;});
 }assert.equal(fakeDispatches,0);
 assert.throws(()=>validateCodexPreflight(proof,c,bytes,301001));
 await assert.rejects(runBoundedCodegenOneCaseNativeCodex(null,null,null),/UNADMITTED_NATIVE_OPERATION/);
 await assert.rejects(runLimitedAgyTask(),/AGY_SQUIRE_RUNTIME_DISABLED/);await assert.rejects(prepareBoundedCodegen(),/AGY_SQUIRE_RUNTIME_DISABLED/);
});


test('Codex empty payload reaches only local-retention port; metadata and public result stay body-free',async()=>{
 const f=runtime();let retained=0;f.options.enableDiagnosticRetention=true;
 f.ports.retainRejected=async capture=>{retained++;assert.equal(capture.exact_response_bytes,0);assert.equal(capture.response_bytes.length,0);return {retention_status:'PUBLISHED',retention_error:null};};
 const p=f.run();await flush();f.end(stream(''));const r=await p;
 assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.equal(r.record.error_details.code,'PAYLOAD:CODEGEN_PAYLOAD_TOO_SMALL');assert.equal(r.diagnostic_retention.exact_response_bytes,0);assert.equal(r.diagnostic_retention.retention_status,'PUBLISHED');assert.equal(retained,1);assert.equal(r.record.provider_metadata.provider_reported_status,'turn.completed');assert.equal(f.saved,null);
});
test('Codex reentrant abort during stdin write and already aborted admission cannot deliver or persist',async()=>{
 const f=runtime();f.child.stdin.write=()=>{f.controller.abort();return false;};const p=f.run();await flush();f.end();assert.equal((await p).record.lifecycle_status,'LIMITED_USER_ABORT');assert.equal(f.saved,null);
 const g=runtime();g.controller.abort();const r=await g.run();assert.equal(r.record.lifecycle_status,'LIMITED_USER_ABORT');assert.equal(g.calls.length,0);assert.equal(g.writes.length,0);
});
test('Codex stdin flush error does not leak error text or become delivered',async()=>{
 const f=runtime('endpending'),p=f.run();await flush();f.endCallback(Error('PRIVATE_PIPE_SENTINEL'));f.end();const r=await p;
 assert.equal(r.record.error_details.code,'STDIN_WRITE_FAILED');assert.equal(r.record.lifecycle_status,'LIMITED_PROCESS_FAILED');assert.equal(JSON.stringify(r).includes('PRIVATE_PIPE_SENTINEL'),false);
});


test('observed nonzero Codex turn.failed preserves safe terminal metadata without overriding process failure',async()=>{
 const f=runtime(),p=f.run();await flush();f.end(lines([{type:'turn.failed',error:{message:'PRIVATE_ERROR_SENTINEL'}}]),1);const r=await p;
 assert.equal(r.record.lifecycle_status,'LIMITED_PROCESS_FAILED');assert.equal(r.record.process_exit.exit_code,1);assert.equal(r.record.provider_metadata.provider_reported_status,'turn.failed');assert.equal(r.record.error_details.code,'LIMITED_PROCESS_FAILED');assert.equal(f.saved,null);assert.equal(JSON.stringify(r).includes('PRIVATE_ERROR_SENTINEL'),false);
});
