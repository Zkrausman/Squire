// Finite reporting only: never retain raw exceptions, wrappers, envelopes or arbitrary strings.
import {types} from 'node:util';
import {ContractError} from '../job-spec.mjs';
const pairs=new Map([
 ['COLLECTION',new Set(['COLLECTION_FAILED'])],
 ['ENVELOPE',new Set(['PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE','ENVELOPE_PARSE_ERROR','MISSING_TERMINAL','REPEATED_TERMINAL_REJECTED','CONFLICTING_TERMINAL_EVENTS','TRAILING_DATA_AFTER_TERMINAL'])],
 ['PROVIDER_STATUS',new Set(['PROVIDER_NON_SUCCESS','TURN_FAILED'])],['RESPONSE',new Set(['RESPONSE_STRING_REQUIRED','AMBIGUOUS_AGENT_MESSAGE'])],
 ['PAYLOAD',new Set(['CODEGEN_MARKDOWN_REJECTED','CODEGEN_ENCODING_REJECTED','CODEGEN_PAYLOAD_TOO_SMALL','CODEGEN_PAYLOAD_TOO_LARGE','CODEGEN_SOURCE_STRING_REQUIRED','TASK_PAYLOAD_INVALID'])],
 ['UNCLASSIFIED',new Set(['UNKNOWN_REJECTION'])]
]);
const fields=new Map([
 ['limited_collection',['COLLECTION','COLLECTION_FAILED']],['limited_envelope',['ENVELOPE','ENVELOPE_PARSE_ERROR']],
 ...['PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE'].map(x=>[x,['ENVELOPE',x]]),
 ['PROVIDER_NON_SUCCESS',['PROVIDER_STATUS','PROVIDER_NON_SUCCESS']],['limited_response',['RESPONSE','RESPONSE_STRING_REQUIRED']],
 ['limited_payload',['PAYLOAD','TASK_PAYLOAD_INVALID']],
 ...['CODEGEN_MARKDOWN_REJECTED','CODEGEN_ENCODING_REJECTED','CODEGEN_PAYLOAD_TOO_SMALL','CODEGEN_PAYLOAD_TOO_LARGE','CODEGEN_SOURCE_STRING_REQUIRED'].map(x=>[x,['PAYLOAD',x]])
]);
const statuses=new Set(['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING','turn.completed','turn.failed']);
const counters=['input','output','cache_read','thinking','total'];
const eligible=new Set(['PROVIDER_STATUS','RESPONSE','PAYLOAD']);
const ordinary=v=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v);
function data(object,key){const d=Object.getOwnPropertyDescriptor(object,key);if(d&&!Object.hasOwn(d,'value'))throw Error('ACCESSOR');return d?.value;}
export function sanitizeDiagnosticMetadata(meta){
 try{
  if(!ordinary(meta))return null;
  const st=data(meta,'provider_reported_status'),duration=data(meta,'duration_seconds'),source=data(meta,'usage');
  const usage=Object.fromEntries(counters.map(k=>[k,null]));
  if(source!==null&&source!==undefined){if(!ordinary(source))return null;for(const k of counters){const v=data(source,k);if(Number.isSafeInteger(v)&&v>=0)usage[k]=v;}}
  const codex=st==='turn.completed'||st==='turn.failed';
  const extra=codex?data(meta,'extra_metadata'):null;const reasoning=extra&&ordinary(extra)?data(extra,'codex_reasoning_output_tokens'):null;
  if(codex){usage.thinking=null;usage.total=null;}
  return Object.freeze({...(codex?{extra_metadata:Object.freeze({codex_reasoning_output_tokens:Number.isSafeInteger(reasoning)&&reasoning>=0?reasoning:null,backend_model:'UNKNOWN'})}:{}),provider_reported_status:typeof st==='string'&&statuses.has(st)?st:null,
   duration_seconds:!codex&&typeof duration==='number'&&Number.isFinite(duration)&&duration>=0?duration:null,usage:Object.freeze(usage)});
 }catch{return null;}
}
export function diagnosticReport(stage,reason,meta=null){
 if(typeof stage!=='string'||typeof reason!=='string'||!pairs.get(stage)?.has(reason)){stage='UNCLASSIFIED';reason='UNKNOWN_REJECTION';}
 return Object.freeze({stage,reason,metadata:eligible.has(stage)?sanitizeDiagnosticMetadata(meta):null});
}
export function legacyDiagnostic(error){
 try{
  if(ordinary(error)&&error instanceof ContractError){const field=data(error,'field'),pair=typeof field==='string'?fields.get(field):null;
   if(pair)return diagnosticReport(pair[0],pair[1]);}
 }catch{}
 return diagnosticReport('UNCLASSIFIED','UNKNOWN_REJECTION');
}
export function collectorDiagnostic(collector,error){
 try{
  if(ordinary(collector)){
   const method=data(collector,'diagnosticReport');
   if(typeof method==='function'&&!types.isProxy(method)){
    const report=Reflect.apply(method,collector,[]);
    if(ordinary(report)){
     const stage=data(report,'stage'),reason=data(report,'reason');
     if(typeof stage==='string'&&typeof reason==='string'&&pairs.get(stage)?.has(reason)){
      // All nested metadata extraction remains within guards; output is a new immutable projection.
      const meta=data(report,'metadata');
      return diagnosticReport(stage,reason,meta);
     }
    }
   }
  }
 }catch{}
 return legacyDiagnostic(error);
}
