// Single public-text request only; importing or preparing this data executes no task.
import {types} from 'node:util';
import {closed,fail} from './job-spec.mjs';
import {validateCodexPrompt} from './codex-profile.mjs';

export const SINGLE_JS_PREFIX = '[OUTPUT CHANNEL INSTRUCTION]\nDuring provider generation, return solely the raw, runnable Node.js source code for src/task.mjs directly in your final response string.\nDo not attempt tool calls or filesystem operations during generation; the host execution environment will write your response string directly to src/task.mjs.\nWhen executed, your delivered Node.js program must implement all specified behavior using standard Node.js 24 APIs without external dependencies.\nDo not include markdown formatting or code fences (no triple backticks ```).\nDo not include outer JSON envelopes or JSON-quoted strings.\nDo not include explanations, conversational prose, or tests.\nThe response must be valid UTF-8 source code between 100 and 65,536 bytes implementing the task specification below:\n\n';
export const SINGLE_JS_PREFIX_IDENTITY=Object.freeze({bytes:787,sha256:'f0b17b05838169338abea310fa524e0b2831542840ce573602a9e082d1fcac1e'});
const requestKeys=['schema','task_id','task_prompt','runtime_target','output_target'];
export function validateSingleJsRequest(value){
  closed(value,requestKeys,[],'single_js_request');
  if(value.schema!=='SQUIRE2_SINGLE_JS_REQUEST_V1'||typeof value.task_id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.task_id)||value.runtime_target!=='node24-esm'||value.output_target!=='src/task.mjs'||typeof value.task_prompt!=='string')fail('single_js_request');
  const bytes=new TextEncoder().encode(value.task_prompt);
  if(bytes.length<100||bytes.length>31981||new TextDecoder().decode(bytes)!==value.task_prompt||!validateCodexPrompt(bytes).valid)fail('single_js_prompt');
  return Object.freeze(Object.fromEntries(requestKeys.map(k=>[k,value[k]])));
}
export function parseSingleJsRequest(bytes){
  if(types.isProxy(bytes)||!types.isUint8Array(bytes))fail('single_js_request_bytes');
  const length=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get.call(bytes);
  if(length>65536)fail('PAYLOAD_SIZE_EXCEEDED');
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('MALFORMED_UTF8');}
  let i=0;const ws=()=>{while(/[\x20\t\r\n]/.test(text[i]??'!'))i++;};
  function string(){if(text[i]!== '"')fail('MALFORMED_JSON');const begin=i++;while(i<text.length){const c=text[i++];if(c==='"'){try{return JSON.parse(text.slice(begin,i));}catch{fail('MALFORMED_JSON');}}if(c==='\\')i++;}fail('MALFORMED_JSON');}
  ws();if(text[i++]!=='{')fail('MALFORMED_JSON');ws();const out=Object.create(null),seen=new Set();
  let ended=false;if(text[i]!=='}')while(i<text.length){
    const k=string();if(seen.has(k))fail('DUPLICATE_KEY_CONFLICT');seen.add(k);
    if(!requestKeys.includes(k))fail('UNEXPECTED_FIELD');ws();if(text[i++]!==':')fail('MALFORMED_JSON');ws();out[k]=string();ws();const c=text[i++];if(c==='}'){ended=true;break;}if(c!==',')fail('MALFORMED_JSON');ws();
  }else {i++;ended=true;}
  ws();if(i!==text.length||!ended)fail('MALFORMED_JSON');return validateSingleJsRequest(out);
}
export function buildSingleJsCodegenPrompt(request){
  const r=validateSingleJsRequest(request),bytes=new TextEncoder().encode(SINGLE_JS_PREFIX+r.task_prompt);
  if(!validateCodexPrompt(bytes).valid)fail('single_js_prompt');
  return bytes; // Fresh owned view; a nonempty Uint8Array cannot be Object.freeze'd.
}
