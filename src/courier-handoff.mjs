// Bounded metadata preparation and assessment only. This module never launches work.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {parseReceiptJson, REPORT_MAX_BYTES, snapshotReceiptData} from './offline-run-summary.mjs';

const REQUEST_SCHEMA = 'squire3.courier_handoff_request.v1';
const SAFE_REQUEST_SCHEMA = 'squire3.courier_handoff_safe_request.v1';
const PREPARED_SCHEMA = 'squire3.courier_handoff_prepared.v1';
const OBSERVATIONS_SCHEMA = 'squire3.courier_handoff_observations.v1';
const ASSESSMENT_SCHEMA = 'squire3.courier_handoff_assessment.v1';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_GROUPS = 16;
const MAX_GROUP_ITEMS = 64;
const MAX_READ_ITEMS = MAX_GROUPS * MAX_GROUP_ITEMS;
const MAX_REFERENCE_BYTES = REPORT_MAX_BYTES;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_BINDING_BYTES = 4 * REPORT_MAX_BYTES;
const MAX_ARGV_ITEMS = 64;
const MAX_ARG_BYTES = 256;
const MAX_ARGV_BYTES = 512;
const MAX_COMMAND_BYTES = 4039;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;
const MAX_ENV_REMOVALS = 1024;

const enums = Object.freeze({
  model: Object.freeze(['gpt-6-luna', 'gpt-6.1-sol', 'UNKNOWN']),
  effort: Object.freeze(['low', 'medium', 'high', 'xhigh', 'UNKNOWN']),
  dispatch: Object.freeze(['NOT_ATTEMPTED', 'UNKNOWN', 'ADMITTED']),
  processStart: Object.freeze(['NOT_OBSERVED', 'OBSERVED', 'UNKNOWN']),
  terminal: Object.freeze(['NOT_OBSERVED', 'EXIT_CODE', 'SIGNAL', 'UNKNOWN']),
  terminalSignal: Object.freeze(['NONE', 'OBSERVED', 'UNKNOWN']),
  capture: Object.freeze(['COMPLETE', 'TRUNCATED', 'MISSING', 'EMPTY', 'UNKNOWN']),
  finalCapture: Object.freeze(['COMPLETE', 'TRUNCATED', 'MISSING', 'EMPTY', 'NO_CANDIDATE', 'UNKNOWN']),
  transform: Object.freeze(['IDENTITY', 'FINAL_TEXT_V1', 'NORMALIZED_FINAL_V1', 'OTHER']),
  coverage: Object.freeze([
    'WHOLE_BYTE_EXACT', 'BOUNDED_EXCERPT', 'COMPLETE_JSON_VALUE_EQUALITY',
    'MISSING', 'UNKNOWN'
  ]),
  recoveryReference: Object.freeze(['PRESENT', 'ABSENT', 'UNKNOWN']),
  recoveryContext: Object.freeze([
    'CURRENT_CONTEXT_REPORTED', 'HISTORICAL_PANE_OR_PID_ONLY', 'UNKNOWN', 'NOT_SUPPLIED'
  ]),
  reviewMode: Object.freeze(['FRESH_REVIEW', 'CONTINUATION', 'NOT_A_REVIEW']),
  priorOutcome: Object.freeze(['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE']),
  binaryEvidence: Object.freeze(['OBSERVED', 'NOT_OBSERVED', 'UNKNOWN']),
  factState: Object.freeze(['COMPLETE', 'INCOMPLETE', 'UNKNOWN']),
  transport: Object.freeze(['CERTAIN', 'UNCERTAIN', 'UNKNOWN']),
  tool: Object.freeze(['NOT_RUN', 'SUCCESS', 'FAILURE', 'CAPABILITY_ERROR', 'UNKNOWN']),
  estimate: Object.freeze(['KNOWN', 'UNKNOWN']),
  settlement: Object.freeze([
    'OBSERVED_FULL', 'DIRECT_CHILD_ONLY', 'INCOMPLETE', 'NOT_OBSERVED', 'UNKNOWN'
  ]),
  environment: Object.freeze(['OBSERVED', 'NOT_OBSERVED', 'UNKNOWN'])
});

