// Generic preparation is separate from the historical Q218 task and fixture recipe.
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {closed,object,fail} from './job-spec.mjs';
import {snapshotReceiptData} from './offline-run-summary.mjs';
import {NODE_RUNTIME,GENERATION_SHUTDOWN,hash,canonicalBytes,verifyExactFile} from './bounded-codegen-plan.mjs';
import {prepareCodexArgv,CODEX_REQUIRED_VERSION,validateCodexPermissions} from './codex-profile.mjs';
import {buildSingleJsCodegenPrompt,validateSingleJsRequest} from './single-js-task.mjs';
import {RETENTION_POLICY,createNativeRejectedRetention} from './local-rejected-retention.mjs';

export const SINGLE_JS_SOURCE_ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
export const SINGLE_JS_SOURCE_FILES=Object.freeze(['src/single-js-task.mjs','src/single-js-configuration.mjs','src/single-js-runner.mjs','src/single-js-summary.mjs','src/offline-run-summary.mjs','src/codex-profile.mjs','src/bounded-codegen-plan.mjs','src/local-rejected-retention.mjs','src/internal/local-rejected-retention.mjs','src/internal/rejected-capture.mjs','src/internal/limited-core.mjs','src/internal/limited-diagnostics.mjs','src/limited-generated-executor.mjs','src/limited-source-staging.mjs','src/limited-stream-collector.mjs','src/limited-job-record.mjs','src/job-spec.mjs','src/agy-profile.mjs','src/provider-metadata.mjs','src/node-process-port.mjs','src/owned-group.mjs','fixtures/q218/public-fixtures.mjs','bin/squire-report.mjs','acceptance/prepare-single-js-task.mjs','acceptance/single-js-entrypoint.mjs','src/project-coding-profile.mjs','src/desktop-profile.mjs']);
export const SINGLE_JS_ENVIRONMENT_POLICY=Object.freeze({generation:'INHERIT_PROCESS_ENV_MINUS_CODEX_API_KEYS_SCOPED_TMPDIR',deleted_keys:Object.freeze(['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL']),program:Object.freeze({PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:'<run>/.tmp'}),safety:'KEY_EXCLUSION_IS_NOT_EFFECTIVE_PROVIDER_OR_HOSTILE_ISOLATION_PROOF'});
const same=(a,b)=>hash(canonicalBytes(a))===hash(canonicalBytes(b));
const absolute=v=>typeof v==='string'&&v!=='/'&&resolve(v)===v&&v.startsWith('/')&&!v.includes('\0');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function pin(v,version=false){closed(v,['path','bytes','sha256',...(version?['version']:[])],[],'single_js_pin');if(!absolute(v.path)||!Number.isSafeInteger(v.bytes)||v.bytes<0||!digest(v.sha256)||version&&v.version!==CODEX_REQUIRED_VERSION)fail('single_js_pin');}
export function validateSingleJsCodexConfig(c){
  c=snapshotReceiptData(c);
  closed(c,['schema','runtime_admitted','provider_id','job_id','scope','source_commit','source_pins','node','codex','requested_model','effort','authorization','permissions','prompt','target_file','diagnostic_retention','generation_shutdown','preflight_freshness_ms','outer_observation_ms','generation_wall_ms','syntax_check_wall_ms','max_direct_child_spawns','environment_policy'],[],'single_js_config');
  if(c.schema!=='SQUIRE2_SINGLE_JS_OPERATION_V1'||c.runtime_admitted!==false||c.provider_id!=='native_codex'||typeof c.job_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.job_id)||!absolute(c.scope)||typeof c.source_commit!=='string'||!/^[a-f0-9]{40}$/.test(c.source_commit))fail('single_js_config');
  pin(c.node);pin(c.codex,true);pin(c.prompt);if(!same(c.node,NODE_RUNTIME)||c.prompt.bytes<887||c.prompt.bytes>32768)fail('single_js_pin');
  object(c.source_pins,'single_js_source_pins');
  const expected=SINGLE_JS_SOURCE_FILES.map(n=>join(SINGLE_JS_SOURCE_ROOT,n)).sort();closed(c.source_pins,expected,[],'single_js_source_pins');if(!same(Object.keys(c.source_pins).sort(),expected))fail('single_js_source_pins');
  for(const p of Object.values(c.source_pins)){closed(p,['bytes','sha256'],[],'single_js_source_pin');if(!Number.isSafeInteger(p.bytes)||p.bytes<0||!digest(p.sha256))fail('single_js_source_pin');}
  validateCodexPermissions(c.permissions);
  prepareCodexArgv({requested_model:c.requested_model,effort:c.effort,observed_cli_version:c.codex.version,authorization:c.authorization,permissions:c.permissions,prompt_bytes:new Uint8Array([65])});
  closed(c.target_file,['workspace_relative_path'],[],'single_js_target');
  if(c.target_file.workspace_relative_path!=='src/task.mjs'||!same(c.diagnostic_retention,RETENTION_POLICY)||!same(c.generation_shutdown,GENERATION_SHUTDOWN)||!same(c.environment_policy,SINGLE_JS_ENVIRONMENT_POLICY)||c.preflight_freshness_ms!==300000||c.outer_observation_ms!==140000||c.generation_wall_ms!==120000||c.syntax_check_wall_ms!==5000||c.max_direct_child_spawns!==2)fail('single_js_policy');
  return c;
}
export function requireSingleJsCodexAdmission(bundle,c,bytes){
  c=validateSingleJsCodexConfig(c);bundle=snapshotReceiptData(bundle);
  closed(bundle,['provider_id','operator_receipt','config_sha256','job_id','scope','single_js_admitted','preflight'],[],'single_js_admission');closed(bundle.preflight,['evidence_receipt'],[],'single_js_preflight');
  if(bundle.provider_id!=='native_codex'||bundle.operator_receipt!==c.authorization.operator_receipt||bundle.config_sha256!==hash(bytes)||bundle.job_id!==c.job_id||bundle.scope!==c.scope||bundle.single_js_admitted!==true||!absolute(bundle.preflight.evidence_receipt))fail('single_js_admission');
  return Object.freeze({...bundle,preflight:Object.freeze({...bundle.preflight})});
}
export async function prepareSingleJsCodexTask(root,source_commit,request,inputs,ports={}){
  const req=validateSingleJsRequest(request);inputs=snapshotReceiptData(inputs);closed(inputs,['job_id','scope','codex','requested_model','effort','authorization','permissions'],[],'single_js_private_inputs');
  const permissions=validateCodexPermissions(inputs.permissions);
  if(!absolute(root)||typeof source_commit!=='string'||!/^[a-f0-9]{40}$/.test(source_commit))fail('single_js_preparation');
  const fsPort=ports.fs??fs,verify=ports.verifyFile??verifyExactFile,reads={lstat:fsPort.lstat,readChunks:ports.readChunks??(p=>createReadStream(p))};
  const prompt=buildSingleJsCodegenPrompt(req),source_pins={};pin(inputs.codex,true);
  prepareCodexArgv({requested_model:inputs.requested_model,effort:inputs.effort,observed_cli_version:inputs.codex.version,prompt_bytes:prompt,authorization:inputs.authorization,permissions});
  for(const name of SINGLE_JS_SOURCE_FILES){const p=join(SINGLE_JS_SOURCE_ROOT,name),b=await fsPort.readFile(p);source_pins[p]={bytes:b.length,sha256:hash(b)};}
  const config={schema:'SQUIRE2_SINGLE_JS_OPERATION_V1',runtime_admitted:false,provider_id:'native_codex',job_id:inputs.job_id,scope:inputs.scope,source_commit,source_pins,node:NODE_RUNTIME,codex:inputs.codex,requested_model:inputs.requested_model,effort:inputs.effort,authorization:inputs.authorization,permissions,prompt:{path:join(root,'prompt.utf8'),bytes:prompt.length,sha256:hash(prompt)},target_file:{workspace_relative_path:'src/task.mjs'},diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,preflight_freshness_ms:300000,outer_observation_ms:140000,generation_wall_ms:120000,syntax_check_wall_ms:5000,max_direct_child_spawns:2,environment_policy:SINGLE_JS_ENVIRONMENT_POLICY};
  validateSingleJsCodexConfig(config);
  for(const identity of [NODE_RUNTIME,config.codex,...Object.entries(source_pins).map(([path,pin])=>({path,...pin}))])await verify(identity,reads);
  const gate=await (ports.retention??createNativeRejectedRetention)(inputs.job_id).prepare();if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  const target=join(config.scope,'output','run-'+config.job_id,'workspace','src','task.mjs');
  const manifest={schema:'SQUIRE2_SINGLE_JS_PREPARED_MANIFEST_V1',runtime_admitted:false,source_commit,source_pins,job_id:config.job_id,scope:config.scope,task_id:req.task_id,request_sha256:hash(canonicalBytes(req)),config_sha256:hash(canonicalBytes(config)),prompt:config.prompt,node:NODE_RUNTIME,codex:config.codex,generation:{argv:prepareCodexArgv({requested_model:config.requested_model,effort:config.effort,observed_cli_version:config.codex.version,prompt_bytes:prompt,authorization:config.authorization,permissions:config.permissions}).argv,stdin:config.prompt,wall_ms:120000},syntax:{argv:['--check',target],wall_ms:5000},task_correctness:'NOT_EVALUATED',limits:{max_direct_child_spawns:2,outer_observation_ms:140000,descendant_guarantee:'NONE',workspace_reuse:'NOT_AUTHORIZED'},admission_required:true};
  await fsPort.mkdir(root,{mode:0o700});
  for(const[name,b]of[['prompt.utf8',prompt],['config.json',canonicalBytes(config)],['operation-manifest.json',canonicalBytes(manifest)]]){await fsPort.writeFile(join(root,name),b,{flag:'wx',mode:0o600});if(hash(await fsPort.readFile(join(root,name)))!==hash(b))throw Error('PREPARATION_READBACK');}
  return Object.freeze({status:'PREPARED_NOT_EXECUTABLE',schema:config.schema,runtime_admitted:false,prompt_bytes:prompt.length,prompt_sha256:hash(prompt),config_sha256:hash(canonicalBytes(config)),manifest_sha256:hash(canonicalBytes(manifest)),task_correctness:'NOT_EVALUATED'});
}
