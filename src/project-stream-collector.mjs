// Private source intake. Public metadata never contains candidate response text.
import {types} from 'node:util';
import {fail} from './job-spec.mjs';
import {
 decodeCodexJsonl,decodeLargeProjectCodexJsonl,
 iterateLargeProjectCodexJsonlFrames
} from './provider-metadata.mjs';
import {diagnosticReport} from './internal/limited-diagnostics.mjs';
import {
 validateProjectPayloadJson,validateLargeProjectPayloadJson
} from './project-task.mjs';
import {PROJECT_OUTPUT_LARGE_PROFILE} from './project-coding-profile.mjs';
const lengthOf=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
const payloadReasons=new Set(['PROJECT_PAYLOAD_TOO_SMALL','PROJECT_PAYLOAD_TOO_LARGE','PROJECT_MARKDOWN_REJECTED','PROJECT_ENCODING_REJECTED','PROJECT_SCHEMA_MISMATCH','PROJECT_DUPLICATE_KEY','PROJECT_PATH_INVALID','PROJECT_PATH_TRAVERSAL','PROJECT_PATH_COLLISION','PROJECT_CLASSIFICATION_INVALID','PROJECT_ENCODING_INVALID','PROJECT_BASE64_INVALID','PROJECT_FILE_SIZE_EXCEEDED','PROJECT_AGGREGATE_CAPACITY_EXCEEDED']);
export function createCodexProjectStreamCollector(){
 let arena=new Uint8Array(1048576),out=0,err=0,used=0,outEof=false,errEof=false,failed=false,sealed=false,report=null,capture=null,accepted=null;
 const clear=()=>{capture?.response_bytes?.fill(0);capture=null;};
 const reject=(stage,reason,metadata=null)=>{report=diagnosticReport(stage,reason,metadata);fail(reason);};
 return Object.freeze({
  chunk(stream,bytes){if(sealed)return false;if(!['stdout','stderr'].includes(stream)||types.isProxy(bytes)||!types.isUint8Array(bytes))fail('limited_chunk');const n=Reflect.apply(lengthOf,bytes,[]),cap=stream==='stdout'?1048576:65536;if(stream==='stdout')out=Math.min(cap+1,out+n);else err=Math.min(cap+1,err+n);if((stream==='stdout'?out:err)>cap){failed=true;arena?.fill(0);arena=null;return false;}if(stream==='stdout'&&arena){Uint8Array.prototype.set.call(arena,bytes,used);used+=n;}return !failed;},
  eof(stream){if(!sealed){if(stream==='stdout')outEof=true;else if(stream==='stderr')errEof=true;else fail('limited_stream');}},
  snapshot:()=>Object.freeze({stdout_bytes_observed:out,stderr_bytes_observed:err,stdout_eof:outEof,stderr_eof:errEof,io_drained:outEof&&errEof&&!failed}),
  diagnosticReport:()=>report,
  diagnosticCapture:()=>capture?Object.freeze({...capture,response_bytes:capture.response_bytes===null?null:new Uint8Array(capture.response_bytes)}):null,
  decode(raw={}){
   clear();report=null;let transport=null,envelope=null;
   try{
    if(sealed||failed||!outEof||!errEof||!arena)reject('COLLECTION','COLLECTION_FAILED');transport=arena.slice(0,used);
    const metadata=decodeCodexJsonl({raw_payload_bytes:transport,max_response_bytes:1048576,wrapper_exit_code:raw.exit_code??null,wrapper_signal:raw.exit_signal??null,wrapper_wall_ms:raw.process_wall_ms??null});
    if(metadata.parser_status==='PARSE_ERROR'){const known=['PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE','MISSING_TERMINAL','REPEATED_TERMINAL_REJECTED','CONFLICTING_TERMINAL_EVENTS'];reject('ENVELOPE',known.includes(metadata.diagnostic_code)?metadata.diagnostic_code:'ENVELOPE_PARSE_ERROR');}
    if(metadata.provider_reported_status!=='turn.completed')reject('PROVIDER_STATUS',metadata.provider_reported_status==='turn.failed'?'TURN_FAILED':'PROVIDER_NON_SUCCESS',metadata);
    const events=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(transport).split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));let terminal=false,started=0,messages=0,response;
    for(const event of events){if(terminal)reject('ENVELOPE','TRAILING_DATA_AFTER_TERMINAL');if(event.type==='turn.started'&&(++started!==1||messages))reject('ENVELOPE','ENVELOPE_PARSE_ERROR');if(event.type==='error')reject('PROVIDER_STATUS','PROVIDER_NON_SUCCESS',metadata);if(event.type==='item.completed'&&event.item?.type==='agent_message'){if(started!==1)reject('ENVELOPE','ENVELOPE_PARSE_ERROR');if(++messages>1)reject('RESPONSE','AMBIGUOUS_AGENT_MESSAGE',metadata);response=event.item.text;}if(event.type==='turn.completed')terminal=true;}
    if(started!==1)reject('ENVELOPE','ENVELOPE_PARSE_ERROR');if(messages!==1||typeof response!=='string')reject('RESPONSE','RESPONSE_STRING_REQUIRED',metadata);
    if(/[\u0000\uFEFF\uD800-\uDFFF]/u.test(response))reject('PAYLOAD','PROJECT_ENCODING_REJECTED',metadata);
    envelope=new TextEncoder().encode(response);let payload;
    try{payload=validateProjectPayloadJson(envelope);}catch(e){const d=e&&typeof e==='object'&&!types.isProxy(e)?Object.getOwnPropertyDescriptor(e,'field'):null,reason=d&&Object.hasOwn(d,'value')&&payloadReasons.has(d.value)?d.value:'PROJECT_SCHEMA_MISMATCH';
     const eligible=['PROJECT_PAYLOAD_TOO_SMALL','PROJECT_MARKDOWN_REJECTED','PROJECT_PAYLOAD_TOO_LARGE'].includes(reason)&&!/[\uD800-\uDFFF]/u.test(response)&&envelope.length<=1048576;
     if(['PROJECT_PAYLOAD_TOO_SMALL','PROJECT_MARKDOWN_REJECTED','PROJECT_PAYLOAD_TOO_LARGE'].includes(reason))capture=Object.freeze({eligible,stage:'PAYLOAD',reason,exact_response_bytes:eligible?envelope.length:null,response_bytes:eligible?envelope.slice(0,65536):null});reject('PAYLOAD',reason,metadata);
    }
    accepted=payload;const result={bytes:envelope,metadata,payload};envelope=null;return result;
   }finally{transport?.fill(0);envelope?.fill(0);}
  },
  close(){sealed=true;arena?.fill(0);arena=null;used=0;report=null;for(const f of accepted?.files??[])f.content.fill(0);accepted=null;clear();}
 });
}

