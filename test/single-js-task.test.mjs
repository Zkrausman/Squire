import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseSingleJsRequest,buildSingleJsCodegenPrompt,SINGLE_JS_PREFIX,SINGLE_JS_PREFIX_IDENTITY} from '../src/single-js-task.mjs';
import {prepareSingleJsCodexTask,validateSingleJsCodexConfig,requireSingleJsCodexAdmission,SINGLE_JS_SOURCE_FILES,SINGLE_JS_SOURCE_ROOT} from '../src/single-js-configuration.mjs';
import {runSingleJsCodexTask,executeSingleJsSyntax} from '../src/single-js-runner.mjs';
import {projectSingleJsRunSummary,formatSingleJsSummaryTerminal} from '../src/single-js-summary.mjs';
import {hash,canonicalBytes,GENERATION_SHUTDOWN,validateCodexPreflight,NODE_RUNTIME} from '../src/bounded-codegen-plan.mjs';
import {singleJsDryRun,singleJsEntrypointMode,runSingleJsOneCaseNative} from '../acceptance/single-js-entrypoint.mjs';
import {runOfflineReportCli} from '../bin/squire-report.mjs';
const enc=s=>new TextEncoder().encode(s),flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const request=(prompt='Generate a small public JavaScript utility. '.repeat(4))=>({schema:'SQUIRE2_SINGLE_JS_REQUEST_V1',task_id:'public-synthetic',task_prompt:prompt,runtime_target:'node24-esm',output_target:'src/task.mjs'});
const model='synthetic-codex',effort='synthetic-effort',auth={operator_receipt:'/synthetic/operator',supported_tuples:[{model,effort}]};
let serial=1;
const job=()=>`ba586107-7240-4d89-88d3-${String(serial++).padStart(12,'0')}`;
function memoryFS(){
 const dirs=new Set(['/synthetic']),files=new Map(),modes=new Map();
 const file=b=>({isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,mode:0o400,size:b.length});
 const fs={async mkdir(p){if(dirs.has(p))throw Object.assign(Error(),{code:'EEXIST'});dirs.add(p);},async lstat(p){if(files.has(p))return {...file(files.get(p)),mode:modes.get(p)??0o400};if(dirs.has(p))return {isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false,mode:0o700};throw Object.assign(Error(),{code:'ENOENT'});},async readFile(p){if(!files.has(p))throw Error('SYNTHETIC_MISSING');return new Uint8Array(files.get(p));},async writeFile(p,b,opts){if(opts?.flag==='wx'&&files.has(p))throw Object.assign(Error(),{code:'EEXIST'});files.set(p,new Uint8Array(b));modes.set(p,opts?.mode??0o600);},async open(p,flag){assert.equal(flag,'wx');if(files.has(p))throw Object.assign(Error(),{code:'EEXIST'});return {writeFile:async b=>{files.set(p,new Uint8Array(b));modes.set(p,0o600);},close:async()=>{}};},async link(a,b){if(files.has(b))throw Object.assign(Error(),{code:'EEXIST'});files.set(b,new Uint8Array(files.get(a)));modes.set(b,modes.get(a));},async unlink(p){files.delete(p);},async chmod(p,m){modes.set(p,m);}};
 return {fs,files,dirs};
}
async function prepared(prompt){
 const mem=memoryFS();for(const name of SINGLE_JS_SOURCE_FILES)mem.files.set(join(SINGLE_JS_SOURCE_ROOT,name),await readFile(join(SINGLE_JS_SOURCE_ROOT,name)));
 const inputs={job_id:job(),scope:'/synthetic/task-scope',codex:{path:'/synthetic/codex',bytes:1,sha256:'b'.repeat(64),version:'0.160.0'},requested_model:model,effort,authorization:auth,permissions:{sandbox:'read-only',approval_mode:'on-request',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}};
 const verified=[];const ports={fs:mem.fs,verifyFile:async id=>{verified.push(id.path);return id;},retention:()=>({prepare:async()=>({capability_status:'READY'})})};
 const output=await prepareSingleJsCodexTask('/synthetic/prepared','a'.repeat(40),request(prompt),inputs,ports);
 const bytes=mem.files.get('/synthetic/prepared/config.json'),config=JSON.parse(new TextDecoder().decode(bytes));return {...mem,inputs,ports,output,bytes,config,verified};
}
const SOURCE='// PUBLIC_SYNTHETIC_SOURCE_ONLY\n'+('export const utility = 1;\n').repeat(5);
function runtime({source=SOURCE,syntaxExit=0,abort=false,pending=false}={}){
 const mem=memoryFS(),calls=[],timers=[],controller=new AbortController();if(abort)controller.abort();let time=0;
 const clock={now:()=>time,schedule(ms,cb){const t={at:time+ms,cb,active:true};timers.push(t);return()=>{t.active=false;};}};
 const id=job(),scope='/synthetic/scope-'+id;mem.dirs.add(scope);
 const spec={job_id:id,task_scope:scope,requested_model:model,effort,max_wall_clock_sec:120,prompt_bytes:buildSingleJsCodegenPrompt(request())};
 const spawn=(kind)=>(exe,argv,opts)=>{
   calls.push({kind,exe,argv,opts});const c=new EventEmitter();c.pid=123;c.kill=()=>true;c.unref=()=>{};
   for(const name of ['stdin','stdout','stderr']){c[name]=new EventEmitter();c[name].destroy=()=>{};}
   c.stdin.write=(b,cb)=>{cb();return true;};c.stdin.end=cb=>cb();
   queueMicrotask(()=>{c.emit('spawn');queueMicrotask(()=>{if(kind==='generation'&&pending)return;if(kind==='generation')c.stdout.emit('data',enc([{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:source}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:1}}].map(v=>JSON.stringify(v)).join('\n')+'\n'));c.stdout.emit('end');c.stderr.emit('end');c.emit('exit',kind==='syntax'?syntaxExit:0,null);});});return c;
 };
 const options={clock,shutdown:GENERATION_SHUTDOWN,abortSignal:controller.signal};
 const ports={fs:mem.fs,spawn:spawn('generation'),executable:'/synthetic/codex',codex:{observed_cli_version:'0.160.0',authorization:auth},environment:{OPENAI_API_KEY:'synthetic-secret',PUBLIC:'retained'},syntax:(path,p)=>executeSingleJsSyntax(path,{...p,spawn:spawn('syntax')})};
 return {mem,calls,spec,options,ports,controller,run:()=>runSingleJsCodexTask(spec,options,ports),async advance(n){time=n;for(const t of [...timers].sort((a,b)=>a.at-b.at))if(t.active&&t.at<=time){t.active=false;t.cb();}await flush();}};
}
test('single-JS request freezes exact prefix and prompt limits without evaluating text',()=>{
 const b=enc(SINGLE_JS_PREFIX);assert.equal(b.length,SINGLE_JS_PREFIX_IDENTITY.bytes);assert.equal(hash(b),SINGLE_JS_PREFIX_IDENTITY.sha256);
 const r=parseSingleJsRequest(enc(JSON.stringify(request())+'\n'));assert.ok(Object.isFrozen(r));assert.deepEqual(buildSingleJsCodegenPrompt(r),enc(SINGLE_JS_PREFIX+r.task_prompt));
 assert.equal(buildSingleJsCodegenPrompt(request('a'.repeat(31981))).length,32768);assert.notEqual(buildSingleJsCodegenPrompt(r),buildSingleJsCodegenPrompt(r));
 for(const bad of [request('a'.repeat(99)),request('a'.repeat(31982)),request('a'.repeat(100)+'\0'),request('a'.repeat(100)+'\uD800'),{...request(),output_target:'../other.mjs'},{...request(),task_id:'/unsafe'},{...request(),extra:true}])assert.throws(()=>parseSingleJsRequest(enc(JSON.stringify(bad))));
 for(const b of [new Uint8Array([255]),new Uint8Array(65537),enc('\uFEFF{}'),enc('{"schema":"x","sch\\u0065ma":"y"}'),enc('{"__proto__":"x"}'),enc('{"task_prompt":[]}')])assert.throws(()=>parseSingleJsRequest(b));
});
test('two unrelated prompts prepare without Q218 task/fixture access, dispatch or model defaults',async()=>{
 const a=await prepared(),b=await prepared('Different public JavaScript request. '.repeat(5));
 assert.notEqual(a.output.prompt_sha256,b.output.prompt_sha256);assert.equal(a.output.runtime_admitted,false);assert.equal(a.output.task_correctness,'NOT_EVALUATED');assert.equal(a.config.schema,'SQUIRE2_SINGLE_JS_OPERATION_V1');assert.equal(Object.hasOwn(a.config,'fixtures'),false);assert.equal(a.config.permissions.approval_mode,'on-request');assert.equal(a.config.max_direct_child_spawns,2);assert.ok(a.verified.includes(NODE_RUNTIME.path));
 assert.equal(JSON.stringify(a.config).includes('SQUIRE-MVP-BENCHMARK'),false);await assert.rejects(prepareSingleJsCodexTask('/synthetic/prepared','a'.repeat(40),request(),a.inputs,a.ports));
 const altered={...a.inputs,requested_model:'not-admitted'};await assert.rejects(prepareSingleJsCodexTask('/synthetic/other','a'.repeat(40),request(),altered,a.ports));
});
test('generic config/admission/preflight bind exact frozen tuple, identities and explicit scope',async()=>{
 const f=await prepared(),c=f.config,bytes=f.bytes;
 const a={provider_id:'native_codex',operator_receipt:auth.operator_receipt,config_sha256:hash(bytes),job_id:c.job_id,scope:c.scope,single_js_admitted:true,preflight:{evidence_receipt:'/synthetic/preflight'}};
 assert.equal(requireSingleJsCodexAdmission(a,c,bytes).single_js_admitted,true);
 for(const change of [{single_js_admitted:false},{config_sha256:'f'.repeat(64)},{scope:'/different'},{fix17_paths_admitted:true}])assert.throws(()=>requireSingleJsCodexAdmission({...a,...change},c,bytes));
 const proof={operation_config_sha256:hash(bytes),observed_at_ms:1000,provider_id:'native_codex',cli_version:'0.160.0',executable_sha256:c.codex.sha256,requested_model:model,effort,operator_receipt:auth.operator_receipt,subscription:true,allowance_available:true,effective_provider:'openai_subscription',no_api_or_paid_fallback:true,sandbox:'read-only',approval_mode:'on-request',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1',installed_flags_verified:true};
 assert.equal(validateCodexPreflight(proof,c,bytes,1000),true);assert.throws(()=>validateCodexPreflight(proof,c,bytes,301001));
 assert.throws(()=>validateSingleJsCodexConfig({...c,target_file:{workspace_relative_path:'/other'}}));assert.throws(()=>validateSingleJsCodexConfig({...c,max_direct_child_spawns:3}));
 await assert.rejects(runSingleJsOneCaseNative(null,null),/UNADMITTED_NATIVE_OPERATION/);assert.equal(singleJsEntrypointMode([]),'DRY_RUN_NATIVE_DISABLED');assert.equal(singleJsDryRun().direct_child_invocations,0);
});
test('fake runner stages fixed task.mjs, checks syntax once and never claims task correctness',async()=>{
 const f=runtime(),r=await f.run();assert.equal(r.status,'CANDIDATE_READY');assert.equal(r.task_correctness,'NOT_EVALUATED');assert.equal(r.task_outcome_evaluated,false);assert.deepEqual(f.calls.map(c=>c.kind),['generation','syntax']);assert.equal(f.calls[0].opts.env.OPENAI_API_KEY,undefined);assert.deepEqual(f.calls[1].argv,['--check',r.source.source_path]);assert.equal(f.calls[1].opts.env.NODE_OPTIONS,undefined);assert.equal(r.source.source_path.endsWith('/workspace/src/task.mjs'),true);assert.equal(r.generation.record.task_class,'SINGLE_JS_CODEGEN_V1');assert.equal(r.generation.record.provider_metadata.provider_reported_status,'turn.completed');assert.equal(JSON.stringify(r).includes('PUBLIC_SYNTHETIC_SOURCE_ONLY'),false);
 const summary=projectSingleJsRunSummary(JSON.parse(JSON.stringify(r)));assert.equal(summary.readiness,'CANDIDATE_READY');assert.equal(summary.task_correctness,'NOT_EVALUATED');assert.equal(Object.hasOwn(summary,'fixtures'),false);assert.equal(formatSingleJsSummaryTerminal(summary).includes('/synthetic'),false);
 await assert.rejects(f.run(),/limited_nonreuse|single_js_nonreuse/);
});
test('generation rejection, syntax failure and pre-abort stop without retry or functional evaluation',async()=>{
 for(const [settings,status,kinds]of [[{source:''},'GENERATION_REJECTED',['generation']],[{syntaxExit:1},'SYNTAX_REJECTED',['generation','syntax']],[{abort:true},'INCOMPLETE',[]]]){const f=runtime(settings),r=await f.run();assert.equal(r.status,status);assert.deepEqual(f.calls.map(c=>c.kind),kinds);assert.equal(r.task_correctness,'NOT_EVALUATED');assert.equal(r.workspace_disposition,'QUARANTINED');assert.equal(projectSingleJsRunSummary(JSON.parse(JSON.stringify(r))).readiness,status);}
});
test('generic reporting has separate discriminator, no17fixture fabrication and no functional PASS exit',async()=>{
 const f=runtime(),r=JSON.parse(JSON.stringify(await f.run()));let out='',err='';const bytes=enc(JSON.stringify(r));
 const code=await runOfflineReportCli(['/synthetic/result'],{readFile:async()=>bytes,stat:async()=>({isFile:()=>true,size:bytes.length}),stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}});assert.equal(code,1);assert.equal(err,'');assert.match(out,/Task correctness: NOT_EVALUATED/);assert.equal(out.includes('17 PASS'),false);
 for(const mutate of [r=>{r.task_correctness='PASS';},r=>{r.generation.runtime_evidence.timeout_latched=true;},r=>{r.source.source_sha256='f'.repeat(64);},r=>{r.syntax.observation.syntax_valid=false;},r=>{r.private_capture='/secret';}]){const c=structuredClone(r);mutate(c);assert.equal(projectSingleJsRunSummary(c).readiness,'INVALID_RECEIPT');}
 assert.equal(projectSingleJsRunSummary(singleJsDryRun()).readiness,'NOT_RUN');
 const forged=structuredClone(projectSingleJsRunSummary(r));forged.generation=null;forged.syntax=null;forged.artifact=null;
 assert.match(formatSingleJsSummaryTerminal(forged),/INVALID_RECEIPT/);
 const bad=r;bad.generation.record.provider_metadata.provider_reported_status='SUCCESS';assert.equal(projectSingleJsRunSummary(bad).readiness,'INVALID_RECEIPT');
});
test('generic pending stdin/output obey original deadline and abort without a retry or syntax child',async()=>{
 for(const abort of [true,false]){
  const f=runtime({pending:true}),p=f.run();await flush();if(abort)f.controller.abort();else await f.advance(120000);
  await f.advance(abort?3000:123000);await f.advance(abort?5000:125000);const r=await p;
  assert.equal(r.status,'INCOMPLETE');assert.equal(r.generation.record.lifecycle_status,abort?'LIMITED_USER_ABORT':'LIMITED_TIMEOUT');assert.equal(r.generation.record.process_exit.observed_termination,false);assert.deepEqual(f.calls.map(c=>c.kind),['generation']);assert.equal(r.generation.record.containment_evidence.settlement_status,'ABANDONED_UNSETTLED');
 }
});
test('post-syntax changed bytes cannot be promoted to candidate readiness',async()=>{
 const f=runtime(),original=f.ports.syntax;f.ports.syntax=async(path,ports)=>{const result=await original(path,ports);f.mem.files.set(path,enc(SOURCE+'// changed'));return result;};
 const r=await f.run();assert.equal(r.status,'FAILED');assert.equal(r.syntax.wrapper_status,'UNKNOWN');assert.equal(r.task_correctness,'NOT_EVALUATED');
});
