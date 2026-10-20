import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCodegenStreamCollector,validateGeneratedSourcePayload,observeGeneratedSyntax,validateTaskPayloadJson} from '../src/limited-stream-collector.mjs';
import {stageGeneratedSource} from '../src/limited-source-staging.mjs';
import {runForeground} from '../src/internal/limited-core.mjs';
import {runBoundedCodegenTask} from '../src/limited-runner.mjs';
import {executeGeneratedSummarizer} from '../src/limited-generated-executor.mjs';
import {record,mean,oracle,expectedManifest,sha256} from '../fixtures/q218/reference-summarizer.mjs';
import {publicFixtures,fixtureArgv} from '../fixtures/q218/public-fixtures.mjs';
import {freezeBytes,buildFreeze} from '../fixtures/q218/freeze.mjs';
const enc=s=>new TextEncoder().encode(typeof s==='string'?s:JSON.stringify(s));
const source='// Owned synthetic source text for FORMAT tests only. No evaluation.\n'+'export const publicValue = 1;\n'.repeat(3);
const envelope=enc({status:'SUCCESS',response:source,usage:{input_tokens:0,thinking_tokens:2}});
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function collector(bytes=envelope){const c=createCodegenStreamCollector();c.chunk('stdout',bytes);c.eof('stdout');c.eof('stderr');return c;}
function fakeFS({collision=false,mismatch=false,afterWrite}={}){
 const files=new Map(),dirs=new Set(['/scope']),calls=[];let stage=null;
 const stat=(file=false)=>({isDirectory:()=>!file,isFile:()=>file,isSymbolicLink:()=>false,mode:0o400});
 const fs={async mkdir(p){calls.push(['mkdir',p]);if(dirs.has(p))throw Object.assign(Error('exists'),{code:'EEXIST'});dirs.add(p);},
 async lstat(p){if(files.has(p))return stat(true);if(dirs.has(p))return stat();throw Error('missing');},
 async open(p,flags){assert.equal(flags,'wx');if(files.has(p))throw Object.assign(Error(),{code:'EEXIST'});stage=p;files.set(p,new Uint8Array());return {async writeFile(b){files.set(p,new Uint8Array(b));afterWrite?.();},async close(){}};},
 async readFile(p){return mismatch&&p===stage?enc('mismatch'):new Uint8Array(files.get(p));},
 async link(a,b){calls.push(['link',a,b]);if(collision||files.has(b))throw Object.assign(Error(),{code:'EEXIST'});files.set(b,files.get(a));},
 async unlink(p){calls.push(['unlink',p]);files.delete(p);},async chmod(p,m){calls.push(['chmod',p,m]);}};
 return {fs,files,calls};
}
function runtime(){let t=0;const timers=[],kills=[],child=new EventEmitter();child.pid=42;child.unref=()=>{};child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 for(const s of [child.stdout,child.stderr])s.destroy=()=>{};
 child.kill=s=>{kills.push(s);return true;};
 const clock={now:()=>t,schedule(delay,cb){const item={at:t+delay,cb,active:true};timers.push(item);return()=>{item.active=false;};}};
 return {child,kills,clock,ports:{clock,spawn(){queueMicrotask(()=>child.emit('spawn'));return child;}},
 async advance(n){t=n;for(const a of [...timers].sort((a,b)=>a.at-b.at))if(a.active&&a.at<=n){a.active=false;a.cb();}await flush();},
 end(code=0,signal=null){child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',code,signal);}};
}
const config={summarizer_path:'/scope/output/run-x/workspace/src/summarizer.mjs',input_path:'/scope/input.ndjson',output_path:'/scope/summary.json',manifest_path:'/scope/manifest.json',window_start:'0',window_end:'2000000000000',timeout_ms:5000};
test('TC01 source collector preserves exact bytes and reported metadata; syntax defaults unknown',()=>{
 const c=collector(),r=c.decode({exit_code:0,exit_signal:null,process_wall_ms:0});assert.deepEqual(r.bytes,enc(source));assert.equal(r.payload.source_sha256,sha256(enc(source)));assert.equal(r.metadata.usage.input,0);assert.equal(r.metadata.usage.thinking,2);
 assert.equal(observeGeneratedSyntax(source).syntax_status,'UNESTABLISHED_NO_NATIVE_PARSER');assert.equal(observeGeneratedSyntax(source,{validateSyntax:()=>({syntax_status:'SYNTAX_VALID',syntax_valid:true})}).syntax_valid,true);
 c.close();assert.throws(()=>c.decode({}));
});
test('TC02/03 reject markdown, encoding, bounds and malformed envelope without loosening summary payload',()=>{
 for(const s of ['```'+source,source+'\u0000',source+'\uFEFF',source+'\uD800','x'.repeat(99),'x'.repeat(65537)])assert.throws(()=>validateGeneratedSourcePayload(s));
 assert.equal(validateGeneratedSourcePayload('x'.repeat(65536)).source_byte_count,65536);
 assert.throws(()=>collector(enc({status:'ERROR',response:source})).decode({}));
 assert.throws(()=>collector(enc({status:'SUCCESS',response:source+'\uD800'})).decode({}));
 assert.throws(()=>collector(enc('{"status":"SUCCESS","response":"x","response":"y"}')).decode({}));
 assert.throws(()=>validateTaskPayloadJson(enc(source)));assert.throws(()=>collector(new Uint8Array([255])).decode({}));
});
test('TC04 verified stage publishes source only; collision/mismatch/abort never delete final',async()=>{
 const root='/scope/run',controller=new AbortController(),normal=fakeFS();
 const w=await stageGeneratedSource({run_root:root,source_bytes:enc(source),signal:controller.signal},{fs:normal.fs,clock:{now:()=>7}});
 assert.equal(w.source_sha256,sha256(enc(source)));assert.equal(w.syntax_observation,'UNESTABLISHED_NO_NATIVE_PARSER');assert.equal(w.destination_mode,'0o400');
 assert.deepEqual(normal.files.get(root+'/workspace/src/summarizer.mjs'),enc(source));
 for(const bad of [{collision:true},{mismatch:true}]){const f=fakeFS(bad);await assert.rejects(stageGeneratedSource({run_root:root,source_bytes:enc(source),signal:controller.signal},{fs:f.fs,clock:{now:()=>7}}));assert.equal([...f.files.keys()].length,0);assert.ok(!f.calls.some(c=>c[0]==='unlink'&&c[1].endsWith('/src/summarizer.mjs')));}
 const abort=new AbortController(),f=fakeFS({afterWrite:()=>abort.abort()});await assert.rejects(stageGeneratedSource({run_root:root,source_bytes:enc(source),signal:abort.signal},{fs:f.fs,clock:{now:()=>7}}));assert.ok(!f.calls.some(c=>c[0]==='link'));
});
test('TC05 exact rational rounding',()=>{for(const [t,c,s]of [[10,3,'3.33'],[5,2,'2.50'],[1,8,'0.13'],[3,8,'0.38'],[0,0,'0.00']])assert.equal(mean(t,c),s);});
test('TC06 tokenized decoded duplicate detection and exact numeric/calendar grammar',()=>{
 const valid='{"timestamp":"2024-02-29T12:00:00Z","severity":"INFO","duration_ms":10,"message":"ok"}';assert.ok(record(valid));
 for(const s of [valid.replace('"INFO"','"INFO","\\u0073everity":"WARN"'),valid.replace(':10',':1e1'),valid.replace(':10',':-0'),valid.replace('2024-02-29','2023-02-29'),valid.replace('"ok"','"\\uD800"'),valid+'\r'])assert.equal(record(s),null);
 assert.ok(record(valid.replace('"ok"','"\\uD83D\\uDE00"')));
});
test('TC07 injected executor TERM then KILL; passive late exit cannot rewrite result',async()=>{
 const f=runtime(),p=executeGeneratedSummarizer(config,f.ports);await flush();await f.advance(5000);assert.deepEqual(f.kills,['SIGTERM']);await f.advance(6000);assert.deepEqual(f.kills,['SIGTERM','SIGKILL']);await f.advance(7000);const r=await p;
 assert.equal(r.status,'TIMEOUT');assert.equal(r.settlement_status,'ABANDONED_UNSETTLED');assert.equal(r.observed_exit_code,null);f.child.emit('exit',null,'SIGKILL');assert.equal(r.late_observations().length,1);assert.equal(r.observed_termination,false);
});
test('executor observed exit/drain separate, errors and exact caps never prove cleanup',async()=>{
 const f=runtime(),p=executeGeneratedSummarizer(config,f.ports);await flush();f.end(3);const r=await p;assert.equal(r.observed_exit_code,3);assert.equal(r.status,'OBSERVED_EXIT');assert.equal(r.io_state.io_drained,true);
 const g=runtime(),q=executeGeneratedSummarizer(config,g.ports);await flush();g.child.stdout.emit('data',new Uint8Array(65537));g.end();assert.equal((await q).status,'CAPACITY_EXCEEDED');
 const h=runtime(),z=executeGeneratedSummarizer(config,h.ports);await flush();h.child.emit('exit',0,null);await h.advance(500);assert.equal((await z).status,'IO_INCOMPLETE');
 assert.throws(()=>executeGeneratedSummarizer(config));
});
test('TC08 oracle CLI precedence and complete finite freeze matches committed bytes',async()=>{
 const freeze=buildFreeze();assert.equal(freeze.fixtures.length,17);assert.deepEqual(freeze.fixtures.map(f=>f.expected_exit_code),[0,0,0,0,0,0,0,0,0,0,2,2,2,3,3,3,4]);
 assert.deepEqual(freezeBytes(),new Uint8Array(await readFile(new URL('../fixtures/q218/fixtures-freeze-manifest.json',import.meta.url))));
 const f=freeze.fixtures[9].expected_summary_json;assert.equal(f.by_severity.WARN.mean_duration_ms,'0.13');assert.equal(f.by_severity.ERROR.mean_duration_ms,'0.38');
 assert.equal(freeze.fixtures[7].expected_summary_json.by_severity.INFO.count,1); // exact numeric window, prose discrepancy documented
 assert.equal(oracle({argv:[],input_missing:true}).exit_code,2);
 const expected=expectedManifest('a'.repeat(64),enc('{}\n'));assert.equal(JSON.parse(new TextDecoder().decode(expected)).source_sha256,'a'.repeat(64));
});
test('core additive codegen path persists exact source, leaves final content outcome unevaluated',async()=>{
 const f=runtime();let saved;
 const p=runForeground({job_id:'12345678-1234-4abc-8def-123456789abc',task_class:'BOUNDED_CODEGEN_SUMMARIZER_V5',task_scope:'/scope',requested_model:'gemini-3.8-flash-high',max_wall_clock_sec:120},
 {executable:'/synthetic',args:[]},{shutdown:{term_grace_ms:1000,kill_grace_ms:1000,stream_drain_timeout_ms:500,persistence_timeout_ms:1000},output_path:'/scope/source'},
 {...f.ports,createCollector:createCodegenStreamCollector,persist:async b=>{saved=new Uint8Array(b);}});
 await flush();f.child.stdout.emit('data',envelope);f.end();const r=await p;assert.deepEqual(saved,enc(source));assert.equal(r.record.lifecycle_status,'LIMITED_SUCCESS');assert.equal(r.record.task_outcome_evaluated,false);assert.equal(r.record.output_custody.byte_count,enc(source).length);
});
test('codegen entrypoint has no native defaults and persists through injected filesystem only',async()=>{
 const spec={job_id:'12345678-1234-4abc-8def-123456789abd',task_scope:'/scope',requested_model:'gemini-3.8-flash-high',effort:'high',max_wall_clock_sec:120,prompt_bytes:enc('public task')};
 const output_path='/scope/output/run-'+spec.job_id+'/workspace/src/summarizer.mjs',f=runtime(),fs=fakeFS();
 const opts={clock:f.clock,shutdown:{term_grace_ms:1000,kill_grace_ms:1000,poll_interval_ms:10,stream_drain_timeout_ms:500,persistence_timeout_ms:1000},output_path};
 await assert.rejects(runBoundedCodegenTask(spec,opts));
 const p=runBoundedCodegenTask(spec,opts,{...f.ports,fs:fs.fs});await flush();f.child.stdout.emit('data',envelope);f.end();const r=await p;
 assert.equal(r.record.lifecycle_status,'LIMITED_SUCCESS');assert.equal(r.physical_source_witness.source_path,output_path);assert.equal(r.runtime_admitted,false);
});

test('pure verification binds actual delivered source, raw bytes and settled exit; UNKNOWN cannot pass',async()=>{
 const {verifyGeneratedFixture}=await import('../fixtures/q218/verify-result.mjs');
 const fixture=buildFreeze().fixtures[1],r=oracle({argv:fixture.argv,input_bytes:new Uint8Array()}),hash='b'.repeat(64);
 const observation={execution:{status:'OBSERVED_EXIT',observed_termination:true,observed_exit_code:0,observed_exit_signal:null,observed_wall_ms:0,settlement_status:'SETTLED_DIRECT_CHILD_EXIT',io_state:{io_drained:true}},summary_bytes:r.summary,manifest_bytes:expectedManifest(hash,r.summary)};
 assert.equal(verifyGeneratedFixture(fixture,observation,hash).fixture_verdict,'PASS');
 assert.equal(verifyGeneratedFixture(fixture,observation,'c'.repeat(64)).fixture_verdict,'FAIL');
 assert.equal(verifyGeneratedFixture(fixture,{...observation,execution:{...observation.execution,settlement_status:'UNKNOWN'}},hash).fixture_verdict,'FAIL');
 const bad=buildFreeze().fixtures[12];assert.equal(verifyGeneratedFixture(bad,{execution:{...observation.execution,observed_exit_code:2},summary_absent:true,manifest_absent:false},hash).fixture_verdict,'FAIL');
});


test('executor snapshots validated argv and cwd before injected clock callbacks',async()=>{
 const spec={...config},f=runtime();let call;
 const clock={...f.clock,now(){spec.summarizer_path='/unrelated/changed.mjs';return f.clock.now();}};
 const p=executeGeneratedSummarizer(spec,{clock,spawn(exe,argv,opts){call={exe,argv,opts};return f.ports.spawn();}});
 await flush();f.end();await p;
 assert.equal(call.argv[0],config.summarizer_path);assert.equal(call.opts.cwd,'/scope/output/run-x/workspace');assert.equal(call.opts.shell,false);
});
