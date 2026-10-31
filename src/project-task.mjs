// Pure project request/envelope parsing. No I/O, code evaluation or provider calls.
import {types} from 'node:util';
import {DESKTOP_TARGET,DESKTOP_CODEGEN_PREFIX,DESKTOP_PREFIX_IDENTITY} from './desktop-profile.mjs';
export {DESKTOP_TARGET,DESKTOP_CODEGEN_PREFIX,DESKTOP_PREFIX_IDENTITY} from './desktop-profile.mjs';
import {closed,fail} from './job-spec.mjs';
import {validateCodexPrompt} from './codex-profile.mjs';
import {planStaging,safeMultifileErrorCode} from './multifile-staging.mjs';
import {hash} from './bounded-codegen-plan.mjs';
export const PROJECT_CODEGEN_PREFIX="[OUTPUT CHANNEL INSTRUCTION]\nDuring provider generation, return solely a single valid, minified or unindented JSON object file-envelope directly in your final response string.\nDo not attempt tool calls or filesystem operations during generation; the host execution environment will parse your file-envelope and stage all candidate files directly.\nWhen executed, your delivered project files must implement all specified behavior using standard Node.js 24 APIs without external dependencies.\nDo not include markdown formatting or code fences (no triple backticks ```).\nDo not include explanations, conversational prose, or text outside the JSON object.\nThe response must be a single JSON object with schema \"SQUIRE2_PROJECT_FILE_ENVELOPE_V1\" and closed shape: {\"schema\":\"SQUIRE2_PROJECT_FILE_ENVELOPE_V1\",\"files\":[{\"path\":\"<relative-path>\",\"classification\":\"SOURCE\"|\"LOCAL_ASSET\"|\"DOC\",\"encoding\":\"utf-8\"|\"base64\",\"content\":\"<payload>\"}]}.\nThe total response must be valid UTF-8 JSON implementing the project specification below:\n\n";
export const PROJECT_PREFIX_IDENTITY=Object.freeze({bytes:1030,sha256:'9b213319932227f2a9c46c8dfe7b666f188beb4c5d1d2e18fbd2f52b3aca455e'});
const encoder=new TextEncoder(),keys=['schema','task_id','task_prompt','runtime_target','stage_target'];
const invalidText=s=>typeof s!=='string'||/[\u0000\uFEFF\uD800-\uDFFF]/u.test(s);
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
function parseProjectJsonText(text){
 if(/[\u0000\uFEFF]/u.test(text))fail('MALFORMED_UTF8');
 let i=0,nodes=0;const ws=()=>{while(/[\x20\t\r\n]/.test(text[i]??'!'))i++;};
 const number=/(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
 function string(){if(text[i]!=='"')fail('MALFORMED_JSON');const begin=i++;while(i<text.length){const c=text[i++];if(c==='"'){let s;try{s=JSON.parse(text.slice(begin,i));}catch{fail('MALFORMED_JSON');}if(invalidText(s))fail('PROJECT_ENCODING_REJECTED');return s;}if(c==='\\')i++;}fail('MALFORMED_JSON');}
 function value(depth){if(depth>8||++nodes>1024)fail('PROJECT_SCHEMA_MISMATCH');ws();if(text[i]==='"')return string();
  if(text[i]==='{'){i++;ws();const o=Object.create(null),seen=new Set();if(text[i]==='}'){i++;return o;}while(i<text.length){const k=string();if(seen.has(k))fail('DUPLICATE_KEY_CONFLICT');if(seen.size>=32||['__proto__','constructor','prototype'].includes(k))fail('PROJECT_SCHEMA_MISMATCH');seen.add(k);ws();if(text[i++]!==':')fail('MALFORMED_JSON');o[k]=value(depth+1);ws();const t=text[i++];if(t==='}')return o;if(t!==',')fail('MALFORMED_JSON');ws();}fail('MALFORMED_JSON');}
  if(text[i]==='['){i++;ws();const a=[];if(text[i]===']'){i++;return a;}while(i<text.length){if(a.length>=50)fail('PROJECT_AGGREGATE_CAPACITY_EXCEEDED');a.push(value(depth+1));ws();const t=text[i++];if(t===']')return a;if(t!==',')fail('MALFORMED_JSON');}fail('MALFORMED_JSON');}
  number.lastIndex=i;const m=number.exec(text);if(!m)fail('MALFORMED_JSON');i+=m[0].length;const v=JSON.parse(m[0]);if(typeof v==='number'&&!Number.isSafeInteger(v))fail('PROJECT_SCHEMA_MISMATCH');return v;
 }
 const v=value(0);ws();if(i!==text.length)fail('MALFORMED_JSON');return v;
}
export function parseProjectJson(input,max=1048576){
 if(types.isProxy(input)||!types.isUint8Array(input))fail('MALFORMED_UTF8');
 const n=Reflect.apply(byteLength,input,[]);
 if(n>max)fail('PAYLOAD_SIZE_EXCEEDED');
 let text;
 try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}
 catch{fail('MALFORMED_UTF8');}
 return parseProjectJsonText(text);
}
export function validateProjectRequest(value){
 closed(value,keys,[],'project_request');if(value.schema!=='SQUIRE2_PROJECT_REQUEST_V1'||typeof value.task_id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.task_id)||!['node24-esm',DESKTOP_TARGET].includes(value.runtime_target)||value.stage_target!=='multifile-candidate'||invalidText(value.task_prompt))fail('project_request');
 const max=32768-(value.runtime_target===DESKTOP_TARGET?DESKTOP_PREFIX_IDENTITY.bytes:PROJECT_PREFIX_IDENTITY.bytes);
 if(value.task_prompt.length>max)fail('project_prompt');const b=encoder.encode(value.task_prompt);if(b.length<1||b.length>max||!validateCodexPrompt(b).valid)fail('project_prompt');return Object.freeze(Object.fromEntries(keys.map(k=>[k,value[k]])));
}
export const parseProjectRequest=bytes=>validateProjectRequest(parseProjectJson(bytes,65536));
export function buildProjectCodegenPrompt(request){const r=validateProjectRequest(request),b=encoder.encode((r.runtime_target===DESKTOP_TARGET?DESKTOP_CODEGEN_PREFIX:PROJECT_CODEGEN_PREFIX)+r.task_prompt);if(!validateCodexPrompt(b).valid)fail('project_prompt');return b;}
const legacyClassCaps=Object.freeze({
 SOURCE:Object.freeze([65536,25,524288]),
 LOCAL_ASSET:Object.freeze([524288,20,2097152]),
 DOC:Object.freeze([65536,5,131072])
});
const largeClassCaps=Object.freeze({
 SOURCE:Object.freeze([524288,25,2097152]),
 LOCAL_ASSET:Object.freeze([524288,20,2097152]),
 DOC:Object.freeze([65536,5,131072])
});
const legacyPayloadPolicy=Object.freeze({
 maxEnvelopeBytes:1048576,maxDecodedProjectBytes:1048576,maxFiles:50,
 classCaps:legacyClassCaps
});
const largePayloadPolicy=Object.freeze({
 maxEnvelopeBytes:4194304,maxDecodedProjectBytes:4194304,maxFiles:50,
 classCaps:largeClassCaps
});
function validateProjectPayloadJsonWithPolicy(input,policy){
 if(types.isProxy(input)||!types.isUint8Array(input))fail('PROJECT_ENCODING_REJECTED');
 const size=Reflect.apply(byteLength,input,[]);
 if(size<2)fail('PROJECT_PAYLOAD_TOO_SMALL');
 if(size>policy.maxEnvelopeBytes)fail('PROJECT_PAYLOAD_TOO_LARGE');
 let response;
 try{response=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}
 catch{fail('PROJECT_ENCODING_REJECTED');}
 if(response.includes('```'))fail('PROJECT_MARKDOWN_REJECTED');
 if(invalidText(response))fail('PROJECT_ENCODING_REJECTED');
 let root;
 try{root=parseProjectJsonText(response);}
 catch(e){
  if(e?.field==='DUPLICATE_KEY_CONFLICT')fail('PROJECT_DUPLICATE_KEY');
  if(e?.field==='PROJECT_ENCODING_REJECTED'||e?.field==='MALFORMED_UTF8')fail('PROJECT_ENCODING_REJECTED');
  if(e?.field==='PROJECT_AGGREGATE_CAPACITY_EXCEEDED')throw e;
  fail('PROJECT_SCHEMA_MISMATCH');
 }
 try{
  closed(root,['schema','files'],[]);
  if(root.schema!=='SQUIRE2_PROJECT_FILE_ENVELOPE_V1'||!Array.isArray(root.files)||
     root.files.length<1||root.files.length>policy.maxFiles)fail('PROJECT_SCHEMA_MISMATCH');
  for(const f of root.files)closed(f,['path','classification','encoding','content'],[]);
 }catch{fail('PROJECT_SCHEMA_MISMATCH');}
 for(const f of root.files){
  if(!Object.hasOwn(policy.classCaps,f.classification))fail('PROJECT_CLASSIFICATION_INVALID');
  if(!['utf-8','base64'].includes(f.encoding))fail('PROJECT_ENCODING_INVALID');
  if(typeof f.content!=='string')fail('PROJECT_SCHEMA_MISMATCH');
  const cap=policy.classCaps[f.classification][0];
  const maxCharacters=f.encoding==='base64'?Math.ceil(cap/3)*4:cap;
  if(f.content.length>maxCharacters)fail('PROJECT_FILE_SIZE_EXCEEDED');
 }
 try{
  // Validate paths and class names with empty bytes. Decoded large file bodies
  // never enter the legacy 64 KiB staging planner.
  planStaging({
   stage_operation_id:'validation',caller_label:'project',
   files:root.files.map(f=>({
    path:f.path,classification:f.classification,content:new Uint8Array()
   }))
  });
 }catch(e){
  const code=safeMultifileErrorCode(e);
  if(code==='PATH_COLLISION_REJECTED')fail('PROJECT_PATH_COLLISION');
  if(code==='PATH_TRAVERSAL_REJECTED')fail('PROJECT_PATH_TRAVERSAL');
  if(code==='CAPACITY_EXCEEDED')fail('PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
  fail('PROJECT_PATH_INVALID');
 }
 const counts={},totals={};let total=0;const files=[];
 try{
  for(const f of root.files){
   let b=null;
   try{
    if(f.encoding==='base64'){
     if(f.content.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.content)){
      fail('PROJECT_BASE64_INVALID');
     }
     const decoded=Buffer.from(f.content,'base64');
     try{
      if(decoded.toString('base64')!==f.content)fail('PROJECT_BASE64_INVALID');
      b=new Uint8Array(decoded);
     }finally{decoded.fill(0);}
    }else{
     if(invalidText(f.content))fail('PROJECT_ENCODING_REJECTED');
     b=encoder.encode(f.content);
    }
    const [max,count,aggregate]=policy.classCaps[f.classification];
    if(b.length>max||f.classification==='SOURCE'&&!b.length){
     fail('PROJECT_FILE_SIZE_EXCEEDED');
    }
    counts[f.classification]=(counts[f.classification]??0)+1;
    totals[f.classification]=(totals[f.classification]??0)+b.length;
    total+=b.length;
    if(counts[f.classification]>count||totals[f.classification]>aggregate||
       total>policy.maxDecodedProjectBytes){
     fail('PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
    }
    files.push(Object.freeze({
     path:f.path,classification:f.classification,bytes:b.length,
     sha256:hash(b),content:b
    }));
    b=null;
   }finally{b?.fill(0);}
  }
  return Object.freeze({files:Object.freeze(files)});
 }catch(error){
  for(const file of files)file.content.fill(0);
  throw error;
 }
}
export function validateProjectPayloadJson(input){
 return validateProjectPayloadJsonWithPolicy(input,legacyPayloadPolicy);
}
export function validateLargeProjectPayloadJson(input){
 return validateProjectPayloadJsonWithPolicy(input,largePayloadPolicy);
}
