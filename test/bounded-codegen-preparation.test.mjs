import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {generationEnvironment,NODE_RUNTIME,buildCodegenPrompt,TASK_KEYS,verifyExactFile,hash,canonicalBytes,programEnvironment,requireAdmission} from '../src/bounded-codegen-plan.mjs';
import {runCodegenCampaign} from '../src/bounded-codegen-campaign.mjs';
import {observeGeneratedSyntax} from '../src/limited-stream-collector.mjs';
import {executeGeneratedSummarizer,executeGeneratedSyntax} from '../src/limited-generated-executor.mjs';
import {entrypointMode,runBoundedCodegenOneCaseNative} from '../acceptance/bounded-codegen-entrypoint.mjs';
import {buildFreeze} from '../fixtures/q218/freeze.mjs';
import {canonicalBytes as oracleBytes,expectedManifest} from '../fixtures/q218/reference-summarizer.mjs';
import {fixtureArgv} from '../fixtures/q218/public-fixtures.mjs';
const enc=s=>new TextEncoder().encode(s),flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const raw=Object.freeze({status:'OBSERVED_EXIT',observed_termination:true,observed_exit_code:0,observed_exit_signal:null,observed_wall_ms:0,settlement_status:'SETTLED_DIRECT_CHILD_EXIT',io_state:{io_drained:true,stdout_bytes_observed:0,stderr_bytes_observed:0}});
function campaign({bad=0,uncertain=false,late=false,syntax=raw}={}){
 let time=0;const order=[],budgets=[];const fixtures=buildFreeze().fixtures;
 const ports={clock:{now:()=>time},generate:async()=>({record:{lifecycle_status:'LIMITED_SUCCESS'},physical_source_witness:{}}),inspectSource:async()=>({source_sha256:'a'.repeat(64)}),syntax:async()=>syntax,
 prepareFixture:async(f,i)=>{order.push(i);if(late&&i===1)time=84000;},execute:async(f,i,b,d)=>{budgets.push({b,d});return {...raw,observed_exit_code:bad===i?99:f.expected_exit_code,settlement_status:uncertain&&i===1?'UNKNOWN':raw.settlement_status};},
 observeFixture:async(f,i,execution)=>{const bytes=f.expected_summary_json?oracleBytes(f.expected_summary_json):null;return {execution,summary_bytes:bytes,manifest_bytes:bytes?expectedManifest('a'.repeat(64),bytes):null,summary_absent:true,manifest_absent:true};}};
 return {order,budgets,ports,fixtures,setTime:n=>{time=n;}};
}
test('TC09 static identity rejects symlink, size, missing and digest mismatch without executing binary',async()=>{
 const bytes=enc('owned bytes'),id={path:'/fixed/binary',bytes:bytes.length,sha256:hash(bytes)};
 const ports={lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length}),readChunks:async function*(){yield bytes;}};
 assert.equal((await verifyExactFile(id,ports)).sha256,id.sha256);
 for(const bad of [{...id,sha256:'0'.repeat(64)},{...id,bytes:1}])await assert.rejects(verifyExactFile(bad,ports));
 await assert.rejects(verifyExactFile(id,{...ports,lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>true,size:bytes.length})}));
 await assert.rejects(verifyExactFile(id,{...ports,lstat:async()=>{throw Error('ENOENT');}}));
});
test('TC11 minimal environment excludes all ambient settings and binds scoped tmp',()=>{
 assert.deepEqual(programEnvironment('/scope/output/run-x/workspace/src/summarizer.mjs'),{PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:'/scope/output/run-x/.tmp'});
});
test('TC12 canonical syntax observation vocabulary remains exact',()=>{
 assert.deepEqual(observeGeneratedSyntax(''),{syntax_status:'UNESTABLISHED_NO_NATIVE_PARSER',syntax_valid:null});
 for(const [status,valid]of [['SYNTAX_VALID',true],['SYNTAX_ERROR',false]])assert.deepEqual(observeGeneratedSyntax('',{validateSyntax:()=>({syntax_status:status,syntax_valid:valid})}),{syntax_status:status,syntax_valid:valid});
 assert.throws(()=>observeGeneratedSyntax('',{validateSyntax:()=>({syntax_status:'UNKNOWN',syntax_valid:null})}));
});
test('TC13 sequential expected negative exits pass; first mismatch and uncertainty preserve NOT_RUN denominator',async()=>{
 const good=campaign();assert.equal((await runCodegenCampaign({fixtures:good.fixtures},good.ports)).status,'PASS');assert.deepEqual(good.order,Array.from({length:17},(_,i)=>i+1));
 const bad=campaign({bad:3}),r=await runCodegenCampaign({fixtures:bad.fixtures},bad.ports);assert.equal(r.status,'FAIL');assert.deepEqual(bad.order,[1,2,3]);assert.equal(r.fixtures.filter(x=>x.status==='NOT_RUN').length,14);
 const unknown=campaign({uncertain:true});assert.equal((await runCodegenCampaign({fixtures:unknown.fixtures},unknown.ports)).status,'FAIL');assert.deepEqual(unknown.order,[1]);
});
test('aggregate deadline never resets; remaining budget caps fixture and expiration prevents passing',async()=>{
 const f=campaign({late:true});f.ports.observeFixture=async(fixture,index,execution)=>{f.setTime(85000);return {execution};};
 const r=await runCodegenCampaign({fixtures:f.fixtures},f.ports);assert.equal(r.reason,'AGGREGATE_EXPIRED');assert.deepEqual(f.budgets,[{b:1000,d:85000}]);assert.deepEqual(f.order,[1]);
});
test('syntax wrapper uncertainty stays separate and blocks all fixtures',async()=>{
 for(const syntax of [{...raw,observed_exit_code:1},{...raw,status:'TIMEOUT'}, {...raw,io_state:{...raw.io_state,stderr_bytes_observed:3}}]){
 const f=campaign({syntax}),r=await runCodegenCampaign({fixtures:f.fixtures},f.ports);assert.equal(r.syntax.wrapper_status,'UNKNOWN');assert.equal(r.syntax.observation.syntax_status,'UNESTABLISHED_NO_NATIVE_PARSER');assert.deepEqual(f.order,[]);}
});
test('TC14/15 preserve FIX08 exact frozen oracle and FIX17 literal paths without touching /proc',()=>{
 const f=buildFreeze().fixtures;assert.equal(f[7].expected_summary_bytes,757);assert.equal(f[7].expected_summary_sha256,'32aabc3ed8d7b0e31f0bcfe78b57a0e4d8907d922cfd268f740349ec67323add');assert.equal(f[7].expected_summary_json.by_severity.INFO.count,1);
 const args=fixtureArgv(17,{input_path:'/input',output_path:'/output',manifest_path:'/manifest'},'0','1000');assert.equal(args[3],'/proc/nonexistent-dir/summary.json');assert.equal(args[5],'/proc/nonexistent-dir/manifest.json');assert.equal(f[16].expected_exit_code,4);
});
test('entrypoint defaults deny, absent admission never touches native ports, prompt recipe exact five keys',async()=>{
 assert.equal(entrypointMode([]),'DRY_RUN_NATIVE_DISABLED');assert.equal(entrypointMode(['--dry-run']),'DRY_RUN_NATIVE_DISABLED');
 await assert.rejects(runBoundedCodegenOneCaseNative(null,null,null),/UNADMITTED_NATIVE_OPERATION/);
 const task=Object.fromEntries(TASK_KEYS.map(k=>[k,{b:2,a:1}]));task.execution_framework_and_arm_equivalence={excluded:true};
 const bytes=buildCodegenPrompt(task);assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(bytes))).sort(),[...TASK_KEYS].sort());assert.equal(bytes.at(-1),10);assert.deepEqual(bytes,canonicalBytes(Object.fromEntries(TASK_KEYS.map(k=>[k,task[k]]))));
 assert.throws(()=>requireAdmission(null,{},enc('{}')));
});
test('executor and syntax use exactly one pinned executable, closed argv and minimal env via fake child',async()=>{
 for(const syntax of [false,true]){
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();for(const s of [child.stdout,child.stderr])s.destroy=()=>{};child.unref=()=>{};
 let captured;const ports={clock:{now:()=>0,schedule:()=>()=>{}},spawn(exe,argv,opts){captured={exe,argv,opts};queueMicrotask(()=>{child.emit('spawn');child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',0,null);});return child;}};
 const cfg={summarizer_path:'/scope/output/run-x/workspace/src/summarizer.mjs',input_path:'/in',output_path:'/out',manifest_path:'/manifest',window_start:'0',window_end:'1',timeout_ms:1000,deadline_ms:1000};
 const result=await(syntax?executeGeneratedSyntax:executeGeneratedSummarizer)(cfg,ports);assert.equal(result.observed_exit_code,0);assert.equal(captured.exe,NODE_RUNTIME.path);assert.equal(captured.argv[0],syntax?'--check':cfg.summarizer_path);assert.deepEqual(captured.opts.env,programEnvironment(cfg.summarizer_path));assert.equal(captured.opts.shell,false);
 }
});


test('TC10 generation environment preserves accepted ambient route minus three API keys',()=>{
 const ambient={HOME:'/synthetic/home',EXAMPLE:'retained',NODE_OPTIONS:'synthetic-only',GEMINI_API_KEY:'fake',GOOGLE_API_KEY:'fake',GOOGLE_GEMINI_BASE_URL:'fake'};
 const env=generationEnvironment('/scope',ambient);assert.deepEqual(env,{HOME:'/synthetic/home',EXAMPLE:'retained',NODE_OPTIONS:'synthetic-only',TMPDIR:'/scope/.tmp'});assert.equal(ambient.GEMINI_API_KEY,'fake');
});


test('reentrant abort in scheduler or clock cannot dispatch syntax or fixture child',async()=>{
 for(const execute of [executeGeneratedSummarizer,executeGeneratedSyntax])for(const where of ['schedule','clock','clockdeadline']){
  const controller=new AbortController();let spawned=0,reads=0,active=0,triggered=false;
  const clock={now(){reads++;if(where.startsWith('clock')&&reads===2)controller.abort();return where==='clockdeadline'&&reads===2?5000:0;},schedule(_,callback){active++;if(where==='schedule'&&!triggered){triggered=true;controller.abort();}let used=false;return()=>{if(!used){used=true;active--;}};}};
  const cfg={summarizer_path:'/scope/output/run-x/workspace/src/summarizer.mjs',input_path:'/in',output_path:'/out',manifest_path:'/manifest',window_start:'0',window_end:'1',timeout_ms:5000};
  const r=await execute(cfg,{clock,abortSignal:controller.signal,spawn(){spawned++;throw Error('not allowed');}});
  assert.equal(spawned,0);assert.equal(r.status,'CANCELED');assert.equal(active,0);
 }
});


test('syntax success remains UNKNOWN until post-check source identity is verified',async()=>{
 for(const mode of ['throw','different']){
  const f=campaign();let calls=0;f.ports.inspectSource=async()=>{calls++;if(calls===2){if(mode==='throw')throw Error('changed');return {source_sha256:'b'.repeat(64)};}return {source_sha256:'a'.repeat(64)};};
  const r=await runCodegenCampaign({fixtures:f.fixtures},f.ports);assert.equal(r.status,'FAIL');assert.equal(r.syntax.execution.observed_exit_code,0);assert.equal(r.syntax.wrapper_status,'UNKNOWN');assert.equal(r.syntax.observation.syntax_status,'UNESTABLISHED_NO_NATIVE_PARSER');assert.deepEqual(f.order,[]);
 }
});


test('last post-verification clock abort cannot grant campaign PASS',async()=>{
 const f=campaign(),controller=new AbortController();let reads=0;f.ports.abortSignal=controller.signal;f.ports.clock.now=()=>{if(++reads===52)controller.abort();return 0;};
 const r=await runCodegenCampaign({fixtures:f.fixtures},f.ports);assert.equal(f.order.length,17);assert.equal(r.status,'FAIL');assert.equal(r.reason,'CANCELED');
});
