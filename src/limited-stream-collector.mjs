import {diagnosticReport as makeReport,legacyDiagnostic} from './internal/limited-diagnostics.mjs';
import {AGY_BYTE_LIMITS, decodeAgyJson} from './agy-profile.mjs';
import {createHash} from 'node:crypto';
import {fail} from './job-spec.mjs';

const decode = (bytes, raw = {}) => decodeAgyJson({raw_payload_bytes: bytes,
  max_response_bytes: AGY_BYTE_LIMITS.max_stdout_bytes, wrapper_exit_code: raw.exit_code ?? null,
  wrapper_signal: raw.exit_signal ?? null, wrapper_wall_ms: raw.process_wall_ms ?? null});
const keys = ['summary', 'enforced_limits', 'known_limitations', 'containment_guarantee'];
// Reuse the public decoder's complete UTF8/duplicate-key/surrogate checks,
// without importing its unexported parser or treating provider status as content proof.
export function validateTaskPayloadJson(bytes) {
  if (!(bytes instanceof Uint8Array) || decode(bytes).parser_status === 'PARSE_ERROR') fail('limited_payload');
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === 'object') for (const key of Object.keys(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('limited_payload');
      pending.push(item[key]);
    }
  }
  if (!value || Array.isArray(value) || Object.keys(value).length !== 4 || keys.some(key => !Object.hasOwn(value, key)) ||
      typeof value.summary !== 'string' || typeof value.containment_guarantee !== 'string' ||
      ['enforced_limits', 'known_limitations'].some(key => !Array.isArray(value[key]) || value[key].some(v => typeof v !== 'string'))) fail('limited_payload');
  return Object.freeze({...value, enforced_limits: Object.freeze(value.enforced_limits), known_limitations: Object.freeze(value.known_limitations)});
}

export function createLimitedStreamCollector() {return collect(validateTaskPayloadJson);}
function collect(validatePayload) {
  let arena = new Uint8Array(AGY_BYTE_LIMITS.max_stdout_bytes), length = 0, out = 0, err = 0;
  let outEof = false, errEof = false, failed = false, sealed = false, report = null;
  return Object.freeze({
    chunk(stream, bytes) {
      if (sealed) return false;
      if (!['stdout', 'stderr'].includes(stream) || !(bytes instanceof Uint8Array)) fail('limited_chunk');
      const cap = stream === 'stdout' ? AGY_BYTE_LIMITS.max_stdout_bytes : AGY_BYTE_LIMITS.max_stderr_bytes;
      if (stream === 'stdout') out = Math.min(cap + 1, out + bytes.byteLength); else err = Math.min(cap + 1, err + bytes.byteLength);
      if ((stream === 'stdout' ? out : err) > cap) {failed = true; arena = null; return false;}
      if (stream === 'stdout' && arena) {arena.set(bytes, length); length += bytes.byteLength;}
      return !failed;
    },
    eof(stream) {if (!sealed) {if (stream === 'stdout') outEof = true; else if (stream === 'stderr') errEof = true; else fail('limited_stream');}},
    snapshot: () => Object.freeze({stdout_bytes_observed: out, stderr_bytes_observed: err,
      stdout_eof: outEof, stderr_eof: errEof, io_drained: outEof && errEof && !failed}),
    diagnosticReport: () => report,
    decode(raw) {
      report = null;
      try {
        if (sealed || failed || !outEof || !errEof || !arena) {report=makeReport('COLLECTION','COLLECTION_FAILED');fail('limited_collection');}
        const bytes = arena.slice(0, length), metadata = decode(bytes, raw);
        if (metadata.parser_status === 'PARSE_ERROR') {
          const known=['PAYLOAD_SIZE_EXCEEDED','MALFORMED_UTF8','MALFORMED_JSON','DUPLICATE_KEY_CONFLICT','INVALID_ROOT_SHAPE'];
          const reason=known.includes(metadata.diagnostic_code)?metadata.diagnostic_code:'ENVELOPE_PARSE_ERROR';
          report=makeReport('ENVELOPE',reason);fail(reason==='ENVELOPE_PARSE_ERROR'?'limited_envelope':reason);
        }
        if (metadata.provider_reported_status !== 'SUCCESS') {report=makeReport('PROVIDER_STATUS','PROVIDER_NON_SUCCESS',metadata);fail('PROVIDER_NON_SUCCESS');}
        const envelope = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        if (typeof envelope.response !== 'string') {report=makeReport('RESPONSE','RESPONSE_STRING_REQUIRED',metadata);fail('limited_response');}
        let payload;
        try {payload=validatePayload(new TextEncoder().encode(envelope.response), envelope.response);}
        catch(error) {const mapped=legacyDiagnostic(error);report=makeReport(mapped.stage,mapped.reason,metadata);throw error;}
        return {bytes, metadata, payload};
      } catch(error) {report ??= legacyDiagnostic(error);throw error;}
    },
    close() {sealed = true; arena = null; length = 0; report = null;}
  });
}

// Cooperative format checks only. This deliberately makes no syntax or safety claim.
export function validateGeneratedSourcePayload(response) {
  if (typeof response !== 'string') fail('CODEGEN_SOURCE_STRING_REQUIRED');
  if (response.includes('```')) fail('CODEGEN_MARKDOWN_REJECTED');
  if (/[\u0000\uFEFF]/u.test(response) || /[\uD800-\uDFFF]/u.test(response)) fail('CODEGEN_ENCODING_REJECTED');
  const source_bytes = new TextEncoder().encode(response);
  if (source_bytes.length < 100) fail('CODEGEN_PAYLOAD_TOO_SMALL');
  if (source_bytes.length > 65536) fail('CODEGEN_PAYLOAD_TOO_LARGE');
  return Object.freeze({source_code: response, source_bytes, source_sha256: createHash('sha256').update(source_bytes).digest('hex'),
    source_byte_count: source_bytes.length, format_status: 'FORMAT_VALID'});
}
export function createCodegenStreamCollector() {
  const base = collect((bytes, response) => validateGeneratedSourcePayload(response));
  return Object.freeze({...base, decode(raw) {
    const parsed = base.decode(raw);
    // Persistence receives source bytes, never an envelope or precomputed summary.
    parsed.bytes.fill(0);
    return {bytes: parsed.payload.source_bytes, metadata: parsed.metadata, payload: parsed.payload};
  }});
}
export function observeGeneratedSyntax(source, ports = {}) {
  const value = ports.validateSyntax ? ports.validateSyntax(source) : {syntax_status:'UNESTABLISHED_NO_NATIVE_PARSER', syntax_valid:null};
  const allowed = {UNESTABLISHED_NO_NATIVE_PARSER:null, SYNTAX_VALID:true, SYNTAX_ERROR:false};
  if (!value || !Object.hasOwn(allowed,value.syntax_status) || allowed[value.syntax_status] !== value.syntax_valid) fail('CODEGEN_SYNTAX_OBSERVATION');
  return Object.freeze({syntax_status:value.syntax_status,syntax_valid:value.syntax_valid});
}
