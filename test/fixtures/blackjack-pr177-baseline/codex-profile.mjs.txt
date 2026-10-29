// Pure Codex profile data. No executable/model defaults, launcher or native admission.
import {types} from 'node:util';
import {closed,fail,text} from './job-spec.mjs';
export const CODEX_REQUIRED_VERSION='0.160.0';
export const CODEX_BYTE_LIMITS=Object.freeze({max_prompt_bytes:32768,max_stdout_bytes:1048576,max_stderr_bytes:65536});
export const CODEX_CHILD_ENV_DELETIONS=Object.freeze(['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL']);
export const CODEX_OUTPUT_CONTRACT='CODEX_JSONL_SINGLE_AGENT_V1';
const lengthOf=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
export function validateCodexPrompt(value){
 try{
  if(types.isProxy(value)||!types.isUint8Array(value))throw 0;
  const size=lengthOf.call(value);if(size<1||size>32768)throw 0;
  const bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=value[i];
  const decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if(decoded.includes('\0')||decoded.includes('\uFEFF'))throw 0;
  return Object.freeze({valid:true,byte_length:size});
 }catch{return Object.freeze({valid:false,byte_length:null});}
}
export function validateCodexTuple(model,effort,authorization){
 closed(authorization,['operator_receipt','supported_tuples'],[],'codex_authorization');
 if(!text(authorization.operator_receipt)||typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)||/^gemini|^claude/i.test(model))fail('INVALID_MODEL');
 if(typeof effort!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(effort))fail('INVALID_EFFORT');
 const tuples=authorization.supported_tuples;
 if(types.isProxy(tuples)||!Array.isArray(tuples)||tuples.length<1||tuples.length>64)fail('codex_authorization');
 let match=false;
 for(let i=0;i<tuples.length;i++){
  const d=Object.getOwnPropertyDescriptor(tuples,String(i));if(!d||!Object.hasOwn(d,'value'))fail('codex_authorization');
  closed(d.value,['model','effort'],[],'codex_tuple');
  if(d.value.model===model&&d.value.effort===effort)match=true;
 }
 if(!match)fail('UNAUTHORIZED_MODEL_EFFORT');
 return Object.freeze({model,effort,operator_receipt:authorization.operator_receipt});
}
export function prepareCodexArgv(spec){
 closed(spec,['requested_model','effort','observed_cli_version','prompt_bytes','authorization'],[],'codex_profile');
 if(spec.observed_cli_version!==CODEX_REQUIRED_VERSION)fail('CODEX_VERSION_MISMATCH');
 validateCodexTuple(spec.requested_model,spec.effort,spec.authorization);
 if(!validateCodexPrompt(spec.prompt_bytes).valid)fail('CODEX_PROMPT_INVALID');
 return Object.freeze({runtime_admitted:false,status:'PREPARED_NOT_EXECUTABLE',argv:Object.freeze(['exec','--json','--ephemeral','--sandbox','read-only','--model',spec.requested_model,'-c',`model_reasoning_effort=${JSON.stringify(spec.effort)}`,'-'])});
}
export function codexEnvironment(scope,ambient){const env={...ambient,TMPDIR:scope+'/.tmp'};for(const k of CODEX_CHILD_ENV_DELETIONS)delete env[k];return env;}
