import {join} from 'node:path';
import {closed} from './job-spec.mjs';
import {canonicalBytes,hash,NODE_RUNTIME,AGY_RUNTIME,FIXTURE_FREEZE_SHA256,Q218_JOB,Q218_SCOPE,GENERATION_SHUTDOWN} from './bounded-codegen-plan.mjs';
import {publicFixtures} from '../fixtures/q218/public-fixtures.mjs';
export const PUBLIC_FREEZE_ROOT='/home/zack/Documents/Codex/2026-10-19/squire-q218-public-freeze-20261020';
export function fixtureConfigurations(){
 const run=join(Q218_SCOPE,'output','run-'+Q218_JOB);
 return publicFixtures().map(f=>({fixture_id:f.id,summarizer_path:join(run,'workspace','src','summarizer.mjs'),input_path:join(run,'runs','fixture-'+f.id,'input.ndjson'),
  output_path:join(run,'runs','fixture-'+f.id,'summary.json'),manifest_path:join(run,'runs','fixture-'+f.id,'manifest.json'),window_start:f.window_start,window_end:f.window_end,timeout_ms:5000}));
}
const same=(a,b)=>hash(canonicalBytes(a))===hash(canonicalBytes(b));
export function validateOperationConfig(c){
 closed(c,['schema','runtime_admitted','job_id','scope','source_commit','source_pins','node','agy','prompt','fixtures','fixture_inputs','fixture_configs',
 'generation_shutdown','preflight_freshness_ms','outer_observation_ms','fixture_aggregate_ms','max_direct_child_spawns','environment_policy','task_input'],[],'operation_config');
 if(c.schema!=='Q218A_OPERATION_V1'||c.runtime_admitted!==false||c.job_id!==Q218_JOB||c.scope!==Q218_SCOPE||c.preflight_freshness_ms!==300000||
 c.outer_observation_ms!==250000||c.fixture_aggregate_ms!==85000||c.max_direct_child_spawns!==19||
 !same(c.fixture_configs,fixtureConfigurations())||!same(c.generation_shutdown,GENERATION_SHUTDOWN)||
 !same(c.node,NODE_RUNTIME)||!same(c.agy,AGY_RUNTIME)||
 c.fixtures.sha256!==FIXTURE_FREEZE_SHA256||c.fixtures.bytes!==20720||
 c.fixtures.path!==join(PUBLIC_FREEZE_ROOT,'fixtures-freeze-manifest.json')||
 !same(c.fixture_inputs,Array.from({length:17},(_,i)=>join(PUBLIC_FREEZE_ROOT,`fixture-${String(i+1).padStart(2,'0')}`,'input.ndjson'))))throw Error('FROZEN_CONFIG_MISMATCH');
 for(const pin of Object.values(c.source_pins)){closed(pin,['bytes','sha256'],[],'source_pin');if(!Number.isSafeInteger(pin.bytes)||pin.bytes<0||typeof pin.sha256!=='string'||!/^[a-f0-9]{64}$/.test(pin.sha256))throw Error('SOURCE_PIN_INVALID');}
 if(!same(c.environment_policy,ENVIRONMENT_POLICY))throw Error('ENVIRONMENT_POLICY_MISMATCH');
 return c;
}
export const SOURCE_FILES=Object.freeze([
 'src/bounded-codegen-plan.mjs','src/bounded-codegen-configuration.mjs','src/bounded-codegen-campaign.mjs',
 'src/limited-runner.mjs','src/internal/limited-core.mjs','src/internal/limited-diagnostics.mjs','src/limited-generated-executor.mjs','src/limited-source-staging.mjs','src/limited-stream-collector.mjs','src/limited-job-record.mjs',
 'src/job-spec.mjs','src/agy-profile.mjs','src/provider-metadata.mjs','src/node-process-port.mjs','src/owned-group.mjs',
 'fixtures/q218/public-fixtures.mjs','fixtures/q218/reference-summarizer.mjs','fixtures/q218/verify-result.mjs','fixtures/q218/freeze.mjs',
 'fixtures/q218/SPEC-CLARIFICATION-FIX-08-V1.json','acceptance/bounded-codegen-entrypoint.mjs','acceptance/prepare-bounded-codegen.mjs'
]);
export const ENVIRONMENT_POLICY=Object.freeze({generation:'INHERIT_PROCESS_ENV_MINUS_THREE_AGY_API_KEYS_SCOPED_TMPDIR',
 deleted_keys:['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL'],program:{PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:'<run>/.tmp'},
 safety:'ENVIRONMENT_KEY_EXCLUSION_ONLY_NOT_FILESYSTEM_OR_HOSTILE_CODE_ISOLATION'});