const largeEnvelopeReasons=new Set([
 'PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON',
 'DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE','MISSING_TERMINAL',
 'REPEATED_TERMINAL_REJECTED','CONFLICTING_TERMINAL_EVENTS',
 'TRAILING_DATA_AFTER_TERMINAL','ENVELOPE_PARSE_ERROR'
]);

export function createCodexLargeProjectStreamCollector(){
 const stdoutLimit=PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes;
 const stderrLimit=PROJECT_OUTPUT_LARGE_PROFILE.max_stderr_bytes;
 let arena=new Uint8Array(stdoutLimit),out=0,err=0,used=0;
 let outEof=false,errEof=false,failed=false,sealed=false;
 let report=null,capture=null,accepted=null,loopActive=false,loopRejected=false;
 const clearCapture=()=>{capture?.response_bytes?.fill(0);capture=null;};
 const reject=(stage,reason,metadata=null)=>{
  report=diagnosticReport(stage,reason,metadata);
  if(loopActive)loopRejected=true;
  fail(reason);
 };
 const capturePayload=(reason,bytes)=>{
  const eligible=bytes!==null&&bytes.length<=1048576;
  capture=Object.freeze({
   eligible,stage:'PAYLOAD',reason,
   exact_response_bytes:eligible?bytes.length:null,
   response_bytes:eligible?bytes.slice(0,65536):null
  });
 };
 return Object.freeze({
  chunk(stream,bytes){
   if(sealed)return false;
   if(!['stdout','stderr'].includes(stream)||types.isProxy(bytes)||
      !types.isUint8Array(bytes))fail('limited_chunk');
   const n=Reflect.apply(lengthOf,bytes,[]);
   const cap=stream==='stdout'?stdoutLimit:stderrLimit;
   if(stream==='stdout')out=Math.min(cap+1,out+n);
   else err=Math.min(cap+1,err+n);
   if((stream==='stdout'?out:err)>cap){
    failed=true;arena?.fill(0);arena=null;used=0;
    return false;
   }
   if(stream==='stdout'&&arena){
    Uint8Array.prototype.set.call(arena,bytes,used);
    used+=n;
   }
   return !failed;
  },
  eof(stream){
   if(!sealed){
    if(stream==='stdout')outEof=true;
    else if(stream==='stderr')errEof=true;
    else fail('limited_stream');
   }
  },
  snapshot:()=>Object.freeze({
   stdout_bytes_observed:out,stderr_bytes_observed:err,
   stdout_eof:outEof,stderr_eof:errEof,
   io_drained:outEof&&errEof&&!failed
  }),
  diagnosticReport:()=>report,
  diagnosticCapture:()=>capture?Object.freeze({
   ...capture,
   response_bytes:capture.response_bytes===null?null:
    new Uint8Array(capture.response_bytes)
  }):null,
  decode(raw={}){
   clearCapture();report=null;
   let envelope=null;
   try{
    if(sealed||failed||!outEof||!errEof||!arena){
     reject('COLLECTION','COLLECTION_FAILED');
    }
    const metadata=decodeLargeProjectCodexJsonl({
     raw_payload_bytes:Uint8Array.prototype.subarray.call(arena,0,used),
     max_response_bytes:stdoutLimit,
     wrapper_exit_code:raw.exit_code??null,
     wrapper_signal:raw.exit_signal??null,
     wrapper_wall_ms:raw.process_wall_ms??null
    });
    if(metadata.parser_status==='PARSE_ERROR'){
     const reason=largeEnvelopeReasons.has(metadata.diagnostic_code)
      ?metadata.diagnostic_code:'ENVELOPE_PARSE_ERROR';
     reject('ENVELOPE',reason);
    }
    if(metadata.provider_reported_status!=='turn.completed'){
     reject(
      'PROVIDER_STATUS',
      metadata.provider_reported_status==='turn.failed'
       ?'TURN_FAILED':'PROVIDER_NON_SUCCESS',
      metadata
     );
    }

    let terminal=false,started=false,messages=0,response;
    loopActive=true;loopRejected=false;
    try{
     for(const event of iterateLargeProjectCodexJsonlFrames(
      Uint8Array.prototype.subarray.call(arena,0,used)
     )){
      if(terminal)reject('ENVELOPE','TRAILING_DATA_AFTER_TERMINAL');
      if(event.type==='turn.started'){
       if(started||messages)reject('ENVELOPE','ENVELOPE_PARSE_ERROR');
       started=true;
      }
      if(event.type==='error'){
       reject('PROVIDER_STATUS','PROVIDER_NON_SUCCESS',metadata);
      }
      if(event.type==='item.completed'&&event.item?.type==='agent_message'){
       if(!started)reject('ENVELOPE','ENVELOPE_PARSE_ERROR');
       if(++messages>1)reject('RESPONSE','AMBIGUOUS_AGENT_MESSAGE',metadata);
       response=event.item.text;
      }
      if(event.type==='turn.completed')terminal=true;
     }
     loopActive=false;
    }catch(caught){
     loopActive=false;
     if(loopRejected)throw caught;
      let field=null;
      try{
       if(caught&&typeof caught==='object'&&!types.isProxy(caught)){
        const d=Object.getOwnPropertyDescriptor(caught,'field');
        if(d&&Object.hasOwn(d,'value'))field=d.value;
       }
      }catch{}
      reject('ENVELOPE',largeEnvelopeReasons.has(field)
       ?field:'ENVELOPE_PARSE_ERROR');
     }
    if(!started)reject('ENVELOPE','ENVELOPE_PARSE_ERROR');
    if(messages!==1||typeof response!=='string'){
     reject('RESPONSE','RESPONSE_STRING_REQUIRED',metadata);
    }
    if(/[\u0000\uFEFF\uD800-\uDFFF]/u.test(response)){
     reject('PAYLOAD','PROJECT_ENCODING_REJECTED',metadata);
    }
    if(response.length>PROJECT_OUTPUT_LARGE_PROFILE.max_envelope_bytes){
     capturePayload('PROJECT_PAYLOAD_TOO_LARGE',null);
     reject('PAYLOAD','PROJECT_PAYLOAD_TOO_LARGE',metadata);
    }
    envelope=new TextEncoder().encode(response);
    let payload;
    try{payload=validateLargeProjectPayloadJson(envelope);}
    catch(error){
     let reason='PROJECT_SCHEMA_MISMATCH';
     try{
      if(error&&typeof error==='object'&&!types.isProxy(error)){
       const d=Object.getOwnPropertyDescriptor(error,'field');
       if(d&&Object.hasOwn(d,'value')&&payloadReasons.has(d.value)){
        reason=d.value;
       }
      }
     }catch{}
     if([
      'PROJECT_PAYLOAD_TOO_SMALL','PROJECT_MARKDOWN_REJECTED',
      'PROJECT_PAYLOAD_TOO_LARGE'
     ].includes(reason)){
      capturePayload(reason,envelope);
     }
     reject('PAYLOAD',reason,metadata);
    }
    accepted=payload;
    const result={bytes:envelope,metadata,payload};
    envelope=null;
    return result;
   }finally{
    envelope?.fill(0);
   }
  },
  close(){
   sealed=true;
   arena?.fill(0);arena=null;used=0;report=null;
   for(const file of accepted?.files??[])file.content.fill(0);
   accepted=null;clearCapture();
  }
 });
}