export const COURIER_HANDOFF_ENUMS = enums;
export const COURIER_HANDOFF_LIMITS = Object.freeze({
  input_bytes: REPORT_MAX_BYTES,
  max_groups: MAX_GROUPS,
  max_items_per_group: MAX_GROUP_ITEMS,
  max_read_items: MAX_READ_ITEMS,
  max_reference_bytes: MAX_REFERENCE_BYTES,
  max_read_bytes: MAX_READ_BYTES,
  max_binding_bytes: MAX_BINDING_BYTES,
  max_argv_items: MAX_ARGV_ITEMS,
  max_arg_bytes: MAX_ARG_BYTES,
  max_argv_bytes: MAX_ARGV_BYTES,
  max_command_bytes: MAX_COMMAND_BYTES,
  max_stdout_bytes: MAX_STDOUT_BYTES,
  max_stderr_bytes: MAX_STDERR_BYTES,
  max_environment_removals: MAX_ENV_REMOVALS
});

export class CourierHandoffError extends Error {
  constructor() {
    super('INVALID_INPUT');
    this.name = 'CourierHandoffError';
    this.code = 'INVALID_INPUT';
  }
}

const invalid = () => { throw new CourierHandoffError(); };
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isSafeInteger = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;

function wellFormed(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function text(value, maxBytes, {empty = false, nul = false} = {}) {
  if (typeof value !== 'string' || !wellFormed(value) ||
      (!empty && value.length === 0) || (!nul && value.includes('\0')) ||
      new TextEncoder().encode(value).length > maxBytes) invalid();
  return value;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid();
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') invalid();
  const keys = Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value) {
  const encoded = new TextEncoder().encode(canonical(value));
  if (encoded.length > REPORT_MAX_BYTES) invalid();
  return createHash('sha256').update(encoded).digest('hex');
}

function captureInput(value) {
  try {
    if (types.isProxy(value)) invalid();
    if (types.isUint8Array(value)) return parseReceiptJson(value);
    return snapshotReceiptData(value);
  } catch {
    invalid();
  }
}

function captureObject(value) {
  try {
    if (types.isProxy(value)) invalid();
    return snapshotReceiptData(value);
  } catch {
    invalid();
  }
}

function closed(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) ||
      keys.some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function safeEnum(value, values) {
  if (!values.includes(value)) invalid();
  return value;
}

function validateDigest(value) {
  if (!isDigest(value)) invalid();
  return value;
}

function validateReference(value) {
  closed(value, ['reference_id', 'sha256', 'byte_count']);
  text(value.reference_id, 1024);
  validateDigest(value.sha256);
  if (!isSafeInteger(value.byte_count, MAX_REFERENCE_BYTES)) invalid();
  return {
    reference_id: value.reference_id,
    sha256: value.sha256,
    byte_count: value.byte_count
  };
}

function referenceDigest(value) {
  return digest(value);
}

function safeReference(value) {
  return {
    reference_digest: referenceDigest(value),
    sha256: value.sha256,
    byte_count: value.byte_count
  };
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

function validateAbsolutePath(value, {rootAllowed = true} = {}) {
  text(value, MAX_ARG_BYTES);
  if (!value.startsWith('/') || value.startsWith('//') ||
      (value === '/' && !rootAllowed) ||
      /(?:<[^>\r\n]+>|\{\{[^}\r\n]+\}\}|\$\{[^}\r\n]+\})/.test(value) ||
      /^(?:TODO|TBD|PLACEHOLDER|REPLACE_ME|\.\.\.)$/i.test(value)) invalid();
  if (value !== '/') {
    const parts = value.slice(1).split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) invalid();
  }
  return value;
}

function validateLiteralArgument(value, {empty = true} = {}) {
  text(value, MAX_ARG_BYTES, {empty});
  if (/(?:<[^>\r\n]+>|\{\{[^}\r\n]+\}\}|\$\{[^}\r\n]+\})/.test(value) ||
      /^(?:TODO|TBD|PLACEHOLDER|REPLACE_ME|\.\.\.)$/i.test(value)) invalid();
  return value;
}

