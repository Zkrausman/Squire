// Generic preparation is separate from the historical Q218 task and fixture recipe.
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {closed,object,fail} from './job-spec.mjs';
import {snapshotReceiptData} from './offline-run-summary.mjs';
import {NODE_RUNTIME,GENERATION_SHUTDOWN,hash,canonicalBytes,verifyExactFile} from './bounded-codegen-plan.mjs';
import {prepareCodexArgv,CODEX_REQUIRED_VERSION,CODEX_OUTPUT_CONTRACT} from './codex-profile.mjs';
import {buildProjectCodegenPrompt,validateProjectRequest,PROJECT_PREFIX_IDENTITY} from './project-task.mjs';
import {DESKTOP_TARGET,DESKTOP_PREFIX_IDENTITY,validateDesktopRuntimeIdentity} from './desktop-profile.mjs';
import {RETENTION_POLICY,createNativeRejectedRetention} from './local-rejected-retention.mjs';

export const PROJECT_SOURCE_ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
export const PROJECT_SOURCE_FILES=Object.freeze(["src/project-task.mjs", "src/project-configuration.mjs", "src/project-runner.mjs", "src/offline-run-summary.mjs", "src/codex-profile.mjs", "src/bounded-codegen-plan.mjs", "src/local-rejected-retention.mjs", "src/internal/local-rejected-retention.mjs", "src/internal/rejected-capture.mjs", "src/internal/limited-core.mjs", "src/internal/limited-diagnostics.mjs", "src/internal/multifile-core.mjs", "src/multifile-staging.mjs", "src/multifile-export.mjs", "src/limited-stream-collector.mjs", "src/limited-job-record.mjs", "src/job-spec.mjs", "src/agy-profile.mjs", "src/provider-metadata.mjs", "src/node-process-port.mjs", "src/owned-group.mjs", "bin/squire-report.mjs", "acceptance/project-entrypoint.mjs", "src/project-stream-collector.mjs", "src/single-js-summary.mjs", "acceptance/prepare-project-task.mjs", "src/desktop-profile.mjs"]);
export const PROJECT_ENVIRONMENT_POLICY=Object.freeze({generation:'INHERIT_PROCESS_ENV_MINUS_CODEX_API_KEYS_SCOPED_TMPDIR',deleted_keys:Object.freeze(['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL']),program:Object.freeze({PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:'<run>/.tmp'}),safety:'KEY_EXCLUSION_IS_NOT_EFFECTIVE_PROVIDER_OR_HOSTILE_ISOLATION_PROOF'});
const admittedJobs=new Set(),admittedScopes=new Set();
const same=(a,b)=>hash(canonicalBytes(a))===hash(canonicalBytes(b));
const absolute=v=>typeof v==='string'&&v!=='/'&&resolve(v)===v&&v.startsWith('/')&&!v.includes('\0');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function pin(v,version=false){closed(v,['path','bytes','sha256',...(version?['version']:[])],[],'project_pin');if(!absolute(v.path)||!Number.isSafeInteger(v.bytes)||v.bytes<0||!digest(v.sha256)||version&&v.version!==CODEX_REQUIRED_VERSION)fail('project_pin');}
export function validateProjectCodexConfig(c){
  c=snapshotReceiptData(c);
  closed(c,['schema','runtime_admitted','provider_id','job_id','scope','source_commit','source_pins','node','codex','requested_model','effort','authorization','permissions','prompt','target_mode','diagnostic_retention','generation_shutdown','preflight_freshness_ms','outer_observation_ms','generation_wall_ms','max_direct_child_spawns','environment_policy'],['runtime_target','prefix_identity','desktop_runtime_identity'],'project_config');
  if(c.schema!=='SQUIRE2_PROJECT_OPERATION_V1'||c.runtime_admitted!==false||c.provider_id!=='native_codex'||typeof c.job_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.job_id)||!absolute(c.scope)||typeof c.source_commit!=='string'||!/^[a-f0-9]{40}$/.test(c.source_commit))fail('project_config');
  const target=Object.hasOwn(c,'runtime_target')?c.runtime_target:'node24-esm';if(!['node24-esm',DESKTOP_TARGET].includes(target))fail('project_target');
  const prefix=target===DESKTOP_TARGET?DESKTOP_PREFIX_IDENTITY:PROJECT_PREFIX_IDENTITY;
  if(target===DESKTOP_TARGET){if(!Object.hasOwn(c,'prefix_identity')||!same(c.prefix_identity,prefix))fail('project_prefix');validateDesktopRuntimeIdentity(c.desktop_runtime_identity);if(c.codex?.path===c.desktop_runtime_identity.executable.path||c.codex?.path===c.node?.path||c.desktop_runtime_identity.executable.path===c.node?.path)fail('project_launcher');}
  else if(Object.hasOwn(c,'desktop_runtime_identity')||Object.hasOwn(c,'prefix_identity')&&!same(c.prefix_identity,prefix))fail('project_target');
  pin(c.node);pin(c.codex,true);pin(c.prompt);if(!same(c.node,NODE_RUNTIME)||c.prompt.bytes<prefix.bytes+1||c.prompt.bytes>32768)fail('project_pin');
  object(c.source_pins,'project_source_pins');
  const expected=PROJECT_SOURCE_FILES.map(n=>join(PROJECT_SOURCE_ROOT,n)).sort();closed(c.source_pins,expected,[],'project_source_pins');if(!same(Object.keys(c.source_pins).sort(),expected))fail('project_source_pins');
  for(const p of Object.values(c.source_pins)){closed(p,['bytes','sha256'],[],'project_source_pin');if(!Number.isSafeInteger(p.bytes)||p.bytes<0||!digest(p.sha256))fail('project_source_pin');}
  closed(c.permissions,['sandbox','approval_mode','output_contract'],[],'project_permissions');if(c.permissions.sandbox!=='read-only'||!['never','on-request'].includes(c.permissions.approval_mode)||c.permissions.output_contract!==CODEX_OUTPUT_CONTRACT)fail('project_permissions');
  prepareCodexArgv({requested_model:c.requested_model,effort:c.effort,observed_cli_version:c.codex.version,authorization:c.authorization,prompt_bytes:new Uint8Array([65])});
  closed(c.target_mode,['mode','stage_subpath'],[],'project_target');
  if((c.target_mode.mode!=='multifile_stage'||c.target_mode.stage_subpath!=='stage')||!same(c.diagnostic_retention,RETENTION_POLICY)||!same(c.generation_shutdown,GENERATION_SHUTDOWN)||!same(c.environment_policy,PROJECT_ENVIRONMENT_POLICY)||c.preflight_freshness_ms!==300000||c.outer_observation_ms!==140000||c.generation_wall_ms!==120000||c.max_direct_child_spawns!==1)fail('project_policy');
  return c;
}
export function requireProjectCodexAdmission(bundle,c,bytes){
  c=validateProjectCodexConfig(c);if(c.runtime_target===DESKTOP_TARGET)fail('desktop_native_disabled');bundle=snapshotReceiptData(bundle);
  closed(bundle,['provider_id','operator_receipt','config_sha256','job_id','scope','project_admitted','preflight'],[],'project_admission');closed(bundle.preflight,['evidence_receipt'],[],'project_preflight');
  if(bundle.provider_id!=='native_codex'||bundle.operator_receipt!==c.authorization.operator_receipt||bundle.config_sha256!==hash(bytes)||bundle.job_id!==c.job_id||bundle.scope!==c.scope||bundle.project_admitted!==true||!absolute(bundle.preflight.evidence_receipt))fail('project_admission');
  if(admittedJobs.has(c.job_id)||admittedScopes.has(c.scope))throw Error('NATIVE_OPERATION_ALREADY_CONSUMED');admittedJobs.add(c.job_id);admittedScopes.add(c.scope);
  return Object.freeze({...bundle,preflight:Object.freeze({...bundle.preflight})});
}
export async function prepareProjectCodexTask(root,source_commit,request,inputs,ports={}){
  const req=validateProjectRequest(request);inputs=snapshotReceiptData(inputs);closed(inputs,['job_id','scope','codex','requested_model','effort','authorization','permissions'],['desktop_runtime_identity'],'project_private_inputs');
  let desktop=null;if(req.runtime_target===DESKTOP_TARGET){if(ports.mode!=='SOURCE_SIMULATION'||!ports.fs||typeof ports.verifyFile!=='function'||typeof ports.retention!=='function'||typeof ports.observeDesktopRuntimeIdentity!=='function')fail('desktop_source_only');desktop=validateDesktopRuntimeIdentity(inputs.desktop_runtime_identity);const observed=validateDesktopRuntimeIdentity(await ports.observeDesktopRuntimeIdentity());if(!same(desktop,observed))fail('desktop_identity');}
  else if(Object.hasOwn(inputs,'desktop_runtime_identity'))fail('project_target');
  if(!absolute(root)||typeof source_commit!=='string'||!/^[a-f0-9]{40}$/.test(source_commit))fail('project_preparation');
  const fsPort=ports.fs??fs,verify=ports.verifyFile??verifyExactFile,reads={lstat:fsPort.lstat,readChunks:ports.readChunks??(p=>createReadStream(p))};
  const prompt=buildProjectCodegenPrompt(req),source_pins={};pin(inputs.codex,true);
  prepareCodexArgv({requested_model:inputs.requested_model,effort:inputs.effort,observed_cli_version:inputs.codex.version,prompt_bytes:prompt,authorization:inputs.authorization});
  for(const name of PROJECT_SOURCE_FILES){const p=join(PROJECT_SOURCE_ROOT,name),b=await fsPort.readFile(p);source_pins[p]={bytes:b.length,sha256:hash(b)};}
  const config={schema:'SQUIRE2_PROJECT_OPERATION_V1',runtime_admitted:false,provider_id:'native_codex',job_id:inputs.job_id,scope:inputs.scope,source_commit,source_pins,node:NODE_RUNTIME,codex:inputs.codex,requested_model:inputs.requested_model,effort:inputs.effort,authorization:inputs.authorization,permissions:inputs.permissions,prompt:{path:join(root,'prompt.utf8'),bytes:prompt.length,sha256:hash(prompt)},target_mode:{mode:'multifile_stage',stage_subpath:'stage'},diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,preflight_freshness_ms:300000,outer_observation_ms:140000,generation_wall_ms:120000,max_direct_child_spawns:1,environment_policy:PROJECT_ENVIRONMENT_POLICY};
  if(desktop)Object.assign(config,{runtime_target:DESKTOP_TARGET,prefix_identity:DESKTOP_PREFIX_IDENTITY,desktop_runtime_identity:desktop});
  validateProjectCodexConfig(config);
  for(const identity of [NODE_RUNTIME,config.codex,...Object.entries(source_pins).map(([path,pin])=>({path,...pin}))])await verify(identity,reads);
  const gate=await (ports.retention??createNativeRejectedRetention)(inputs.job_id).prepare();if(gate.capability_status!=='READY')throw Error('RETENTION_PRIVATE_CAPTURE_UNAVAILABLE');
  const target=join(config.scope,'output','run-'+config.job_id,'candidate-envelope.json');
  const manifest={schema:'SQUIRE2_PROJECT_PREPARED_MANIFEST_V1',runtime_admitted:false,source_commit,source_pins,job_id:config.job_id,scope:config.scope,task_id:req.task_id,request_sha256:hash(canonicalBytes(req)),config_sha256:hash(canonicalBytes(config)),prompt:config.prompt,node:NODE_RUNTIME,codex:config.codex,generation:{argv:prepareCodexArgv({requested_model:config.requested_model,effort:config.effort,observed_cli_version:config.codex.version,prompt_bytes:prompt,authorization:config.authorization}).argv,stdin:config.prompt,wall_ms:120000},candidate_envelope:{path:target,source:'EXACT_FINAL_MESSAGE_UTF8'},staging:{stage_subpath:'stage',runtime_admitted:false},task_correctness:'NOT_EVALUATED',limits:{max_direct_child_spawns:1,outer_observation_ms:140000,descendant_guarantee:'NONE',workspace_reuse:'NOT_AUTHORIZED'},admission_required:true};
  if(desktop)Object.assign(manifest,{runtime_target:DESKTOP_TARGET,prefix_identity:DESKTOP_PREFIX_IDENTITY,desktop_runtime_identity:desktop});
  await fsPort.mkdir(root,{mode:0o700});
  for(const[name,b]of[['prompt.utf8',prompt],['config.json',canonicalBytes(config)],['operation-manifest.json',canonicalBytes(manifest)]]){await fsPort.writeFile(join(root,name),b,{flag:'wx',mode:0o600});if(hash(await fsPort.readFile(join(root,name)))!==hash(b))throw Error('PREPARATION_READBACK');}
  return Object.freeze({status:'PREPARED_NOT_EXECUTABLE',schema:config.schema,runtime_admitted:false,prompt_bytes:prompt.length,prompt_sha256:hash(prompt),config_sha256:hash(canonicalBytes(config)),manifest_sha256:hash(canonicalBytes(manifest)),task_correctness:'NOT_EVALUATED'});
}
