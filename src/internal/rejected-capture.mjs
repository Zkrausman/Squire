import {types} from 'node:util';
const reasons=new Set(['CODEGEN_PAYLOAD_TOO_SMALL','CODEGEN_MARKDOWN_REJECTED','CODEGEN_PAYLOAD_TOO_LARGE','CODEGEN_ENCODING_REJECTED','PROJECT_PAYLOAD_TOO_SMALL','PROJECT_MARKDOWN_REJECTED','PROJECT_PAYLOAD_TOO_LARGE']);
const statuses=new Set(['NOT_REQUESTED','NOT_ELIGIBLE','REQUESTED','PUBLISHED','FAILED','UNKNOWN']);
const errors=new Set(['RETENTION_IO_FAILED','RETENTION_TIMEOUT_OR_ABORTED','RETENTION_CAPACITY_EXCEEDED','RETENTION_PRIVATE_ROOT_UNAVAILABLE','RETENTION_INVALID_CAPTURE']);
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
export function ownData(v,k){if(!v||typeof v!=='object'||types.isProxy(v))throw Error('INVALID_RETENTION_DATA');const d=Object.getOwnPropertyDescriptor(v,k);if(d&&!Object.hasOwn(d,'value'))throw Error('INVALID_RETENTION_DATA');return d?.value;}
export function publicRetention(status='NOT_REQUESTED',capture=null,error=null,count=null){
 return Object.freeze({retention_status:statuses.has(status)?status:'FAILED',rejection_stage:capture?'PAYLOAD':null,
  rejection_reason:capture&&reasons.has(capture.reason)?capture.reason:null,exact_response_bytes:capture?.exact_response_bytes??null,
  retained_bytes_count:count,retained_truncated:count!==null&&capture?.exact_response_bytes>count,
  retention_error:errors.has(error)?error:null});
}
export function takeRejectedCapture(collector){
 const method=ownData(collector,'diagnosticCapture');if(typeof method!=='function'||types.isProxy(method))return null;
 const v=Reflect.apply(method,collector,[]);if(v===null)return null;
 const stage=ownData(v,'stage'),reason=ownData(v,'reason'),eligible=ownData(v,'eligible'),length=ownData(v,'exact_response_bytes'),bytes=ownData(v,'response_bytes');
 if(stage!=='PAYLOAD'||!reasons.has(reason))throw Error('INVALID_RETENTION_DATA');
 if(eligible===false){if(length!==null||bytes!==null)throw Error('INVALID_RETENTION_DATA');return Object.freeze({eligible:false,reason,exact_response_bytes:null,response_bytes:null});}
 if(eligible!==true||reason==='CODEGEN_ENCODING_REJECTED'||!Number.isSafeInteger(length)||length<0||length>1048576||!types.isUint8Array(bytes)||Reflect.apply(byteLength,bytes,[])!==Math.min(length,65536))throw Error('INVALID_RETENTION_DATA');
 const owned=new Uint8Array(Math.min(length,65536));Uint8Array.prototype.set.call(owned,bytes);
 try{Uint8Array.prototype.fill.call(bytes,0);}catch{}
 return Object.freeze({eligible:true,reason,exact_response_bytes:length,response_bytes:owned});
}
export function retentionResult(value,capture){
 const status=ownData(value,'retention_status'),error=ownData(value,'retention_error');
 if(!['PUBLISHED','FAILED','UNKNOWN'].includes(status)||error!==null&&!errors.has(error)||status==='PUBLISHED'&&error!==null)throw Error('INVALID_RETENTION_DATA');
 return publicRetention(status,capture,error,status==='PUBLISHED'?Math.min(capture.exact_response_bytes,65536):null);
}