function validateArgumentVector(value, {emptyVector = false} = {}) {
  if (!Array.isArray(value) || value.length > MAX_ARGV_ITEMS ||
      (!emptyVector && value.length === 0)) invalid();
  let total = 0;
  for (const argument of value) {
    validateLiteralArgument(argument);
    total += new TextEncoder().encode(argument).length;
  }
  if (total > MAX_ARGV_BYTES) invalid();
  return [...value];
}

function quotePosix(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function validateRequestedIdentity(value) {
  closed(value, ['model', 'effort']);
  return {
    model: safeEnum(value.model, enums.model),
    effort: safeEnum(value.effort, enums.effort)
  };
}

function validateReadGroups(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GROUPS) invalid();
  const byId = new Map();
  let itemCount = 0;
  for (const group of value) {
    if (!Array.isArray(group) || group.length < 1 || group.length > MAX_GROUP_ITEMS) invalid();
    itemCount += group.length;
    if (itemCount > MAX_READ_ITEMS) invalid();
    for (const candidate of group) {
      const ref = validateReference(candidate);
      const identity = canonical(ref);
      const prior = byId.get(ref.reference_id);
      if (prior !== undefined && prior !== identity) invalid();
      byId.set(ref.reference_id, identity);
    }
  }
  const refs = [...byId.keys()].map(id => {
    const saved = JSON.parse(byId.get(id));
    return saved;
  }).sort((a, b) => a.reference_id < b.reference_id ? -1 :
    a.reference_id > b.reference_id ? 1 : 0);
  const totalBytes = refs.reduce((sum, ref) => sum + ref.byte_count, 0);
  if (refs.length < 1 || refs.length > MAX_READ_ITEMS || totalBytes > MAX_READ_BYTES) invalid();
  return refs;
}

function chunks(values) {
  const result = [];
  for (let i = 0; i < values.length; i += MAX_GROUP_ITEMS) {
    result.push(values.slice(i, i + MAX_GROUP_ITEMS));
  }
  return result;
}

function safeReadGroups(refs) {
  return chunks(refs.map(safeReference));
}

function prepareRequest(value) {
  const request = captureInput(value);
  closed(request, [
    'schema_version', 'executable', 'cwd', 'outer_argv', 'inner_node_argv',
    'requested_identity', 'bindings', 'required_read_groups', 'recovery_reference'
  ]);
  if (request.schema_version !== REQUEST_SCHEMA) invalid();

  const executable = validateAbsolutePath(request.executable, {rootAllowed: false});
  const cwd = validateAbsolutePath(request.cwd);
  const outerArgv = validateArgumentVector(request.outer_argv);
  if (outerArgv[0] !== executable) invalid();
  const innerArgv = request.inner_node_argv === null
    ? null : validateArgumentVector(request.inner_node_argv, {emptyVector: true});
  const requestedIdentity = validateRequestedIdentity(request.requested_identity);

  closed(request.bindings, ['wrapper', 'instruction', 'manifest']);
  const bindings = {
    wrapper: validateReference(request.bindings.wrapper),
    instruction: validateReference(request.bindings.instruction),
    manifest: validateReference(request.bindings.manifest)
  };
  let bindingBytes = Object.values(bindings).reduce((sum, ref) => sum + ref.byte_count, 0);
  const recoveryReference = request.recovery_reference === null
    ? null : validateReference(request.recovery_reference);
  if (recoveryReference) bindingBytes += recoveryReference.byte_count;
  if (bindingBytes > MAX_BINDING_BYTES) invalid();

  const reads = validateReadGroups(request.required_read_groups);
  const publicBindings = Object.fromEntries(
    Object.entries(bindings).map(([name, ref]) => [name, safeReference(ref)])
  );
  const publicReads = reads.map(safeReference);
  const recoveryDigest = recoveryReference ? referenceDigest(recoveryReference) : null;
  const referenceDigestValue = digest({
    bindings: publicBindings,
    recovery_reference_digest: recoveryDigest,
    required_reads: publicReads
  });
  const requestDigest = digest({
    schema_version: REQUEST_SCHEMA,
    executable,
    cwd,
    outer_argv: outerArgv,
    inner_node_argv: innerArgv,
    requested_identity: requestedIdentity,
    bindings,
    required_reads: reads,
    recovery_reference: recoveryReference
  });

  const command = `(cd ${quotePosix(cwd)} && exec ${outerArgv.map(quotePosix).join(' ')})`;
  if (new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) invalid();

  const safeSummary = {
    schema_version: SAFE_REQUEST_SCHEMA,
    request_digest: requestDigest,
    reference_digest: referenceDigestValue,
    requested_identity: requestedIdentity,
    bindings: publicBindings,
    recovery_reference_digest: recoveryDigest,
    required_read_groups: chunks(publicReads)
  };
  return freezeDeep({
    schema_version: PREPARED_SCHEMA,
    safe_summary: safeSummary,
    private_command: command
  });
}

