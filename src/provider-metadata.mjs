// Pure bounded metadata decoding only. No launcher, provider, clock or custody authority.
import {types} from 'node:util';
import {closed, ContractError, nonnegative, own} from './job-spec.mjs';
import {PROJECT_OUTPUT_LARGE_PROFILE} from './project-coding-profile.mjs';

const inputKeys = ['raw_payload_bytes', 'max_response_bytes', 'wrapper_exit_code',
  'wrapper_signal', 'wrapper_wall_ms'];
const signals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
  'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM',
  'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
  'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGSYS']);
const statuses = new Set(['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']);
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;

function boundary(input) {
  try {
    closed(input, inputKeys, [], 'DecoderInput');
    if (!Number.isSafeInteger(input.max_response_bytes) || input.max_response_bytes <= 0 ||
        types.isProxy(input.raw_payload_bytes) || !types.isUint8Array(input.raw_payload_bytes)) throw 0;
    if (input.wrapper_exit_code !== null && !Number.isSafeInteger(input.wrapper_exit_code)) throw 0;
    if (input.wrapper_signal !== null && !signals.has(input.wrapper_signal)) throw 0;
    if (input.wrapper_wall_ms !== null && !nonnegative(input.wrapper_wall_ms)) throw 0;
    const raw_wrapper = Object.freeze({exit_code: input.wrapper_exit_code,
      signal: input.wrapper_signal, wall_duration_ms: input.wrapper_wall_ms});
    // Length is checked before copying or decoding. Never invoke caller-defined properties.
    const size = byteLength.call(input.raw_payload_bytes);
    if (size > input.max_response_bytes) return {raw_wrapper, oversized: true};
    // Copy explicitly into a fresh intrinsic view; no species/user constructor callbacks.
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = input.raw_payload_bytes[i];
    return {raw_wrapper, bytes};
  } catch {
    throw new ContractError('INVALID_WRAPPER_OBSERVATION', 'DecoderInput');
  }
}

function output(wrapper, diagnostic, status = null, usage = null, duration = null, reasoning = null, structural = false) {
  return Object.freeze({
    parser_status: structural ? 'PARSE_ERROR' : diagnostic === 'PARSE_OK' ? 'OK' : 'OK_WITH_FIELD_DIAGNOSTIC',
    diagnostic_code: diagnostic, provider_reported_status: status, raw_wrapper: wrapper,
    duration_seconds: duration, usage: usage === null ? null : Object.freeze(usage),
    extra_metadata: Object.freeze({codex_reasoning_output_tokens: reasoning, backend_model: 'UNKNOWN'}),
    task_outcome_evaluated: false
  });
}

// JSON.parse establishes grammar first. This iterative lexical pass then checks every
// object's decoded keys, including objects in ignored fields, without recursive descent.
function parseObject(text) {
  let value;
  try { value = JSON.parse(text); } catch { return {error: 'MALFORMED_JSON'}; }
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key)) return {error: 'DUPLICATE_KEY_CONFLICT'};
        frame.keys.add(key); frame.expectKey = false;
      }
    } else if (char === '{') stack.push({keys: new Set(), expectKey: true});
    else if (char === '[') stack.push({});
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {error: 'INVALID_ROOT_SHAPE'};
  return {value};
}

