import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {closed} from './job-spec.mjs';

export const NODE_RUNTIME=Object.freeze({path:'/home/zack/.local/share/squire-toolchain/node-v24.21.0-linux-x64/bin/node',bytes:126595440,
 sha256:'7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c'});
export const AGY_RUNTIME=Object.freeze({path:'/home/zack/.local/bin/agy',bytes:222322944,sha256:'d003c9d47e12f689d3448cad0f614289ccde5fb4c58bf8b4b543a9b514c097bc',required_version:'1.4.3'});
export const FIXTURE_FREEZE_SHA256='7c133ceaae9ca7466689f5e612dbd46fd8f0a300bb7fa7807d6c5cbacd4cccc7';
export const TASK_KEYS=Object.freeze(['task_specification','input_record_grammar','line_splitting_and_encoding','cli_interface_and_exit_rules','output_schemas_and_rounding']);
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export const canonicalBytes=v=>new TextEncoder().encode(JSON.stringify(sort(v),null,2)+'\n');
export function buildCodegenPrompt(task){
 const selected=Object.fromEntries(TASK_KEYS.map(k=>{if(!Object.hasOwn(task,k))throw Error('TASK_KEY_MISSING');return [k,task[k]];}));
 const bytes=canonicalBytes(selected);if(bytes.length<1||bytes.length>32768)throw Error('PROMPT_BOUND');return bytes;
}
export const CODEGEN_PROMPT_PROFILE = 'Q218A_PROMPT_CHANNEL_CLARIFICATION_V1';
const CHANNEL_PREFIX = "[OUTPUT CHANNEL INSTRUCTION]\nDuring provider generation, return solely the raw, runnable Node.js source code for src/summarizer.mjs directly in your final response string.\nDo not attempt tool calls or filesystem operations during generation; the host execution environment will write your response string directly to src/summarizer.mjs.\nWhen executed, your delivered Node.js program must implement all CLI interface and filesystem operations (reading input, writing summary and manifest) specified in the task description.\nDo not include markdown formatting or code fences (no triple backticks ```).\nDo not include outer JSON envelopes or JSON-quoted strings (the CLI owns JSON output serialization).\nDo not include explanations, conversational prose, or precomputed summary outputs.\nThe response must be valid UTF-8 source code between 100 and 65,536 bytes implementing the task specification below:\n\n";
export function buildClarifiedCodegenPrompt(task) {
 const projection=buildCodegenPrompt(task), prefix=new TextEncoder().encode(CHANNEL_PREFIX);
 const bytes=new Uint8Array(prefix.length+projection.length);bytes.set(prefix);bytes.set(projection,prefix.length);
 if(bytes.length>32768)throw Error('PROMPT_BOUND');return bytes;
}
export function programEnvironment(sourcePath){return Object.freeze({PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:join(dirname(dirname(dirname(sourcePath))),'.tmp')});}
export async function verifyExactFile(identity,ports){
 const st=await ports.lstat(identity.path);
 if(!st.isFile()||st.isSymbolicLink()||st.size!==identity.bytes)throw Error('FILE_IDENTITY_MISMATCH');
 let count=0;const h=createHash('sha256');
 for await(const bytes of ports.readChunks(identity.path)){count+=bytes.length;if(count>identity.bytes)throw Error('FILE_IDENTITY_MISMATCH');h.update(bytes);}
 if(count!==identity.bytes||h.digest('hex')!==identity.sha256)throw Error('FILE_IDENTITY_MISMATCH');
 return Object.freeze({...identity});
}
export function requireAdmission(bundle,config,configBytes){
 if(!bundle)throw Error('UNADMITTED_NATIVE_OPERATION');
 closed(bundle,['operator_receipt','config_sha256','job_id','scope','fix17_paths_admitted','preflight'],[],'admission');
 closed(bundle.preflight,['agy_version','subscription','credits_off','catalog_model','quota_available','evidence_receipt'],[],'preflight');
 if(typeof bundle.operator_receipt!=='string'||!bundle.operator_receipt||bundle.config_sha256!==hash(configBytes)||bundle.job_id!==config.job_id||bundle.scope!==config.scope||
  bundle.fix17_paths_admitted!==true||bundle.preflight.agy_version!=='1.4.3'||bundle.preflight.subscription!==true||bundle.preflight.credits_off!==true||
  bundle.preflight.catalog_model!=='gemini-3.8-flash-high'||bundle.preflight.quota_available!==true||typeof bundle.preflight.evidence_receipt!=='string'||!bundle.preflight.evidence_receipt)
  throw Error('UNADMITTED_NATIVE_OPERATION');
 return Object.freeze({...bundle,preflight:Object.freeze({...bundle.preflight})});
}
export const Q218_SCOPE='/home/zack/Documents/Codex/2026-10-19/squire-q218-onecase-5d907cf7-8120-4ca5-8135-322865ea9684';
export const Q218_JOB='5d907cf7-8120-4ca5-8135-322865ea9684';
export const GENERATION_SHUTDOWN=Object.freeze({term_grace_ms:3000,kill_grace_ms:2000,poll_interval_ms:200,stream_drain_timeout_ms:1000,persistence_timeout_ms:2000});
export function generationEnvironment(scope,ambient){
 const env={...ambient,TMPDIR:join(scope,'.tmp')};for(const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL'])delete env[key];return env;
}