export function prepareCourierHandoff(request) {
  try {
    return prepareRequest(request);
  } catch {
    invalid();
  }
}

function validateSafeReference(value) {
  closed(value, ['reference_digest', 'sha256', 'byte_count']);
  validateDigest(value.reference_digest);
  validateDigest(value.sha256);
  if (!isSafeInteger(value.byte_count, MAX_REFERENCE_BYTES)) invalid();
  return {
    reference_digest: value.reference_digest,
    sha256: value.sha256,
    byte_count: value.byte_count
  };
}

function validateSafeGroups(value, {allowEmpty = false} = {}) {
  if (!Array.isArray(value) || value.length > MAX_GROUPS ||
      (!allowEmpty && value.length === 0)) invalid();
  const refs = [];
  const seen = new Set();
  for (const group of value) {
    if (!Array.isArray(group) || group.length < 1 || group.length > MAX_GROUP_ITEMS) invalid();
    for (const item of group) {
      const ref = validateSafeReference(item);
      if (seen.has(ref.reference_digest)) invalid();
      seen.add(ref.reference_digest);
      refs.push(ref);
      if (refs.length > MAX_READ_ITEMS) invalid();
    }
  }
  if (!allowEmpty && refs.length === 0) invalid();
  if (refs.reduce((sum, ref) => sum + ref.byte_count, 0) > MAX_READ_BYTES) invalid();
  return refs;
}

function validatePrepared(value) {
  const prepared = captureObject(value);
  closed(prepared, ['schema_version', 'safe_summary', 'private_command']);
  if (prepared.schema_version !== PREPARED_SCHEMA) invalid();
  text(prepared.private_command, MAX_COMMAND_BYTES);
  const safe = prepared.safe_summary;
  closed(safe, [
    'schema_version', 'request_digest', 'reference_digest', 'requested_identity',
    'bindings', 'recovery_reference_digest', 'required_read_groups'
  ]);
  if (safe.schema_version !== SAFE_REQUEST_SCHEMA) invalid();
  validateDigest(safe.request_digest);
  validateDigest(safe.reference_digest);
  const requestedIdentity = validateRequestedIdentity(safe.requested_identity);
  closed(safe.bindings, ['wrapper', 'instruction', 'manifest']);
  const bindings = {
    wrapper: validateSafeReference(safe.bindings.wrapper),
    instruction: validateSafeReference(safe.bindings.instruction),
    manifest: validateSafeReference(safe.bindings.manifest)
  };
  let bindingBytes = Object.values(bindings).reduce((sum, ref) => sum + ref.byte_count, 0);
  if (safe.recovery_reference_digest !== null) {
    validateDigest(safe.recovery_reference_digest);
  }
  if (safe.recovery_reference_digest !== null) bindingBytes += 1;
  if (bindingBytes > MAX_BINDING_BYTES) invalid();
  const reads = validateSafeGroups(safe.required_read_groups);
  const recomputed = digest({
    bindings,
    recovery_reference_digest: safe.recovery_reference_digest,
    required_reads: reads
  });
  if (recomputed !== safe.reference_digest) invalid();
  return {
    request_digest: safe.request_digest,
    reference_digest: safe.reference_digest,
    requested_identity: requestedIdentity,
    bindings,
    recovery_reference_digest: safe.recovery_reference_digest,
    required_reads: reads
  };
}