function decode(input, codex) {
  const captured = boundary(input);
  const error = code => output(captured.raw_wrapper, code, null, null, null, null, true);
  if (captured.oversized) return error('PAYLOAD_SIZE_EXCEEDED');
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(captured.bytes); }
  catch { return error('MALFORMED_UTF8'); }
  let envelope, status;
  if (codex) {
    const terminals = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseObject(line);
      if (parsed.error) return error(parsed.error);
      if (own(parsed.value, 'type') && (parsed.value.type === 'turn.completed' || parsed.value.type === 'turn.failed')) terminals.push(parsed.value);
    }
    if (!terminals.length) return error('MISSING_TERMINAL');
    if (terminals.length > 1) return error(new Set(terminals.map(item => item.type)).size > 1 ?
      'CONFLICTING_TERMINAL_EVENTS' : 'REPEATED_TERMINAL_REJECTED');
    envelope = terminals[0]; status = envelope.type;
  } else {
    const parsed = parseObject(text);
    if (parsed.error) return error(parsed.error);
    envelope = parsed.value; status = own(envelope, 'status') && statuses.has(envelope.status) ? envelope.status : null;
  }
  let invalid = false;
  const usage = {input: null, output: null, cache_read: null, thinking: null, total: null};
  let source = null;
  if ((!codex || status === 'turn.completed') && own(envelope, 'usage')) {
    if (envelope.usage && typeof envelope.usage === 'object' && !Array.isArray(envelope.usage)) source = envelope.usage;
    else invalid = true;
  }
  const counter = key => {
    if (!source || !own(source, key)) return null;
    if (!nonnegative(source[key])) { invalid = true; return null; }
    return source[key];
  };
  usage.input = counter('input_tokens'); usage.output = counter('output_tokens');
  usage.cache_read = counter(codex ? 'cached_input_tokens' : 'cache_read_tokens');
  let reasoning = null, duration = null;
  if (codex) reasoning = counter('reasoning_output_tokens');
  else {
    usage.thinking = counter('thinking_tokens'); usage.total = counter('total_tokens');
    if (own(envelope, 'duration_seconds')) {
      if (typeof envelope.duration_seconds === 'number' && Number.isFinite(envelope.duration_seconds) && envelope.duration_seconds >= 0)
        duration = envelope.duration_seconds;
      else invalid = true;
    }
  }
  // The accepted closed diagnostic vocabulary uses the numeric-field diagnostic
  // for duration too. Unknown status takes precedence without discarding counters.
  const diagnostic = status === null ? 'UNRECOGNIZED_STATUS' : invalid ? 'INVALID_USAGE_COUNTER' : 'PARSE_OK';
  return output(captured.raw_wrapper, diagnostic, status, usage, duration, reasoning);
}

export const decodeAgyJson = input => decode(input, false);
export const decodeCodexJsonl = input => decode(input, true);

const largeCounterNames=Object.freeze({
  input_tokens:'input_tokens',
  output_tokens:'output_tokens',
  cached_input_tokens:'cached_input_tokens',
  reasoning_output_tokens:'reasoning_output_tokens'
});
const largeFrameFacts=new WeakMap();
const largeDecoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const largeStructuralErrors=new Set([
  'PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON',
  'DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE','ENVELOPE_PARSE_ERROR'
]);
const largeFail=field=>{throw new ContractError('invalid_contract',field);};

