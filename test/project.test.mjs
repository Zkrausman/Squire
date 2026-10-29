import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PROJECT_CODEGEN_PREFIX,PROJECT_PREFIX_IDENTITY,parseProjectRequest,validateProjectRequest,buildProjectCodegenPrompt,validateProjectPayloadJson} from '../src/project-task.mjs';
import {createCodexProjectStreamCollector} from '../src/project-stream-collector.mjs';
import {runProjectCodexTask} from '../src/project-runner.mjs';
import {projectDryRun,projectEntrypointMode,runProjectOneCaseNative} from '../acceptance/project-entrypoint.mjs';
import {prepareProjectCodexTask,validateProjectCodexConfig,requireProjectCodexAdmission,PROJECT_SOURCE_FILES,PROJECT_SOURCE_ROOT} from '../src/project-configuration.mjs';
import {runProjectPreparationCli} from '../acceptance/prepare-project-task.mjs';
import {GENERATION_SHUTDOWN,canonicalBytes,hash} from '../src/bounded-codegen-plan.mjs';
import {takeRejectedCapture} from '../src/internal/rejected-capture.mjs';
import {verifyStage} from '../src/multifile-staging.mjs';
const enc=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b),flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const request={schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'synthetic',task_prompt:'Public synthetic project instructions.',runtime_target:'node24-esm',stage_target:'multifile-candidate'};
const file=(path='src/index.mjs',classification='SOURCE',encoding='utf-8',content='export const publicSynthetic = 1;\n')=>({path,classification,encoding,content});
const envelope=(files=[file()])=>JSON.stringify({schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',files});
const message=text=>({type:'item.completed',item:{type:'agent_message',text}}),terminal={type:'turn.completed',usage:{input_tokens:0,output_tokens:3,cached_input_tokens:0,reasoning_output_tokens:1}};
const jsonl=events=>enc(events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n')+'\n'),stream=text=>jsonl([{type:'turn.started'},message(text),terminal]);
function collector(text=envelope()){const c=createCodexProjectStreamCollector();c.chunk('stdout',stream(text));c.eof('stdout');c.eof('stderr');return c;}
test('project exact reviewed prefix, one-byte minimum and inclusive prompt budget preserve original bytes',()=>{
 assert.equal(enc(PROJECT_CODEGEN_PREFIX).length,1030);assert.equal(PROJECT_PREFIX_IDENTITY.sha256,'9b213319932227f2a9c46c8dfe7b666f188beb4c5d1d2e18fbd2f52b3aca455e');assert.equal(hash(enc(PROJECT_CODEGEN_PREFIX)),PROJECT_PREFIX_IDENTITY.sha256);
 const tiny={...request,task_prompt:'x'};assert.equal(buildProjectCodegenPrompt(tiny).length,1031);assert.deepEqual(parseProjectRequest(enc(JSON.stringify(tiny))),tiny);assert.equal(buildProjectCodegenPrompt({...request,task_prompt:'a'.repeat(31738)}).length,32768);
 for(const prompt of ['', 'a'.repeat(31739),'\uFEFFx','x\0y','\ud800'])assert.throws(()=>validateProjectRequest({...request,task_prompt:prompt}));
 for(const v of [{...request,unexpected:'x'},{...request,runtime_target:'shell'},{...request,stage_target:'repo'}])assert.throws(()=>validateProjectRequest(v));
 assert.throws(()=>parseProjectRequest(enc(JSON.stringify(request).replace('"schema":','"schema":"duplicate","schema":'))),e=>e.field==='DUPLICATE_KEY_CONFLICT');
 assert.throws(()=>parseProjectRequest(new Uint8Array([255])));assert.throws(()=>parseProjectRequest(new Proxy(enc('{}'),{})));
});
test('project mixed payload decodes independent exact bytes, small SOURCE and opaque base64 assets',()=>{
 const raw=envelope([file(),file('assets/a.bin','LOCAL_ASSET','base64','AP8K'),file('README.md','DOC','utf-8','')]);const p=validateProjectPayloadJson(enc(raw));assert.equal(p.files.length,3);assert.ok(p.files[0].bytes<100);assert.deepEqual(p.files[1].content,new Uint8Array([0,255,10]));assert.equal(p.files[2].bytes,0);assert.equal(p.files[1].sha256,hash(new Uint8Array([0,255,10])));
 const b=enc(raw),q=validateProjectPayloadJson(b);b.fill(0);assert.notEqual(q.files[0].content[0],0);
});
for(const [name,text,reason]of [
 ['empty','','PROJECT_PAYLOAD_TOO_SMALL'],['markdown','```'+envelope(),'PROJECT_MARKDOWN_REJECTED'],['schema','{}','PROJECT_SCHEMA_MISMATCH'],['duplicate','{"schema":"x","\\u0073chema":"y","files":[]}','PROJECT_DUPLICATE_KEY'],
 ['nested-duplicate','{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"a","path":"b","classification":"SOURCE","encoding":"utf-8","content":"a"}]}','PROJECT_DUPLICATE_KEY'],
 ['traversal',envelope([file('../escape')]),'PROJECT_PATH_TRAVERSAL'],['reserved',envelope([file('src/stage-manifest.json')]),'PROJECT_PATH_TRAVERSAL'],['bucket',envelope([file('frames/x')]),'PROJECT_PATH_TRAVERSAL'],['device',envelope([file('CON.txt')]),'PROJECT_PATH_TRAVERSAL'],
 ['casecollision',envelope([file('A'),file('a')]),'PROJECT_PATH_COLLISION'],['prefixcollision',envelope([file('a'),file('a-b'),file('a/b')]),'PROJECT_PATH_COLLISION'],['observed-evidence',envelope([file('x','EVIDENCE_LOG')]),'PROJECT_CLASSIFICATION_INVALID'],['frame',envelope([file('x','FRAME_CAPTURE')]),'PROJECT_CLASSIFICATION_INVALID'],
 ['encoding',envelope([file('x','SOURCE','hex')]),'PROJECT_ENCODING_INVALID'],['base64',envelope([file('x','LOCAL_ASSET','base64','!!!!')]),'PROJECT_BASE64_INVALID'],['base64-padbits',envelope([file('x','SOURCE','base64','YR==')]),'PROJECT_BASE64_INVALID'],['zero-source',envelope([file('x','SOURCE','base64','')]),'PROJECT_FILE_SIZE_EXCEEDED'],
 ['large-file',envelope([file('x','SOURCE','utf-8','x'.repeat(65537))]),'PROJECT_FILE_SIZE_EXCEEDED'],['overcount',envelope(Array.from({length:26},(_,i)=>file('f'+i))),'PROJECT_AGGREGATE_CAPACITY_EXCEEDED'],['surrogate',envelope([file('x','SOURCE','utf-8','\ud800')]),'PROJECT_ENCODING_REJECTED']
])test('project envelope fails closed '+name,()=>assert.throws(()=>validateProjectPayloadJson(enc(text)),e=>e.field===reason));
test('project collector preserves exact envelope preimage independently from decoded files and safe metadata',()=>{
 const raw=' \n'+envelope()+'\t',c=collector(raw),p=c.decode({exit_code:0});assert.equal(decode(p.bytes),raw);assert.equal(p.metadata.usage.input,0);assert.equal(p.metadata.extra_metadata.codex_reasoning_output_tokens,1);assert.equal(JSON.stringify(p.metadata).includes('publicSynthetic'),false);p.bytes.fill(0);assert.notEqual(p.payload.files[0].content[0],0);c.close();assert.ok(p.payload.files[0].content.every(x=>x===0));assert.throws(()=>c.decode({}));
});
test('literal surrogate in original response is rejected before lossy TextEncoder normalization',()=>{
 const raw=envelope().replace('publicSynthetic','public\ud800Synthetic'),c=collector(raw);assert.throws(()=>c.decode({exit_code:0}));assert.equal(c.diagnosticReport().reason,'PROJECT_ENCODING_REJECTED');assert.equal(c.diagnosticCapture(),null);
});
test('project retention is eligible only for bounded size/markdown errors and keeps noneligible absence honest',()=>{
 for(const text of ['', '```public synthetic']){const c=collector(text);assert.throws(()=>c.decode({exit_code:0}));const p=takeRejectedCapture(c);assert.equal(p.eligible,true);assert.equal(p.exact_response_bytes,enc(text).length);c.close();}
 for(const text of ['{}',envelope([file('../x')]),envelope([file('x','SOURCE','base64','!!!!')])]){const c=collector(text);assert.throws(()=>c.decode({exit_code:0}));assert.equal(takeRejectedCapture(c),null);assert.equal(JSON.stringify(c.diagnosticReport()).includes('publicSynthetic'),false);}
});
test('project JSONL ambiguity, missing/failed/trailing terminals and stream caps fail closed',()=>{
 for(const events of [[{type:'turn.started'},message(envelope()),message(envelope()),terminal],[message(envelope()),terminal],[{type:'turn.started'},message(envelope())],[{type:'turn.failed',error:{message:'PRIVATE_SENTINEL'}}],[{type:'turn.started'},message(envelope()),terminal,terminal],[{type:'turn.started'},message(envelope()),terminal,{type:'thread.started'}]]){const c=createCodexProjectStreamCollector();c.chunk('stdout',jsonl(events));c.eof('stdout');c.eof('stderr');assert.throws(()=>c.decode({exit_code:0}));assert.equal(JSON.stringify(c.diagnosticReport()).includes('PRIVATE_SENTINEL'),false);}
 const c=createCodexProjectStreamCollector();assert.equal(c.chunk('stdout',new Uint8Array(1048576)),true);assert.equal(c.chunk('stdout',enc('x')),false);c.eof('stdout');c.eof('stderr');assert.throws(()=>c.decode({}));const d=createCodexProjectStreamCollector();assert.equal(d.chunk('stderr',new Uint8Array(65537)),false);
});
let serial=1;const id=()=> '8d9ee341-6fa3-4acc-8b93-'+String(serial++).padStart(12,'0');
const MODEL='mock-project-model',EFFORT='mock-project-effort',authorization={operator_receipt:'/synthetic/operator.json',supported_tuples:[{model:MODEL,effort:EFFORT}]};
function fakeRuntime(response=envelope(),mode='normal'){
 let time=0;const timers=[],calls=[],kills=[];const controller=new AbortController(),child=new EventEmitter();child.pid=123;child.unref=()=>{};child.kill=s=>{kills.push(s);return true;};
 for(const k of ['stdout','stderr','stdin']){child[k]=new EventEmitter();child[k].destroy=()=>{};}
 child.stdin.write=(b,callback)=>{if(mode==='epipe'){callback(Error('PRIVATE_PIPE'));queueMicrotask(()=>{child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',1,null);});}else callback();return true;};
 child.stdin.end=callback=>{callback();if(mode!=='pending')queueMicrotask(()=>{child.stdout.emit('data',stream(response));child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',mode==='nonzero'?3:0,null);});};
 const clock={now:()=>time,schedule(delay,fn){const t={at:time+delay,fn,active:true};timers.push(t);return()=>{t.active=false;if(mode==='cancel-throws'&&delay===140000)throw Error('PRIVATE_CANCEL');if(mode==='cancel-aborts'&&delay===140000)controller.abort();if(mode==='cancel-expires'&&delay===140000)time=140000;};}};
 return {clock,controller,calls,kills,timers,spawn(...args){calls.push(args);queueMicrotask(()=>child.emit('spawn'));return child;},async advance(n){time=n;for(const t of [...timers].sort((a,b)=>a.at-b.at))if(t.active&&t.at<=time){t.active=false;t.fn();}await flush();},child};
}
async function owned(fn){const root=await fs.mkdtemp('/tmp/squire-project-source-fixture-');await fs.chmod(root,0o700);try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
function inputs(root,runtime){const spec={job_id:id(),task_scope:root,requested_model:MODEL,effort:EFFORT,max_wall_clock_sec:120,prompt_bytes:buildProjectCodegenPrompt(request)},options={clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:runtime.controller.signal},ports={fs,uid:process.getuid(),spawn:runtime.spawn,executable:'/synthetic/codex',codex:{observed_cli_version:'0.160.0',authorization,permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}},environment:{PUBLIC:'synthetic'}};return {spec,options,ports};}
test('fake provider and owned files produce exact envelope custody and separate physical stage ACK',async()=>owned(async root=>{
 const raw=' \n'+envelope([file(),file('assets/x.bin','LOCAL_ASSET','base64','AP8=')])+'\t',rt=fakeRuntime(raw),a=inputs(root,rt),r=await runProjectCodexTask(a.spec,a.options,a.ports);
 assert.equal(r.status,'CANDIDATE_STAGED');assert.equal(r.generation.record.task_class,'PROJECT_CODEGEN_V1');assert.equal(r.generation.record.output_custody.byte_count,enc(raw).length);assert.equal(await fs.readFile(r.generation.record.output_custody.path,'utf8'),raw);assert.equal(r.staging.operation_acknowledgement,'ACKNOWLEDGED');assert.notEqual(r.staging.total_bytes,enc(raw).length);assert.equal(r.task_correctness,'NOT_EVALUATED');assert.equal(r.runtime_admitted,false);assert.equal(r.operator_admitted,false);assert.equal(r.direct_child_invocations.generation,1);assert.equal(JSON.stringify(r).includes('publicSynthetic'),false);
 const stage=join(root,'output','run-'+a.spec.job_id,'stage');assert.equal((await verifyStage(stage,{fs,uid:process.getuid()})).status,'VERIFIED');assert.equal((await fs.stat(join(stage,'src/index.mjs'))).mode&0o777,0o400);assert.equal(rt.calls.length,1);assert.equal(rt.calls[0][2].shell,false);
}));
test('physical stage EEXIST never rewrites successful envelope custody or fabricates ACK',async()=>owned(async root=>{
 const rt=fakeRuntime(),a=inputs(root,rt);let sentinel;
 const io={...fs,async mkdir(path,...args){const result=await fs.mkdir(path,...args);if(path.endsWith('run-'+a.spec.job_id)){sentinel=join(path,'stage');await fs.mkdir(sentinel,{mode:0o700});}return result;}};
 const r=await runProjectCodexTask(a.spec,a.options,{...a.ports,fs:io});assert.equal(r.status,'STAGING_REJECTED');assert.equal(r.reason,'STAGING:DESTINATION_ALREADY_EXISTS');assert.equal(r.staging,null);assert.equal(r.generation.record.output_custody.persisted,true);assert.ok(r.generation.record.output_custody.path.endsWith('candidate-envelope.json'));assert.deepEqual(await fs.readdir(sentinel),[]);
}));
test('schema rejection retains safe metadata without retention port or filesystem stage',async()=>owned(async root=>{
 const rt=fakeRuntime('{}'),a=inputs(root,rt);let retain=0;const r=await runProjectCodexTask(a.spec,a.options,{...a.ports,retainRejected:async()=>{retain++;throw Error('must not call');}});assert.equal(r.status,'GENERATION_REJECTED');assert.equal(r.generation.record.error_details.code,'PAYLOAD:PROJECT_SCHEMA_MISMATCH');assert.equal(r.staging,null);assert.equal(retain,0);assert.equal(r.generation.diagnostic_retention.retention_error,null);
}));
test('nonzero raw exit and stdin error block candidate materialization',async()=>{
 for(const mode of ['nonzero','epipe'])await owned(async root=>{const rt=fakeRuntime(envelope(),mode),a=inputs(root,rt),r=await runProjectCodexTask(a.spec,a.options,a.ports);assert.equal(r.status,'GENERATION_REJECTED');assert.equal(r.staging,null);assert.equal(r.generation.record.output_custody.persisted,false);});
});
test('abort before dispatch is inert; timeout uses direct-child limits and never creates stage',async()=>{
 await owned(async root=>{const rt=fakeRuntime(),a=inputs(root,rt);rt.controller.abort();const r=await runProjectCodexTask(a.spec,a.options,a.ports);assert.equal(r.status,'INCOMPLETE');assert.equal(rt.calls.length,0);assert.deepEqual(await fs.readdir(root),[]);});
 await owned(async root=>{const rt=fakeRuntime(envelope(),'pending'),a=inputs(root,rt),pending=runProjectCodexTask(a.spec,a.options,a.ports);while(!rt.calls.length)await new Promise(resolve=>setImmediate(resolve));await flush();await rt.advance(120000);await rt.advance(130000);await rt.advance(140000);const r=await pending;assert.equal(r.status,'INCOMPLETE');assert.equal(r.staging,null);assert.equal(r.generation.record.containment_evidence.descendant_guarantee,'NONE');assert.ok(rt.kills.length>0);rt.child.emit('exit',0,null);});
});
test('outer timer cleanup exceptions are fixed safe failures and late callbacks cannot reopen completion',async()=>owned(async root=>{
 const rt=fakeRuntime(envelope(),'cancel-throws'),a=inputs(root,rt),r=await runProjectCodexTask(a.spec,a.options,a.ports);assert.equal(r.status,'FAILED');assert.equal(r.reason,'CLEANUP_FAILED_OR_UNCERTAIN');assert.equal(JSON.stringify(r).includes('PRIVATE_CANCEL'),false);for(const t of rt.timers)t.fn();assert.equal(r.status,'FAILED');
}));
test('final timer cancellation callback abort/deadline cannot promote an already physical stage ACK',async()=>{
 for(const mode of ['cancel-aborts','cancel-expires'])await owned(async root=>{const rt=fakeRuntime(envelope(),mode),a=inputs(root,rt),r=await runProjectCodexTask(a.spec,a.options,a.ports);assert.equal(r.status,'INCOMPLETE');assert.equal(r.reason,mode==='cancel-aborts'?'CANCELED':'OBSERVATION_DEADLINE');assert.equal(r.workspace_disposition,'QUARANTINED');assert.equal(r.staging.operation_acknowledgement,'ACKNOWLEDGED');assert.equal(r.task_correctness,'NOT_EVALUATED');});
});
test('staging abort while an owned IO is pending returns no ACK and retains bytes until IO settles',async()=>owned(async root=>{
 const rt=fakeRuntime(),a=inputs(root,rt);let release,settle,entered=false;const pendingIO=new Promise(resolve=>{release=resolve;}),closed=new Promise(resolve=>{settle=resolve;});const io={...fs,async open(path,...args){if(path.endsWith('/stage/src/index.mjs')){entered=true;await pendingIO;const h=await fs.open(path,...args);return new Proxy(h,{get(t,k){if(k==='close')return async()=>{await t.close();settle();};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}return fs.open(path,...args);}};
 const pending=runProjectCodexTask(a.spec,a.options,{...a.ports,fs:io});while(!entered)await new Promise(resolve=>setImmediate(resolve));rt.controller.abort();const r=await pending;assert.equal(r.status,'INCOMPLETE');assert.equal(r.staging,null);release();await closed;await flush();
}));
test('project entrypoint/default imports are inert and missing admission rejects before native IO',async()=>{
 assert.equal(projectEntrypointMode([]),'DRY_RUN_NATIVE_DISABLED');assert.equal(projectEntrypointMode(['--run-admitted','one']),'DRY_RUN_NATIVE_DISABLED');assert.equal(projectEntrypointMode(['--run-admitted','one','two']),'EXPLICIT_ADMISSION_REQUIRED');assert.deepEqual(projectDryRun(),{schema:'SQUIRE2_PROJECT_DRY_RUN_V1',status:'DRY_RUN_NATIVE_DISABLED',direct_child_invocations:0,task_correctness:'NOT_EVALUATED',runtime_admitted:false});await assert.rejects(()=>runProjectOneCaseNative(enc('{}'),null),/UNADMITTED_NATIVE_OPERATION/);await assert.rejects(()=>runProjectPreparationCli([]),/EXACT_PREPARATION_ARGS_REQUIRED/);
});
test('project preparation binds request/prompt/source/config with inert flags and single-use admission',async()=>owned(async runtimeRoot=>{
 const files=new Map(),writes=[],identities=[],job=id(),scope='/synthetic/project-'+job,root='/synthetic/prepared-'+job;
 for(const n of PROJECT_SOURCE_FILES)files.set(join(PROJECT_SOURCE_ROOT,n),enc('PUBLIC SYNTHETIC PIN '+n));const io={readFile:async p=>{if(!files.has(p))throw Error('missing synthetic');return files.get(p);},mkdir:async p=>{writes.push(p);},writeFile:async(p,b,opts)=>{assert.equal(opts.flag,'wx');assert.equal(opts.mode,0o600);if(files.has(p))throw Error('exists');files.set(p,new Uint8Array(b));}};
 const privateInputs={job_id:job,scope,codex:{path:'/synthetic/codex',version:'0.160.0',bytes:1,sha256:'a'.repeat(64)},requested_model:MODEL,effort:EFFORT,authorization,permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}};
 const p=await prepareProjectCodexTask(root,'b'.repeat(40),request,privateInputs,{fs:io,verifyFile:async pin=>{identities.push(pin);},retention:()=>({prepare:async()=>({capability_status:'READY'})})});assert.equal(p.status,'PREPARED_NOT_EXECUTABLE');assert.equal(p.runtime_admitted,false);assert.deepEqual(writes,[root]);assert.equal(PROJECT_SOURCE_FILES.includes('src/project-stream-collector.mjs'),true);assert.equal(PROJECT_SOURCE_FILES.includes('acceptance/prepare-project-task.mjs'),true);
 const raw=files.get(join(root,'config.json')),c=validateProjectCodexConfig(JSON.parse(decode(raw))),manifest=JSON.parse(decode(files.get(join(root,'operation-manifest.json'))));assert.equal(c.max_direct_child_spawns,1);assert.equal('syntax_check_wall_ms'in c,false);assert.equal(c.target_mode.stage_subpath,'stage');assert.equal(c.prompt.bytes,buildProjectCodegenPrompt(request).length);assert.equal(p.config_sha256,hash(raw));assert.equal(identities.length,PROJECT_SOURCE_FILES.length+2);
 const rt=fakeRuntime(),launch=inputs(runtimeRoot,rt);assert.deepEqual(canonicalBytes(c.permissions),canonicalBytes(launch.ports.codex.permissions));
 const staged=await runProjectCodexTask(launch.spec,launch.options,launch.ports);assert.equal(staged.status,'CANDIDATE_STAGED');assert.deepEqual(rt.calls[0][1],manifest.generation.argv);
 const bundle={provider_id:'native_codex',operator_receipt:authorization.operator_receipt,config_sha256:hash(raw),job_id:job,scope,project_admitted:true,preflight:{evidence_receipt:'/synthetic/preflight'}};
 assert.throws(()=>requireProjectCodexAdmission({...bundle,config_sha256:'0'.repeat(64)},c,raw));assert.equal(requireProjectCodexAdmission(bundle,c,raw).project_admitted,true);assert.throws(()=>requireProjectCodexAdmission(bundle,c,raw),/NATIVE_OPERATION_ALREADY_CONSUMED/);
 for(const change of [{max_direct_child_spawns:2},{target_mode:{mode:'repo',stage_subpath:'stage'}},{requested_model:'gemini-3.8-flash-high'},{permissions:{...c.permissions,sandbox:'danger-full-access'}},{source_pins:{}}])assert.throws(()=>validateProjectCodexConfig({...c,...change}));
}));
test('project runner rejects missing permissions before fake dispatch or runtime filesystem effects',async()=>owned(async root=>{
 const rt=fakeRuntime(),a=inputs(root,rt);delete a.ports.codex.permissions;
 await assert.rejects(runProjectCodexTask(a.spec,a.options,a.ports));assert.equal(rt.calls.length,0);assert.deepEqual(await fs.readdir(root),[]);
}));
test('envelope close/readback failures suppress foreground persistence and stage ACK with fixed diagnostics',async()=>{
 for(const kind of ['close','readback'])await owned(async root=>{
  const rt=fakeRuntime(),a=inputs(root,rt);let fired=false;
  const io={...fs,async open(path,...args){const h=await fs.open(path,...args);if(!path.endsWith('candidate-envelope.json'))return h;return new Proxy(h,{get(t,k){if(k==='close')return async()=>{await t.close();if(kind==='close'&&!fired){fired=true;throw Error('PRIVATE_CLOSE_BODY');}};if(k==='read')return async(...p)=>{const r=await t.read(...p);if(kind==='readback'&&!fired&&r.bytesRead){fired=true;p[0][0]^=1;}return r;};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}};
  const r=await runProjectCodexTask(a.spec,a.options,{...a.ports,fs:io});assert.equal(r.status,'GENERATION_REJECTED');assert.equal(r.generation.record.output_custody.persisted,false);assert.equal(r.staging,null);assert.equal(JSON.stringify(r).includes('PRIVATE_CLOSE_BODY'),false);assert.ok(fired);
 });
});
test('project payload enforces independent aggregate caps and canonical base64 byte lengths',()=>{
 const tooManyBytes=envelope(Array.from({length:9},(_,i)=>file('f'+i,'SOURCE','utf-8','x'.repeat(65536))));assert.throws(()=>validateProjectPayloadJson(enc(tooManyBytes)),e=>e.field==='PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
 assert.throws(()=>validateProjectPayloadJson(enc(envelope([file('a','SOURCE','utf-8','é'.repeat(65536))]))),e=>e.field==='PROJECT_FILE_SIZE_EXCEEDED');
 assert.throws(()=>validateProjectPayloadJson(new Uint8Array(1048577)),e=>e.field==='PROJECT_PAYLOAD_TOO_LARGE');
});