function validateTerminal(value) {
  closed(value, ['state', 'exit_code', 'signal_state']);
  const state = safeEnum(value.state, enums.terminal);
  const signalState = safeEnum(value.signal_state, enums.terminalSignal);
  const exitCode = value.exit_code;
  if (state === 'EXIT_CODE') {
    if (!isSafeInteger(exitCode, 255) || signalState !== 'NONE') invalid();
  } else if (state === 'SIGNAL') {
    if (exitCode !== null || signalState !== 'OBSERVED') invalid();
  } else if (state === 'NOT_OBSERVED') {
    if (exitCode !== null || signalState !== 'NONE') invalid();
  } else if (exitCode !== null || signalState !== 'UNKNOWN') {
    invalid();
  }
  return {state, exit_code: exitCode, signal_state: signalState};
}

function validateStream(value, maxBytes) {
  closed(value, ['state', 'sha256', 'byte_count']);
  const state = safeEnum(value.state, enums.capture);
  const sha256 = value.sha256;
  const byteCount = value.byte_count;
  if (state === 'COMPLETE') {
    validateDigest(sha256);
    if (!isSafeInteger(byteCount, maxBytes) || byteCount === 0) invalid();
  } else if (state === 'TRUNCATED') {
    validateDigest(sha256);
    if (!isSafeInteger(byteCount, maxBytes) ||
        byteCount === 0 && sha256 !== EMPTY_SHA256) invalid();
  } else if (state === 'EMPTY') {
    if (sha256 !== EMPTY_SHA256 || byteCount !== 0) invalid();
  } else if (sha256 !== null || byteCount !== null) {
    invalid();
  }
  return {state, sha256, byte_count: byteCount};
}

function validateFinal(value, rawCapture) {
  closed(value, [
    'state', 'sha256', 'byte_count', 'origin_stream', 'origin_sha256',
    'transform_reference', 'transform_kind'
  ]);
  const state = safeEnum(value.state, enums.finalCapture);
  const originStream = value.origin_stream;
  const transformKind = value.transform_kind;
  if (['COMPLETE', 'TRUNCATED', 'EMPTY', 'NO_CANDIDATE'].includes(state)) {
    if (!['STDOUT', 'STDERR'].includes(originStream)) invalid();
    validateDigest(value.origin_sha256);
    const raw = rawCapture[originStream.toLowerCase()];
    if (raw.sha256 !== value.origin_sha256) invalid();
    const transform = validateReference(value.transform_reference);
    safeEnum(transformKind, enums.transform);
    if (transformKind === 'IDENTITY' &&
        (value.sha256 !== raw.sha256 || value.byte_count !== raw.byte_count)) invalid();
    if (state === 'COMPLETE') {
      validateDigest(value.sha256);
      if (!isSafeInteger(value.byte_count, REPORT_MAX_BYTES) || value.byte_count === 0) invalid();
    } else if (state === 'TRUNCATED') {
      validateDigest(value.sha256);
      if (!isSafeInteger(value.byte_count, REPORT_MAX_BYTES) ||
          value.byte_count === 0 && value.sha256 !== EMPTY_SHA256) invalid();
    } else if (state === 'EMPTY') {
      if (value.sha256 !== EMPTY_SHA256 || value.byte_count !== 0) invalid();
    } else if (value.sha256 !== null || value.byte_count !== null) {
      invalid();
    }
    return {
      state,
      sha256: value.sha256,
      byte_count: value.byte_count,
      origin_stream: originStream,
      origin_sha256: value.origin_sha256,
      transform_reference_digest: referenceDigest(transform),
      transform_kind: transformKind
    };
  }
  if (state === 'MISSING') {
    if (value.sha256 !== null || value.byte_count !== null || originStream !== 'NONE' ||
        value.origin_sha256 !== null || value.transform_reference !== null ||
        transformKind !== 'NONE') invalid();
  } else if (value.sha256 !== null || value.byte_count !== null || originStream !== 'NONE' ||
      value.origin_sha256 !== null || value.transform_reference !== null ||
      transformKind !== 'UNKNOWN') {
    invalid();
  }
  return {
    state,
    sha256: null,
    byte_count: null,
    origin_stream: 'NONE',
    origin_sha256: null,
    transform_reference_digest: null,
    transform_kind: transformKind
  };
}