function scanLargeProjectFrame(text){
  const budget={nodes:0,keys:0};
  let i=0;
  const counterLexemes=Object.create(null);
  const whitespace=()=>{while(text[i]===' '||text[i]==='\t'||text[i]==='\r'||text[i]==='\n')i++;};
  function string(decode){
    if(text[i]!=='"')largeFail('MALFORMED_JSON');
    const start=i++;
    while(i<text.length){
      const code=text.charCodeAt(i++);
      if(code===34){
        if(!decode)return null;
        try{return JSON.parse(text.slice(start,i));}
        catch{largeFail('MALFORMED_JSON');}
      }
      if(code<0x20)largeFail('MALFORMED_JSON');
      if(code===92){
        if(i>=text.length)largeFail('MALFORMED_JSON');
        const escaped=text[i++];
        if(escaped==='u'){
          for(let n=0;n<4;n++){
            const digit=text[i++];
            if(!digit||!/^[0-9a-f]$/i.test(digit))largeFail('MALFORMED_JSON');
          }
        }else if(!'"\\/bfnrt'.includes(escaped)){
          largeFail('MALFORMED_JSON');
        }
      }
    }
    largeFail('MALFORMED_JSON');
  }
  function number(counterKey){
    const negative=text[i]==='-';
    if(negative)i++;
    let safeInteger=true,value=0;
    const digit=c=>c>='0'&&c<='9';
    if(text[i]==='0'){
      i++;
      if(digit(text[i]))largeFail('MALFORMED_JSON');
    }else if(text[i]>='1'&&text[i]<='9'){
      while(digit(text[i])){
        const d=text.charCodeAt(i++)-48;
        if(value>Math.floor((Number.MAX_SAFE_INTEGER-d)/10))safeInteger=false;
        else value=value*10+d;
      }
    }else{
      largeFail('MALFORMED_JSON');
    }
    let integerOnly=true;
    if(text[i]==='.'){
      integerOnly=false;i++;
      if(!digit(text[i]))largeFail('MALFORMED_JSON');
      while(digit(text[i]))i++;
    }
    if(text[i]==='e'||text[i]==='E'){
      integerOnly=false;i++;
      if(text[i]==='+'||text[i]==='-')i++;
      if(!digit(text[i]))largeFail('MALFORMED_JSON');
      while(digit(text[i]))i++;
    }
    if(counterKey!==null){
      counterLexemes[counterKey]=!negative&&integerOnly&&safeInteger;
    }
  }
  function value(depth,{root=false,usageObject=false,counterKey=null}={}){
    if(depth>PROJECT_OUTPUT_LARGE_PROFILE.max_event_depth){
      largeFail('ENVELOPE_PARSE_ERROR');
    }
    if(++budget.nodes>PROJECT_OUTPUT_LARGE_PROFILE.max_event_nodes){
      largeFail('ENVELOPE_PARSE_ERROR');
    }
    whitespace();
    const c=text[i];
    if(c==='"'){string(false);return;}
    if(c==='{'){
      i++;whitespace();
      const seen=new Set();
      if(text[i]==='}'){i++;return;}
      while(i<text.length){
        if(++budget.keys>PROJECT_OUTPUT_LARGE_PROFILE.max_event_nodes){
          largeFail('ENVELOPE_PARSE_ERROR');
        }
        const key=string(true);
        if(seen.has(key))largeFail('DUPLICATE_KEY_CONFLICT');
        seen.add(key);whitespace();
        if(text[i++]!==':')largeFail('MALFORMED_JSON');
        whitespace();
        const tracked=usageObject?largeCounterNames[key]??null:null;
        value(depth+1,{
          usageObject:root&&key==='usage',
          counterKey:tracked
        });
        whitespace();
        const delimiter=text[i++];
        if(delimiter==='}')return;
        if(delimiter!==',')largeFail('MALFORMED_JSON');
        whitespace();
      }
      largeFail('MALFORMED_JSON');
    }
    if(c==='['){
      i++;whitespace();
      if(text[i]===']'){i++;return;}
      while(i<text.length){
        value(depth+1);
        whitespace();
        const delimiter=text[i++];
        if(delimiter===']')return;
        if(delimiter!==',')largeFail('MALFORMED_JSON');
        whitespace();
      }
      largeFail('MALFORMED_JSON');
    }
    if(c==='-'||c>='0'&&c<='9'){number(counterKey);return;}
    for(const literal of ['true','false','null']){
      if(text.startsWith(literal,i)){i+=literal.length;return;}
    }
    largeFail('MALFORMED_JSON');
  }

  whitespace();
  if(text[i]!=='{')largeFail('INVALID_ROOT_SHAPE');
  value(0,{root:true});
  whitespace();
  if(i!==text.length)largeFail('MALFORMED_JSON');
  return counterLexemes;
}

function parseLargeProjectFrame(bytes,start,end,budget){
  let blank=true;
  for(let i=start;i<end;i++){
    const byte=bytes[i];
    if(byte!==0x20&&byte!==0x09&&byte!==0x0d){blank=false;break;}
  }
  if(blank)return null;
  if(++budget.frames>PROJECT_OUTPUT_LARGE_PROFILE.max_jsonl_frames){
    largeFail('ENVELOPE_PARSE_ERROR');
  }
  let text;
  try{
    text=largeDecoder.decode(Uint8Array.prototype.subarray.call(bytes,start,end));
  }catch{
    largeFail('MALFORMED_UTF8');
  }
  const counterLexemes=scanLargeProjectFrame(text);
  let event;
  try{event=JSON.parse(text);}
  catch{largeFail('MALFORMED_JSON');}
  if(!event||typeof event!=='object'||Array.isArray(event)){
    largeFail('INVALID_ROOT_SHAPE');
  }
  largeFrameFacts.set(event,counterLexemes);
  return event;
}

// Private bounded intake helper. Each yielded frame is parsed only after its
// grammar, decoded keys, depth and per-frame node budgets have been checked.
export function* iterateLargeProjectCodexJsonlFrames(transport){
  if(types.isProxy(transport)||!types.isUint8Array(transport)){
    throw new ContractError('INVALID_WRAPPER_OBSERVATION','DecoderInput');
  }
  let size;
  try{size=byteLength.call(transport);}
  catch{throw new ContractError('INVALID_WRAPPER_OBSERVATION','DecoderInput');}
  if(size>PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes){
    largeFail('PAYLOAD_SIZE_EXCEEDED');
  }
  const bytes=new Uint8Array(size);
  try{
    for(let i=0;i<size;i++)bytes[i]=transport[i];
    const budget={frames:0,nodes:0,keys:0};
    let start=0;
    for(let i=0;i<size;i++){
      if(bytes[i]!==0x0a)continue;
      const event=parseLargeProjectFrame(bytes,start,i,budget);
      start=i+1;
      if(event!==null)yield event;
    }
    if(start<size){
      const event=parseLargeProjectFrame(bytes,start,size,budget);
      if(event!==null)yield event;
    }
  }finally{
    bytes.fill(0);
  }
}

