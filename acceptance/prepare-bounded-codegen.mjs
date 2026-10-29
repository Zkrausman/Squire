import {RETENTION_POLICY,createNativeRejectedRetention} from '../src/local-rejected-retention.mjs';
// Source/config preparation only. No subprocess/provider/syntax/program invocation.
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {NODE_RUNTIME,GENERATION_SHUTDOWN,buildClarifiedCodegenPrompt,hash,canonicalBytes,verifyExactFile} from '../src/bounded-codegen-plan.mjs';
import {SOURCE_FILES,CODEX_ENVIRONMENT_POLICY,PUBLIC_FREEZE_ROOT,codexFixtureConfigurations,validateCodexOperationConfig} from '../src/bounded-codegen-configuration.mjs';
import {closed} from '../src/job-spec.mjs';
import {prepareCodexArgv,validateCodexPermissions,validateCodexPrompt} from '../src/codex-profile.mjs';
import {fixtureArgv} from '../fixtures/q218/public-fixtures.mjs';
const sourceRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const taskPath='/home/zack/Documents/Codex/2026-10-07/task-14/lore-agy-public/SQUIRE-MVP-BENCHMARK-candidate-v5.json';
const taskSHA='b53d0974459ded8dfc6fd5690a2e24db4a4bab5de27fbd0b1b5b336c73e72cd1';
export async function prepareBoundedCodegen(){throw Error('AGY_SQUIRE_RUNTIME_DISABLED');}
export function buildBoundedCodegenManifest(config,promptBytes){
 validateCodexOperationConfig(config);
 const permissions=validateCodexPermissions(config.permissions),promptCheck=validateCodexPrompt(promptBytes);
 if(!promptCheck.valid||promptCheck.byte_length!==config.prompt.bytes)throw Error('PREPARED_MANIFEST_PROMPT_MISMATCH');
 const exactPrompt=new Uint8Array(promptCheck.byte_length);
 for(let i=0;i<promptCheck.byte_length;i++)exactPrompt[i]=promptBytes[i];
 if(hash(exactPrompt)!==config.prompt.sha256)throw Error('PREPARED_MANIFEST_PROMPT_MISMATCH');
 const profile=prepareCodexArgv({requested_model:config.requested_model,effort:config.effort,authorization:config.authorization,
  observed_cli_version:config.codex.version,permissions,prompt_bytes:exactPrompt});
 const run=join(config.scope,'output','run-'+config.job_id);
 const perFixtureMax=Math.max(...config.fixture_configs.map(f=>f.timeout_ms));
 return {schema:'Q218C_PREPARED_OPERATION_MANIFEST_V1',runtime_admitted:false,source_commit:config.source_commit,
  config_sha256:hash(canonicalBytes(config)),prompt:config.prompt,node:config.node,codex:config.codex,provider_id:config.provider_id,
  job_id:config.job_id,scope:config.scope,source_pins:config.source_pins,
  generation:{executable:config.codex.path,args:profile.argv,stdin:config.prompt,wall_ms:120000,shutdown:config.generation_shutdown},
  syntax:{executable:config.node.path,args:['--check',join(run,'workspace','src','summarizer.mjs')],
   syntax_support:'UNESTABLISHED_NO_NATIVE_PARSER',max_wall_ms:5000},
  fixtures:config.fixture_configs.map(c=>({fixture_id:c.fixture_id,executable:config.node.path,
   args:[c.summarizer_path,...fixtureArgv(c.fixture_id,c,c.window_start,c.window_end)]})),
  limits:{max_direct_child_invocations:config.max_direct_child_spawns,generation:1,syntax:1,fixtures:config.fixture_configs.length,
   fixture_deadline_ms:config.fixture_aggregate_ms,per_fixture_max_ms:perFixtureMax,term_ms:1000,kill_ms:1000,drain_ms:500,
   stdout_bytes:65536,stderr_bytes:65536,outer_observation_target_ms:config.outer_observation_ms},
  fix17_disclosure:['/proc/nonexistent-dir/summary.json','/proc/nonexistent-dir/manifest.json'],
  admission_required:'Exact scoped operator runtime decision including FIX17; fresh effective provider preflight receipt bound to config hash; no retries.',
  residual_risks:['Ambient same-user filesystem access; no hostile containment','Direct child only; descendants untracked','Responsive parent event loop required',
   'Signal attempt not termination proof','No crash recovery, durability or workspace reuse','Outer250s target not hard terminality/cleanup/inference guarantee']};
}
export async function prepareBoundedCodegenCodex(root,source_commit,inputs){
 closed(inputs,['job_id','scope','codex','requested_model','effort','authorization','permissions'],[],'private_codex_inputs');
 const permissions=validateCodexPermissions(inputs.permissions);
 const Q218_JOB=inputs.job_id,Q218_SCOPE=inputs.scope;
 if(typeof root!=='string'||resolve(root)!==root||root==='/'||!(/^[a-f0-9]{40}$/.test(source_commit)))throw Error('PREPARATION_BINDING');
 const reads={lstat:fs.lstat,readChunks:path=>createReadStream(path)};
 await verifyExactFile(NODE_RUNTIME,reads);await verifyExactFile(inputs.codex,reads);
 const taskBytes=await fs.readFile(taskPath);if(hash(taskBytes)!==taskSHA)throw Error('TASK_PREIMAGE_CHANGED');
 const prompt=buildClarifiedCodegenPrompt(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(taskBytes)));
 const receipt=JSON.parse(await fs.readFile(join(PUBLIC_FREEZE_ROOT,'physical-freeze-receipt.json'),'utf8'));
 for(const pin of receipt.artifacts)await verifyExactFile({path:join(PUBLIC_FREEZE_ROOT,pin.path),bytes:pin.bytes,sha256:pin.sha256},reads);
 for(const pin of receipt.source_pins)await verifyExactFile({path:join(sourceRoot,pin.path),bytes:pin.bytes,sha256:pin.sha256},reads);
 const source_pins={};for(const name of SOURCE_FILES){const path=join(sourceRoot,name),bytes=await fs.readFile(path);source_pins[path]={bytes:bytes.length,sha256:hash(bytes)};}
 const config={schema:'Q218C_OPERATION_V1',runtime_admitted:false,provider_id:'native_codex',job_id:Q218_JOB,scope:Q218_SCOPE,source_commit,source_pins,node:NODE_RUNTIME,codex:inputs.codex,requested_model:inputs.requested_model,effort:inputs.effort,authorization:inputs.authorization,permissions,
 prompt:{path:join(root,'prompt.utf8'),bytes:prompt.length,sha256:hash(prompt)},
 fixtures:{path:join(PUBLIC_FREEZE_ROOT,'fixtures-freeze-manifest.json'),bytes:20720,sha256:'7c133ceaae9ca7466689f5e612dbd46fd8f0a300bb7fa7807d6c5cbacd4cccc7'},
 fixture_inputs:Array.from({length:17},(_,i)=>join(PUBLIC_FREEZE_ROOT,`fixture-${String(i+1).padStart(2,'0')}`,'input.ndjson')),
 fixture_configs:codexFixtureConfigurations(Q218_JOB,Q218_SCOPE),diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,preflight_freshness_ms:300000,
 outer_observation_ms:250000,fixture_aggregate_ms:85000,max_direct_child_spawns:19,environment_policy:CODEX_ENVIRONMENT_POLICY,
 task_input:{path:taskPath,bytes:taskBytes.length,sha256:taskSHA}};
 validateCodexOperationConfig(config);
 const manifest=buildBoundedCodegenManifest(config,prompt);
 const captureGate=await createNativeRejectedRetention(Q218_JOB).prepare();
 if(captureGate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
 await fs.mkdir(root,{mode:0o700}); // fail closed on any existing directory
 for(const [name,bytes]of [['prompt.utf8',prompt],['config.json',canonicalBytes(config)],['operation-manifest.json',canonicalBytes(manifest)]]){
  await fs.writeFile(join(root,name),bytes,{flag:'wx',mode:0o600});if(hash(await fs.readFile(join(root,name)))!==hash(bytes))throw Error('PREPARATION_READBACK');
 }
 return {root,prompt:{bytes:prompt.length,sha256:hash(prompt)},config_sha256:hash(canonicalBytes(config)),manifest_sha256:hash(canonicalBytes(manifest)),source_pin_count:SOURCE_FILES.length,diagnostic_capture_gate:captureGate,runtime_admitted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--prepare-codex')throw Error('EXACT_SOURCE_PREPARATION_ARGS_REQUIRED');
 console.log(JSON.stringify(await prepareBoundedCodegenCodex(args[1],args[2],JSON.parse(await fs.readFile(args[3],'utf8')))));
}