function validateEnvironment(value) {
  closed(value, ['outer_state', 'outer_count', 'wrapper_state', 'wrapper_count']);
  const outerState = safeEnum(value.outer_state, enums.environment);
  const wrapperState = safeEnum(value.wrapper_state, enums.environment);
  const check = (state, count) => {
    if (state === 'OBSERVED') {
      if (!isSafeInteger(count, MAX_ENV_REMOVALS)) invalid();
    } else if (count !== null) invalid();
  };
  check(outerState, value.outer_count);
  check(wrapperState, value.wrapper_count);
  return {
    outer_state: outerState,
    outer_count: value.outer_count,
    wrapper_state: wrapperState,
    wrapper_count: value.wrapper_count,
    complete_environment_attestation: 'NOT_ESTABLISHED'
  };
}

function validateReview(value) {
  closed(value, [
    'mode', 'original_review_reference', 'original_context_reference',
    'original_candidate_reference', 'current_context_reference',
    'current_candidate_reference', 'prior_outcome'
  ]);
  const mode = safeEnum(value.mode, enums.reviewMode);
  const priorOutcome = safeEnum(value.prior_outcome, enums.priorOutcome);
  const names = [
    'original_review_reference', 'original_context_reference',
    'original_candidate_reference', 'current_context_reference',
    'current_candidate_reference'
  ];
  const refs = Object.fromEntries(names.map(name => [
    name, value[name] === null ? null : validateReference(value[name])
  ]));
  if (mode === 'NOT_A_REVIEW') {
    if (names.some(name => refs[name] !== null) || priorOutcome !== 'NOT_APPLICABLE') invalid();
  } else if (mode === 'FRESH_REVIEW') {
    if (refs.original_review_reference !== null ||
        refs.original_context_reference !== null ||
        refs.original_candidate_reference !== null ||
        refs.current_context_reference === null ||
        refs.current_candidate_reference === null ||
        priorOutcome !== 'NOT_APPLICABLE') invalid();
  } else {
    if (names.some(name => refs[name] === null) ||
        !sameValue(refs.original_context_reference, refs.current_context_reference) ||
        !['KNOWN', 'UNKNOWN'].includes(priorOutcome)) invalid();
  }
  const candidateRelation = mode === 'CONTINUATION'
    ? sameValue(refs.original_candidate_reference, refs.current_candidate_reference)
      ? 'SAME' : 'CHANGED'
    : 'NOT_APPLICABLE';
  return {
    mode,
    original_review_reference_digest: refs.original_review_reference
      ? referenceDigest(refs.original_review_reference) : null,
    original_context_reference_digest: refs.original_context_reference
      ? referenceDigest(refs.original_context_reference) : null,
    original_candidate_reference_digest: refs.original_candidate_reference
      ? referenceDigest(refs.original_candidate_reference) : null,
    current_context_reference_digest: refs.current_context_reference
      ? referenceDigest(refs.current_context_reference) : null,
    current_candidate_reference_digest: refs.current_candidate_reference
      ? referenceDigest(refs.current_candidate_reference) : null,
    candidate_relation: candidateRelation,
    prior_outcome: priorOutcome,
    substantive_independence: 'NOT_ESTABLISHED'
  };
}

function validateRecovery(value, prepared) {
  closed(value, ['reference_state', 'context_state']);
  const referenceState = safeEnum(value.reference_state, enums.recoveryReference);
  const contextState = safeEnum(value.context_state, enums.recoveryContext);
  if (referenceState === 'PRESENT' && prepared.recovery_reference_digest === null) invalid();
  if (referenceState === 'ABSENT' && prepared.recovery_reference_digest !== null) invalid();
  return {
    reference_state: referenceState,
    reference_digest: prepared.recovery_reference_digest,
    context_state: contextState,
    live_context_identity: 'NOT_ESTABLISHED'
  };
}