function largeBoundary(input){
  try{
    closed(input,inputKeys,[],'DecoderInput');
    if(input.max_response_bytes!==PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes||
       types.isProxy(input.raw_payload_bytes)||!types.isUint8Array(input.raw_payload_bytes)){
      throw 0;
    }
    if(input.wrapper_exit_code!==null&&!Number.isSafeInteger(input.wrapper_exit_code))throw 0;
    if(input.wrapper_signal!==null&&!signals.has(input.wrapper_signal))throw 0;
    if(input.wrapper_wall_ms!==null&&!nonnegative(input.wrapper_wall_ms))throw 0;
    const raw_wrapper=Object.freeze({
      exit_code:input.wrapper_exit_code,
      signal:input.wrapper_signal,
      wall_duration_ms:input.wrapper_wall_ms
    });
    const size=byteLength.call(input.raw_payload_bytes);
    return {
      raw_wrapper,
      oversized:size>PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes,
      bytes:input.raw_payload_bytes
    };
  }catch{
    throw new ContractError('INVALID_WRAPPER_OBSERVATION','DecoderInput');
  }
}

function largeErrorField(error){
  try{
    if(!error||typeof error!=='object'||types.isProxy(error))return null;
    const descriptor=Object.getOwnPropertyDescriptor(error,'field');
    return descriptor&&Object.hasOwn(descriptor,'value')&&
      largeStructuralErrors.has(descriptor.value)?descriptor.value:null;
  }catch{return null;}
}

function largeTerminalFacts(event,status){
  const usage={input:null,output:null,cache_read:null,thinking:null,total:null};
  const empty={usage,reasoning:null,invalid:false};
  if(status!=='turn.completed'||!own(event,'usage'))return empty;
  const source=event.usage;
  if(!source||typeof source!=='object'||Array.isArray(source)){
    return {...empty,invalid:true};
  }
  const lexical=largeFrameFacts.get(event)??Object.create(null);
  let invalid=false;
  const counter=key=>{
    if(!own(source,key))return null;
    const value=source[key];
    if(typeof value==='number'&&Object.hasOwn(lexical,key)&&lexical[key]!==true){
      invalid=true;return null;
    }
    if(!nonnegative(value)){invalid=true;return null;}
    return value;
  };
  usage.input=counter('input_tokens');
  usage.output=counter('output_tokens');
  usage.cache_read=counter('cached_input_tokens');
  const reasoning=counter('reasoning_output_tokens');
  return {usage,reasoning,invalid};
}

export function decodeLargeProjectCodexJsonl(input){
  const captured=largeBoundary(input);
  const failureMetadata=code=>output(captured.raw_wrapper,code,null,null,null,null,true);
  if(captured.oversized)return failureMetadata('PAYLOAD_SIZE_EXCEEDED');
  let terminalCount=0,status=null,facts=null;
  try{
    for(const event of iterateLargeProjectCodexJsonlFrames(captured.bytes)){
      if(!own(event,'type')||
         !['turn.completed','turn.failed'].includes(event.type))continue;
      terminalCount++;
      if(terminalCount===1){
        status=event.type;
        facts=largeTerminalFacts(event,status);
      }else if(terminalCount===2){
        // Keep only the fixed status label needed to distinguish the two
        // structural terminal errors; no event list is retained.
        const firstStatus=status;
        const current=event.type;
        if(firstStatus!==current)return failureMetadata('CONFLICTING_TERMINAL_EVENTS');
      }else{
        return failureMetadata('REPEATED_TERMINAL_REJECTED');
      }
    }
  }catch(caught){
    return failureMetadata(largeErrorField(caught)??'ENVELOPE_PARSE_ERROR');
  }
  if(!terminalCount)return failureMetadata('MISSING_TERMINAL');
  if(terminalCount>1)return failureMetadata('REPEATED_TERMINAL_REJECTED');
  return output(
    captured.raw_wrapper,
    facts.invalid?'INVALID_USAGE_COUNTER':'PARSE_OK',
    status,
    facts.usage,
    null,
    facts.reasoning
  );
}
