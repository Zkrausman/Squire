// Source/config preparation only. No subprocess/provider/syntax/program invocation.
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {NODE_RUNTIME,AGY_RUNTIME,Q218_SCOPE,Q218_JOB,GENERATION_SHUTDOWN,buildCodegenPrompt,hash,canonicalBytes,verifyExactFile} from '../src/bounded-codegen-plan.mjs';
import {SOURCE_FILES,ENVIRONMENT_POLICY,PUBLIC_FREEZE_ROOT,fixtureConfigurations,validateOperationConfig} from '../src/bounded-codegen-configuration.mjs';
import {fixtureArgv} from '../fixtures/q218/public-fixtures.mjs';
const sourceRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const taskPath='/home/zack/Documents/Codex/2026-10-07/task-14/lore-agy-public/SQUIRE-MVP-BENCHMARK-candidate-v5.json';
const taskSHA='b53d0974459ded8dfc6fd5690a2e24db4a4bab5de27fbd0b1b5b336c73e72cd1';
export async function prepareBoundedCodegen(root,source_commit){
 if(typeof root!=='string'||resolve(root)!==root||root==='/'||!(/^[a-f0-9]{40}$/.test(source_commit)||source_commit==='UNPUBLISHED_SOURCE_CANDIDATE'))throw Error('PREPARATION_BINDING');
 const reads={lstat:fs.lstat,readChunks:path=>createReadStream(path)};
 await verifyExactFile(NODE_RUNTIME,reads);await verifyExactFile(AGY_RUNTIME,reads);
 const taskBytes=await fs.readFile(taskPath);if(hash(taskBytes)!==taskSHA)throw Error('TASK_PREIMAGE_CHANGED');
 const prompt=buildCodegenPrompt(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(taskBytes)));
 const receipt=JSON.parse(await fs.readFile(join(PUBLIC_FREEZE_ROOT,'physical-freeze-receipt.json'),'utf8'));
 for(const pin of receipt.artifacts)await verifyExactFile({path:join(PUBLIC_FREEZE_ROOT,pin.path),bytes:pin.bytes,sha256:pin.sha256},reads);
 for(const pin of receipt.source_pins)await verifyExactFile({path:join(sourceRoot,pin.path),bytes:pin.bytes,sha256:pin.sha256},reads);
 const source_pins={};for(const name of SOURCE_FILES){const path=join(sourceRoot,name),bytes=await fs.readFile(path);source_pins[path]={bytes:bytes.length,sha256:hash(bytes)};}
 const config={schema:'Q218A_OPERATION_V1',runtime_admitted:false,job_id:Q218_JOB,scope:Q218_SCOPE,source_commit,source_pins,node:NODE_RUNTIME,agy:AGY_RUNTIME,
 prompt:{path:join(root,'prompt.utf8'),bytes:prompt.length,sha256:hash(prompt)},
 fixtures:{path:join(PUBLIC_FREEZE_ROOT,'fixtures-freeze-manifest.json'),bytes:20720,sha256:'7c133ceaae9ca7466689f5e612dbd46fd8f0a300bb7fa7807d6c5cbacd4cccc7'},
 fixture_inputs:Array.from({length:17},(_,i)=>join(PUBLIC_FREEZE_ROOT,`fixture-${String(i+1).padStart(2,'0')}`,'input.ndjson')),
 fixture_configs:fixtureConfigurations(),generation_shutdown:GENERATION_SHUTDOWN,preflight_freshness_ms:300000,
 outer_observation_ms:250000,fixture_aggregate_ms:85000,max_direct_child_spawns:19,environment_policy:ENVIRONMENT_POLICY,
 task_input:{path:taskPath,bytes:taskBytes.length,sha256:taskSHA}};
 validateOperationConfig(config);
 const run=join(Q218_SCOPE,'output','run-'+Q218_JOB),manifest={schema:'Q218A_PREPARED_OPERATION_MANIFEST_V1',runtime_admitted:false,source_commit,
 config_sha256:hash(canonicalBytes(config)),prompt:config.prompt,node:NODE_RUNTIME,agy:AGY_RUNTIME,job_id:Q218_JOB,scope:Q218_SCOPE,
 source_pins,generation:{executable:AGY_RUNTIME.path,args:['--prompt','<exact prompt.utf8 bytes>','--output-format','json','--model','gemini-3.8-flash-high','--effort','high','--print-timeout','1m','--sandbox','--disable-slash-commands'],wall_ms:120000,shutdown:GENERATION_SHUTDOWN},
 syntax:{executable:NODE_RUNTIME.path,args:['--check',join(run,'workspace','src','summarizer.mjs')],syntax_support:'UNESTABLISHED_NO_NATIVE_PARSER',max_wall_ms:5000},
 fixtures:config.fixture_configs.map(c=>({fixture_id:c.fixture_id,executable:NODE_RUNTIME.path,args:[c.summarizer_path,...fixtureArgv(c.fixture_id,c,c.window_start,c.window_end)]})),
 limits:{max_direct_child_invocations:19,generation:1,syntax:1,fixtures:17,fixture_deadline_ms:85000,per_fixture_max_ms:5000,term_ms:1000,kill_ms:1000,drain_ms:500,stdout_bytes:65536,stderr_bytes:65536,outer_observation_target_ms:250000},
 fix17_disclosure:['/proc/nonexistent-dir/summary.json','/proc/nonexistent-dir/manifest.json'],
 admission_required:'Exact scoped operator runtime decision including FIX17; fresh effective provider preflight receipt bound to config hash; no retries.',
 residual_risks:['Ambient same-user filesystem access; no hostile containment','Direct child only; descendants untracked','Responsive parent event loop required','Signal attempt not termination proof','No crash recovery, durability or workspace reuse','Outer250s target not hard terminality/cleanup/inference guarantee']};
 await fs.mkdir(root,{mode:0o700}); // fail closed on any existing directory
 for(const [name,bytes]of [['prompt.utf8',prompt],['config.json',canonicalBytes(config)],['operation-manifest.json',canonicalBytes(manifest)]]){
  await fs.writeFile(join(root,name),bytes,{flag:'wx',mode:0o600});if(hash(await fs.readFile(join(root,name)))!==hash(bytes))throw Error('PREPARATION_READBACK');
 }
 return {root,prompt:{bytes:prompt.length,sha256:hash(prompt)},config_sha256:hash(canonicalBytes(config)),manifest_sha256:hash(canonicalBytes(manifest)),source_pin_count:SOURCE_FILES.length,runtime_admitted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);if(args.length!==3||args[0]!=='--prepare')throw Error('EXACT_SOURCE_PREPARATION_ARGS_REQUIRED');
 console.log(JSON.stringify(await prepareBoundedCodegen(args[1],args[2])));
}