function validateReadObservation(value, expected) {
  closed(value, ['reference_digest', 'sha256', 'byte_count', 'coverage']);
  const refDigest = validateDigest(value.reference_digest);
  const coverage = safeEnum(value.coverage, enums.coverage);
  if (!Object.hasOwn(expected, refDigest)) invalid();
  const required = expected[refDigest];
  const sha256 = value.sha256;
  const byteCount = value.byte_count;
  if (coverage === 'MISSING' || coverage === 'UNKNOWN') {
    if (sha256 !== null || byteCount !== null) invalid();
  } else {
    validateDigest(sha256);
    if (!isSafeInteger(byteCount, MAX_REFERENCE_BYTES)) invalid();
    if (coverage === 'WHOLE_BYTE_EXACT' &&
        (sha256 !== required.sha256 || byteCount !== required.byte_count)) invalid();
    if (coverage === 'BOUNDED_EXCERPT' && byteCount > required.byte_count) invalid();
  }
  return {reference_digest: refDigest, sha256, byte_count: byteCount, coverage};
}

function validateReadObservations(value, requiredReads) {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) invalid();
  const expected = Object.create(null);
  for (const ref of requiredReads) expected[ref.reference_digest] = ref;
  const observed = new Map();
  let itemCount = 0;
  for (const group of value) {
    if (!Array.isArray(group) || group.length < 1 || group.length > MAX_GROUP_ITEMS) invalid();
    itemCount += group.length;
    if (itemCount > MAX_READ_ITEMS) invalid();
    for (const item of group) {
      const fact = validateReadObservation(item, expected);
      const prior = observed.get(fact.reference_digest);
      if (prior !== undefined && !sameValue(prior, fact)) invalid();
      observed.set(fact.reference_digest, fact);
    }
  }
  const counts = {
    WHOLE_BYTE_EXACT: 0,
    BOUNDED_EXCERPT: 0,
    COMPLETE_JSON_VALUE_EQUALITY: 0,
    MISSING: 0,
    UNKNOWN: 0,
    NOT_REPORTED: 0
  };
  const projected = requiredReads.map(required => {
    const fact = observed.get(required.reference_digest);
    const coverage = fact?.coverage ?? 'NOT_REPORTED';
    counts[coverage]++;
    return {
      reference_digest: required.reference_digest,
      sha256: required.sha256,
      byte_count: required.byte_count,
      coverage_claim: coverage,
      observed_sha256: fact?.sha256 ?? null,
      observed_byte_count: fact?.byte_count ?? null
    };
  });
  return {
    required_count: requiredReads.length,
    supplied_count: observed.size,
    identity_policy: 'EXACT_REQUIRED_SET',
    claim_counts: counts,
    groups: chunks(projected)
  };
}

function validateObservations(value, prepared) {
  const input = captureInput(value);
  closed(input, [
    'schema_version', 'request_digest', 'reference_digest', 'dispatch_state',
    'process_start_state', 'terminal', 'reported_identity', 'raw_capture',
    'final_artifact', 'read_observation_groups', 'recovery', 'review',
    'environment_removals', 'permission_denial', 'quota_evidence',
    'transport_state', 'evidence_state', 'tool_state', 'estimate_state',
    'settlement_state'
  ]);
  if (input.schema_version !== OBSERVATIONS_SCHEMA ||
      input.request_digest !== prepared.request_digest ||
      input.reference_digest !== prepared.reference_digest) invalid();

  const dispatch = safeEnum(input.dispatch_state, enums.dispatch);
  const processStart = safeEnum(input.process_start_state, enums.processStart);
  if (dispatch === 'NOT_ATTEMPTED' && processStart === 'OBSERVED') invalid();
  const terminal = validateTerminal(input.terminal);
  if (dispatch === 'NOT_ATTEMPTED' &&
      (terminal.state === 'EXIT_CODE' || terminal.state === 'SIGNAL')) invalid();
  const reportedIdentity = validateRequestedIdentity(input.reported_identity);
  closed(input.raw_capture, ['stdout', 'stderr']);
  const rawCapture = {
    stdout: validateStream(input.raw_capture.stdout, MAX_STDOUT_BYTES),
    stderr: validateStream(input.raw_capture.stderr, MAX_STDERR_BYTES)
  };
  const finalArtifact = validateFinal(input.final_artifact, rawCapture);
  const readCoverage = validateReadObservations(
    input.read_observation_groups, prepared.required_reads
  );
  const recovery = validateRecovery(input.recovery, prepared);
  const review = validateReview(input.review);
  const environmentRemovals = validateEnvironment(input.environment_removals);
  const permissionDenial = safeEnum(input.permission_denial, enums.binaryEvidence);
  const quotaEvidence = safeEnum(input.quota_evidence, enums.binaryEvidence);
  const transportState = safeEnum(input.transport_state, enums.transport);
  const evidenceState = safeEnum(input.evidence_state, enums.factState);
  const toolState = safeEnum(input.tool_state, enums.tool);
  const estimateState = safeEnum(input.estimate_state, enums.estimate);
  const settlementState = safeEnum(input.settlement_state, enums.settlement);

  return {
    dispatch,
    processStart,
    terminal,
    reportedIdentity,
    rawCapture,
    finalArtifact,
    readCoverage,
    recovery,
    review,
    environmentRemovals,
    permissionDenial,
    quotaEvidence,
    transportState,
    evidenceState,
    toolState,
    estimateState,
    settlementState
  };
}

function captureState(raw, final) {
  const rawStates = [raw.stdout.state, raw.stderr.state];
  const allStates = [...rawStates, final.state];
  if (allStates.some(state => ['TRUNCATED', 'MISSING'].includes(state))) return 'INCOMPLETE';
  if (allStates.includes('UNKNOWN')) return 'UNKNOWN';
  return 'COMPLETE';
}

function candidatePresence(final) {
  switch (final.state) {
    case 'COMPLETE': return 'NONEMPTY_CAPTURED';
    case 'EMPTY': return 'EMPTY_NOT_USABLE';
    case 'NO_CANDIDATE': return 'NO_CANDIDATE';
    case 'TRUNCATED': return 'TRUNCATED';
    case 'MISSING': return 'MISSING';
    default: return 'UNKNOWN';
  }
}

export function assessCourierHandoff(prepared, observations) {
  try {
    const request = validatePrepared(prepared);
    const facts = validateObservations(observations, request);
    return freezeDeep({
      schema_version: ASSESSMENT_SCHEMA,
      assessment_kind: 'METADATA_ONLY',
      request_digest: request.request_digest,
      reference_digest: request.reference_digest,
      requested_identity: facts === null ? null : request.requested_identity,
      reported_identity: facts.reportedIdentity,
      dispatch_state: facts.dispatch,
      process_start_state: facts.processStart,
      terminal: facts.terminal,
      raw_capture: facts.rawCapture,
      derived_final: facts.finalArtifact,
      capture_state: captureState(facts.rawCapture, facts.finalArtifact),
      candidate_presence: candidatePresence(facts.finalArtifact),
      read_coverage: facts.readCoverage,
      recovery: facts.recovery,
      review: facts.review,
      environment_removals: facts.environmentRemovals,
      permission_denial: facts.permissionDenial,
      quota_evidence: facts.quotaEvidence,
      transport_state: facts.transportState,
      evidence_state: facts.evidenceState,
      tool_state: facts.toolState,
      estimate_state: facts.estimateState,
      settlement_state: facts.settlementState,
      execution_permission: 'EXTERNAL_NOT_ASSESSED',
      runtime_admitted: false,
      task_correctness: 'NOT_EVALUATED',
      replay: 'NOT_SUPPORTED',
      external_stages: {
        review_acceptance: 'EXTERNAL_NOT_ASSESSED',
        delivery: 'EXTERNAL_NOT_ASSESSED',
        merge: 'EXTERNAL_NOT_ASSESSED',
        installation: 'EXTERNAL_NOT_ASSESSED',
        use: 'EXTERNAL_NOT_ASSESSED'
      }
    });
  } catch {
    invalid();
  }
}
