// Pure candidate and check-receipt data validation only.
//
// The pure capture helpers perform no filesystem, process, clock, admission,
// checker, or native operation. PURE_DATA_ONLY captures bind caller-supplied
// values; they do not verify physical artifacts, establish coverage, or
// qualify product, provenance, or native readiness. The explicit artifact
// file helper below verifies only artifact bytes. Direct import supplies no
// pre-import source-pin verification guarantee.
import {types} from 'node:util';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {
  parseReceiptJson, snapshotReceiptData
} from './offline-run-summary.mjs';
import {artifactPath} from './job-spec.mjs';
import {
  canonicalBytes, hash, verifyExactFile
} from './bounded-codegen-plan.mjs';
import {verifyArtifacts} from './artifact-verifier.mjs';
import {
  validateDesktopCodingLargeObservationConfig
} from './project-configuration.mjs';
import {verifyLargeProjectStage} from './multifile-staging.mjs';
import {
  DESKTOP_READINESS_COMPANION_PATHS,
  validateDesktopReadinessExecutedTerminal
} from './desktop-readiness-evidence.mjs';

const CONTEXT_BYTES_MAX = 65_536;
const RECEIPT_BYTES_MAX = 65_536;
const DEFINITION_BYTES_MAX = 1_048_576;
const DEFINITION_TOTAL_MAX = 16_777_216;
const SOURCE_PIN_BYTES_MAX = 1_048_576;
const SOURCE_PIN_TOTAL_MAX = 4_194_304;
const ARTIFACT_COUNT_MAX = 16;
const ARTIFACT_BYTES_MAX = 67_108_864;
const ARTIFACT_TOTAL_MAX = 134_217_728;
const CHECK_COUNT_MAX = 16;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_PATHS = Object.freeze([...DESKTOP_READINESS_COMPANION_PATHS]);
const REASONS = new Set([
  'NONE', 'CHECK_FAILED', 'CHECK_UNAVAILABLE', 'EXPLICIT_NOT_RUN',
  'NATIVE_UNQUALIFIED', 'ABORTED', 'TERMINAL_INCOMPLETE',
  'MISSING_EVIDENCE', 'INVALID_EVIDENCE', 'BINDING_MISMATCH',
  'STAGE_CORRUPT_OR_INCOMPLETE', 'ARTIFACT_CHANGED', 'ARTIFACT_LIMIT',
  'ARTIFACT_IO', 'CLOSE_FAILED', 'ROLE_INSUFFICIENT'
]);
const LIMITATIONS = new Set([
  'TRUSTED_CALLER_ORIGIN', 'NATIVE_NOT_EXECUTED_BY_RESOLVER',
  'PRODUCT_NOT_EVALUATED', 'DESCENDANTS_NOT_ESTABLISHED',
  'STAGE_ACKNOWLEDGEMENT_UNKNOWN', 'HOST_IO_NOT_PREEMPTIBLE'
]);
const RECEIPT_STATUSES = new Set(['passed', 'failed', 'blocked', 'not_run']);
const FIXED_CODES = new Set(['INVALID_ARTIFACT_CONTEXT', ...REASONS]);
const captures = new WeakMap();
const encoder = new TextEncoder();
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength'
).get;

export class ProjectArtifactCheckValidationError extends TypeError {
  constructor(code) {
    const fixed = FIXED_CODES.has(code) ? code : 'INVALID_ARTIFACT_CONTEXT';
    super(fixed);
    this.name = 'ProjectArtifactCheckValidationError';
    this.code = fixed;
  }
}

function fail(code = 'INVALID_ARTIFACT_CONTEXT') {
  throw new ProjectArtifactCheckValidationError(code);
}

function safeInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isSha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function isToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function stringByteLength(value, maxBytes, code) {
  if (typeof value !== 'string' || value.length > maxBytes) fail(code);
  const size = encoder.encode(value).length;
  if (size > maxBytes) fail(code);
  return size;
}

// Clone own data properties only. Proxy detection precedes reflection, and
// accessor descriptors are rejected without invoking their getters.
function cloneData(value, code, budget, depth = 0, seen = new Set()) {
  if (++budget.nodes > 20_000 || depth > 20) fail(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.bytes += stringByteLength(value, budget.maxBytes, code);
    if (budget.bytes > budget.maxBytes) fail(code);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code);
    return value;
  }
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
      seen.has(value)) fail(code);

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail(code);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!safeInteger(length, 0, 20_000) || keys.length !== length + 1) fail(code);
    const output = [];
    seen.add(value);
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
      output.push(cloneData(descriptor.value, code, budget, depth + 1, seen));
    }
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(code);
    }
    seen.delete(value);
    return output;
  }

  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const output = Object.create(null);
  seen.add(value);
  for (const key of keys) {
    if (typeof key !== 'string' ||
        ['__proto__', 'constructor', 'prototype'].includes(key)) fail(code);
    budget.bytes += stringByteLength(key, budget.maxBytes, code);
    if (budget.bytes > budget.maxBytes) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[key] = cloneData(descriptor.value, code, budget, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function cloneBounded(value, code, maxBytes = CONTEXT_BYTES_MAX) {
  return cloneData(value, code, {nodes: 0, bytes: 0, maxBytes});
}

function closedRecord(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      types.isProxy(value)) fail(code);
  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (ownKeys.length !== keys.length ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) fail(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[key] = descriptor.value;
  }
  return output;
}

function copyBytes(value, maxBytes, code, oversizedCode = code) {
  if (types.isProxy(value) || !types.isUint8Array(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype) fail(code);
  let length;
  try {
    length = intrinsicByteLength.call(value);
  } catch {
    fail(code);
  }
  if (!Number.isSafeInteger(length) || length < 0) fail(code);
  if (length > maxBytes) fail(oversizedCode);
  const copy = new Uint8Array(length);
  try {
    Uint8Array.prototype.set.call(copy, value);
  } catch {
    copy.fill(0);
    fail(code);
  }
  return copy;
}

function parseDocument(bytes, code) {
  try {
    return cloneBounded(
      snapshotReceiptData(parseReceiptJson(bytes)), code
    );
  } catch (error) {
    if (error instanceof ProjectArtifactCheckValidationError) throw error;
    fail(code);
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function pathValue(value) {
  if (typeof value !== 'string' || value.length > 512 ||
      value === '/' || !value.startsWith('/') ||
      value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (encoder.encode(value).length > 512) return false;
  return value.slice(1).split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..'
  );
}

// Relative is exactly job-spec's artifactPath plus the approved UTF-8 and
// segment bounds. Stage/export portability restrictions are applied later.
function relativeValue(value) {
  if (!artifactPath(value) || value.length > 256) return false;
  if (encoder.encode(value).length > 256) return false;
  return value.split('/').length <= 16;
}

function pinData(value, code, maxBytes) {
  const pin = closedRecord(value, ['path', 'bytes', 'sha256'], code);
  if (!pathValue(pin.path) || !safeInteger(pin.bytes, 1, maxBytes) ||
      !isSha(pin.sha256)) fail(code);
  return pin;
}

function sourcePinsData(value, code) {
  const pins = closedRecord(value, SOURCE_PATHS, code);
  const output = Object.create(null);
  let total = 0;
  for (const relative of SOURCE_PATHS) {
    const pin = closedRecord(pins[relative], ['bytes', 'sha256'], code);
    if (!safeInteger(pin.bytes, 1, SOURCE_PIN_BYTES_MAX) ||
        !isSha(pin.sha256)) fail(code);
    total += pin.bytes;
    if (!Number.isSafeInteger(total) || total > SOURCE_PIN_TOTAL_MAX) fail(code);
    output[relative] = Object.freeze({bytes: pin.bytes, sha256: pin.sha256});
  }
  return output;
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSortedUnique(values) {
  for (let index = 1; index < values.length; index++) {
    if (asciiCompare(values[index - 1], values[index]) >= 0) return false;
  }
  return true;
}

function withinPath(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function validateContextData(value) {
  const code = 'INVALID_ARTIFACT_CONTEXT';
  const context = closedRecord(value, [
    'schema', 'operation_config_sha256', 'job_id', 'candidate', 'artifacts',
    'required_checks', 'observer_policy_sha256', 'companion_source_pins'
  ], code);
  if (context.schema !== 'squire.project_artifact_check_context.v2' ||
      !isSha(context.operation_config_sha256) ||
      typeof context.job_id !== 'string' || !UUID4.test(context.job_id) ||
      !isSha(context.observer_policy_sha256)) fail(code);

  const candidate = closedRecord(context.candidate, [
    'source_commit', 'stage_root', 'stage_operation_id',
    'stage_manifest_sha256'
  ], code);
  if (typeof candidate.source_commit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(candidate.source_commit) ||
      !pathValue(candidate.stage_root) ||
      !isToken(candidate.stage_operation_id) ||
      !isSha(candidate.stage_manifest_sha256)) fail(code);

  if (!Array.isArray(context.artifacts) ||
      context.artifacts.length < 1 ||
      context.artifacts.length > ARTIFACT_COUNT_MAX) fail(code);
  const artifacts = [];
  let artifactTotal = 0;
  const ids = new Set();
  const rootPaths = new Set();
  for (const value of context.artifacts) {
    const artifact = closedRecord(value, [
      'artifact_id', 'role', 'root', 'relative_path', 'byte_count', 'sha256',
      'staged_artifact_id'
    ], code);
    if (!isToken(artifact.artifact_id) || ids.has(artifact.artifact_id) ||
        !['staged', 'delivered_copy'].includes(artifact.role) ||
        !pathValue(artifact.root) || !relativeValue(artifact.relative_path) ||
        !safeInteger(artifact.byte_count, 1, ARTIFACT_BYTES_MAX) ||
        !isSha(artifact.sha256)) fail(code);
    if (artifact.role === 'staged') {
      if (artifact.staged_artifact_id !== null ||
          artifact.root !== candidate.stage_root) fail(code);
    } else if (!isToken(artifact.staged_artifact_id)) {
      fail(code);
    }
    ids.add(artifact.artifact_id);
    artifactTotal += artifact.byte_count;
    if (!Number.isSafeInteger(artifactTotal) ||
        artifactTotal > ARTIFACT_TOTAL_MAX) fail(code);
    const pair = `${artifact.root}\0${artifact.relative_path}`;
    if (rootPaths.has(pair)) fail(code);
    rootPaths.add(pair);
    artifacts.push(artifact);
  }

  const artifactsById = new Map(artifacts.map(artifact =>
    [artifact.artifact_id, artifact]
  ));
  for (const artifact of artifacts) {
    if (artifact.role !== 'delivered_copy') continue;
    const source = artifactsById.get(artifact.staged_artifact_id);
    if (!source || source.role !== 'staged' ||
        source.byte_count !== artifact.byte_count ||
        source.sha256 !== artifact.sha256 ||
        source.root === artifact.root &&
        source.relative_path === artifact.relative_path) fail(code);
  }

  if (!Array.isArray(context.required_checks) ||
      context.required_checks.length < 1 ||
      context.required_checks.length > CHECK_COUNT_MAX) fail(code);
  const checks = [];
  const checkIds = new Set();
  let definitionTotal = 0;
  for (const value of context.required_checks) {
    const check = closedRecord(value, [
      'check_id', 'definition_pin', 'receipt_pin', 'observer_role',
      'artifact_ids'
    ], code);
    if (!isToken(check.check_id) || checkIds.has(check.check_id) ||
        check.observer_role !== 'trusted_owner_fixture' ||
        !Array.isArray(check.artifact_ids) ||
        check.artifact_ids.length < 1 ||
        check.artifact_ids.length > ARTIFACT_COUNT_MAX ||
        check.artifact_ids.some(id => !isToken(id)) ||
        !isSortedUnique(check.artifact_ids) ||
        check.artifact_ids.some(id => !ids.has(id))) fail(code);
    const definitionPin = pinData(
      check.definition_pin, code, DEFINITION_BYTES_MAX
    );
    const receiptPin = pinData(check.receipt_pin, code, RECEIPT_BYTES_MAX);
    definitionTotal += definitionPin.bytes;
    if (!Number.isSafeInteger(definitionTotal) ||
        definitionTotal > DEFINITION_TOTAL_MAX) fail(code);
    checkIds.add(check.check_id);
    checks.push({
      check_id: check.check_id,
      definition_pin: definitionPin,
      receipt_pin: receiptPin,
      observer_role: check.observer_role,
      artifact_ids: [...check.artifact_ids]
    });
  }

  const artifactRoots = artifacts.map(artifact => artifact.root);
  for (const check of checks) {
    for (const pin of [check.definition_pin, check.receipt_pin]) {
      if (artifactRoots.some(root => withinPath(pin.path, root))) fail(code);
    }
  }

  const companionPins = sourcePinsData(context.companion_source_pins, code);
  return deepFreeze({
    schema: context.schema,
    operation_config_sha256: context.operation_config_sha256,
    job_id: context.job_id,
    candidate: deepFreeze({
      source_commit: candidate.source_commit,
      stage_root: candidate.stage_root,
      stage_operation_id: candidate.stage_operation_id,
      stage_manifest_sha256: candidate.stage_manifest_sha256
    }),
    artifacts: artifacts.map(artifact => deepFreeze({
      artifact_id: artifact.artifact_id,
      role: artifact.role,
      root: artifact.root,
      relative_path: artifact.relative_path,
      byte_count: artifact.byte_count,
      sha256: artifact.sha256,
      staged_artifact_id: artifact.staged_artifact_id
    })),
    required_checks: checks.map(check => deepFreeze(check)),
    observer_policy_sha256: context.observer_policy_sha256,
    companion_source_pins: companionPins
  });
}

/** Validate and independently copy a closed ArtifactContext. */
export function validateProjectArtifactCheckContext(value) {
  try {
    return validateContextData(cloneBounded(value, 'INVALID_ARTIFACT_CONTEXT'));
  } catch (error) {
    if (error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'INVALID_ARTIFACT_CONTEXT') throw error;
    fail('INVALID_ARTIFACT_CONTEXT');
  }
}

function readConfig(bytes) {
  try {
    const parsed = parseDocument(bytes, 'INVALID_ARTIFACT_CONTEXT');
    const validated = validateDesktopCodingLargeObservationConfig(parsed);
    return deepFreeze(cloneBounded(validated, 'INVALID_ARTIFACT_CONTEXT'));
  } catch {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
}

function checkConfigBindings(config, configHash, context) {
  const expectedStageRoot = join(
    config.scope, 'output', `run-${config.job_id}`, 'stage'
  );
  if (context.operation_config_sha256 !== configHash ||
      context.job_id !== config.job_id ||
      context.candidate.source_commit !== config.source_commit ||
      context.candidate.stage_root !== expectedStageRoot ||
      context.candidate.stage_operation_id !== `stage-${config.job_id}`) {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
}

/**
 * Capture exact config/context bytes and their trusted-data associations.
 * This does not authenticate the source, stage, artifacts, or evidence origin.
 */
export function captureProjectArtifactCheckData(input) {
  let configBytes = null;
  let contextBytes = null;
  try {
    const supplied = closedRecord(
      input, ['configBytes', 'artifactContextBytes'],
      'INVALID_ARTIFACT_CONTEXT'
    );
    configBytes = copyBytes(
      supplied.configBytes, CONTEXT_BYTES_MAX, 'INVALID_ARTIFACT_CONTEXT',
      'INVALID_ARTIFACT_CONTEXT'
    );
    contextBytes = copyBytes(
      supplied.artifactContextBytes, CONTEXT_BYTES_MAX,
      'INVALID_ARTIFACT_CONTEXT', 'INVALID_ARTIFACT_CONTEXT'
    );
    const configHash = hash(configBytes);
    const config = readConfig(configBytes);
    const context = validateContextData(
      parseDocument(contextBytes, 'INVALID_ARTIFACT_CONTEXT')
    );
    checkConfigBindings(config, configHash, context);
    const capture = deepFreeze({
      config,
      context,
      operation_config_sha256: configHash,
      validation_scope: 'PURE_DATA_ONLY'
    });
    captures.set(capture, {config, context, configHash});
    return capture;
  } catch (error) {
    if (error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'INVALID_ARTIFACT_CONTEXT') throw error;
    fail('INVALID_ARTIFACT_CONTEXT');
  } finally {
    configBytes?.fill(0);
    contextBytes?.fill(0);
  }
}

function requireCapture(value, code = 'BINDING_MISMATCH') {
  const state = value && typeof value === 'object' && !types.isProxy(value)
    ? captures.get(value)
    : undefined;
  if (!state || !Object.isFrozen(value) ||
      value.validation_scope !== 'PURE_DATA_ONLY') fail(code);
  return state;
}

function subsetValue(state, checkId) {
  if (!isToken(checkId)) fail('BINDING_MISMATCH');
  const check = state.context.required_checks.find(
    item => item.check_id === checkId
  );
  if (!check) fail('BINDING_MISMATCH');
  const byId = new Map(state.context.artifacts.map(artifact =>
    [artifact.artifact_id, artifact]
  ));
  const artifacts = check.artifact_ids.map(id => {
    const artifact = byId.get(id);
    if (!artifact) fail('BINDING_MISMATCH');
    return {
      artifact_id: artifact.artifact_id,
      role: artifact.role,
      relative_path: artifact.relative_path,
      byte_count: artifact.byte_count,
      sha256: artifact.sha256,
      staged_artifact_id: artifact.staged_artifact_id
    };
  }).sort((left, right) => asciiCompare(left.artifact_id, right.artifact_id));
  return {
    check,
    value: {
      job_id: state.context.job_id,
      operation_config_sha256: state.configHash,
      stage_manifest_sha256:
        state.context.candidate.stage_manifest_sha256,
      artifacts
    }
  };
}

/** Hash the fixed subset projection; root paths are intentionally excluded. */
export function projectArtifactSubsetHash(captured, check_id) {
  const state = requireCapture(captured);
  const selected = subsetValue(state, check_id);
  try {
    return hash(canonicalBytes({
      domain: 'squire.project-artifact-check.subset.v2',
      value: selected.value
    }));
  } catch {
    fail('BINDING_MISMATCH');
  }
}

function validateLimitations(value) {
  if (!Array.isArray(value) || value.length > 8 ||
      value.some(item => typeof item !== 'string' || !LIMITATIONS.has(item)) ||
      !isSortedUnique(value)) fail('INVALID_EVIDENCE');
  return [...value];
}

function validateReceiptShape(value) {
  const receipt = closedRecord(value, [
    'schema', 'check_id', 'definition_sha256', 'job_id',
    'operation_config_sha256', 'stage_manifest_sha256',
    'artifact_subset_sha256', 'observer_policy_sha256', 'observer_role',
    'status', 'reason', 'terminal', 'limitations'
  ], 'INVALID_EVIDENCE');
  if (receipt.schema !== 'squire.project_artifact_check_receipt.v2' ||
      !isToken(receipt.check_id) || !isSha(receipt.definition_sha256) ||
      typeof receipt.job_id !== 'string' || !UUID4.test(receipt.job_id) ||
      !isSha(receipt.operation_config_sha256) ||
      !isSha(receipt.stage_manifest_sha256) ||
      !isSha(receipt.artifact_subset_sha256) ||
      !isSha(receipt.observer_policy_sha256) ||
      !['trusted_owner_fixture', 'candidate_test'].includes(receipt.observer_role) ||
      !RECEIPT_STATUSES.has(receipt.status) ||
      !REASONS.has(receipt.reason)) fail('INVALID_EVIDENCE');
  receipt.limitations = validateLimitations(receipt.limitations);
  if (receipt.observer_role !== 'trusted_owner_fixture') {
    fail('ROLE_INSUFFICIENT');
  }
  if (receipt.terminal === null) {
    const validNull = receipt.status === 'blocked' &&
      receipt.reason === 'CHECK_UNAVAILABLE' ||
      receipt.status === 'not_run' &&
      receipt.reason === 'EXPLICIT_NOT_RUN';
    if (!validNull) fail('TERMINAL_INCOMPLETE');
    return deepFreeze(receipt);
  }

  if (!['passed', 'failed'].includes(receipt.status)) {
    fail('TERMINAL_INCOMPLETE');
  }
  let terminal;
  try {
    terminal = validateDesktopReadinessExecutedTerminal(receipt.terminal);
  } catch {
    fail('TERMINAL_INCOMPLETE');
  }
  if (terminal.direct_child_exit_observed !== true ||
      terminal.stdout_eof !== true || terminal.stderr_eof !== true ||
      terminal.exit_kind === 'unknown') fail('TERMINAL_INCOMPLETE');

  if (receipt.status === 'passed') {
    if (receipt.reason !== 'NONE') fail('INVALID_EVIDENCE');
    if (terminal.exit_kind !== 'natural' || terminal.exit_code !== 0 ||
        terminal.signal !== null || terminal.stop_codes.length !== 0 ||
        terminal.cleanup_codes.length !== 0) fail('TERMINAL_INCOMPLETE');
  } else {
    if (!['CHECK_FAILED', 'ABORTED', 'CHECK_UNAVAILABLE'].includes(
      receipt.reason
    )) fail('INVALID_EVIDENCE');
    if (terminal.exit_kind === 'natural' &&
        (!safeInteger(terminal.exit_code, 0, 255) ||
         terminal.signal !== null) ||
        terminal.exit_kind === 'signal' &&
        (terminal.exit_code !== null || terminal.signal === null)) {
      fail('TERMINAL_INCOMPLETE');
    }
  }
  receipt.terminal = terminal;
  return deepFreeze(receipt);
}

/**
 * Validate exact pinned definition and receipt bytes and their data bindings.
 * The returned envelope is PURE_DATA_ONLY and never marks physical evidence
 * verified or produces a CheckResult or Sidecar.
 */
export function captureProjectArtifactCheckReceipt(input) {
  let receiptBytes = null;
  let definitionBytes = null;
  try {
    const supplied = closedRecord(input, [
      'captured', 'check_id', 'receiptBytes', 'definitionBytes'
    ], 'INVALID_EVIDENCE');
    const state = requireCapture(supplied.captured);
    if (!isToken(supplied.check_id)) fail('BINDING_MISMATCH');
    const selected = subsetValue(state, supplied.check_id);
    const check = selected.check;
    receiptBytes = copyBytes(
      supplied.receiptBytes, RECEIPT_BYTES_MAX,
      'INVALID_EVIDENCE', 'ARTIFACT_LIMIT'
    );
    definitionBytes = copyBytes(
      supplied.definitionBytes, DEFINITION_BYTES_MAX,
      'INVALID_EVIDENCE', 'ARTIFACT_LIMIT'
    );
    if (receiptBytes.length !== check.receipt_pin.bytes ||
        hash(receiptBytes) !== check.receipt_pin.sha256 ||
        definitionBytes.length !== check.definition_pin.bytes ||
        hash(definitionBytes) !== check.definition_pin.sha256) {
      fail('INVALID_EVIDENCE');
    }

    let parsed;
    try {
      parsed = parseDocument(receiptBytes, 'INVALID_EVIDENCE');
    } catch {
      fail('INVALID_EVIDENCE');
    }
    const receipt = validateReceiptShape(parsed);
    const expectedSubsetHash = hash(canonicalBytes({
      domain: 'squire.project-artifact-check.subset.v2',
      value: selected.value
    }));
    const definitionHash = hash(definitionBytes);
    if (receipt.observer_role !== check.observer_role) {
      fail('ROLE_INSUFFICIENT');
    }
    if (receipt.check_id !== check.check_id ||
        receipt.definition_sha256 !== check.definition_pin.sha256 ||
        definitionHash !== check.definition_pin.sha256 ||
        receipt.job_id !== state.context.job_id ||
        receipt.operation_config_sha256 !== state.configHash ||
        receipt.stage_manifest_sha256 !==
          state.context.candidate.stage_manifest_sha256 ||
        receipt.artifact_subset_sha256 !== expectedSubsetHash ||
        receipt.observer_policy_sha256 !==
          state.context.observer_policy_sha256) {
      fail('BINDING_MISMATCH');
    }
    return deepFreeze({
      receipt,
      definition_sha256: definitionHash,
      receipt_sha256: hash(receiptBytes),
      validation_scope: 'PURE_DATA_ONLY'
    });
  } catch (error) {
    if (error instanceof ProjectArtifactCheckValidationError) throw error;
    fail('INVALID_EVIDENCE');
  } finally {
    receiptBytes?.fill(0);
    definitionBytes?.fill(0);
  }
}

const ARTIFACT_FILE_FAILURES = Object.freeze([
  'ABORTED', 'LIMIT', 'FILE_CHANGED', 'IO_FAILED', 'CLOSE_FAILED'
]);
const ARTIFACT_FILE_CONTROL_CAUSES = new Set([
  'ABORTED', 'LIMIT', 'FILE_CHANGED'
]);
const ARTIFACT_FILE_ABORT = new Error('ARTIFACT_FILE_ABORT');
const ARTIFACT_FILE_FAILURE = new Error('ARTIFACT_FILE_FAILURE');
const ARTIFACT_FILE_CLOSE_FAILURE = new Error('ARTIFACT_FILE_CLOSE_FAILURE');
const ARTIFACT_FILE_PATH_BYTES_MAX = 769;
const ARTIFACT_FILE_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype, 'aborted'
).get;
const ARTIFACT_FILE_ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const ARTIFACT_FILE_BYTE_FIELDS = Object.freeze([
  'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'
]);
const ARTIFACT_FILE_OUTPUT_REASON = Object.freeze({
  CLOSE_FAILED: 'CLOSE_FAILED',
  ABORTED: 'ABORTED',
  LIMIT: 'ARTIFACT_LIMIT',
  FILE_CHANGED: 'ARTIFACT_CHANGED',
  IO_FAILED: 'ARTIFACT_IO'
});

function captureArtifactFilePorts(value) {
  try {
    const supplied = closedRecord(
      value, ['fs', 'uid'], 'INVALID_ARTIFACT_CONTEXT'
    );
    const receiver = supplied.fs;
    const methods = closedRecord(
      receiver, ['lstat', 'realpath', 'open'], 'INVALID_ARTIFACT_CONTEXT'
    );
    const lstat = methods.lstat;
    const realpath = methods.realpath;
    const open = methods.open;
    const capturedMethods = [lstat, realpath, open];
    if (!safeInteger(
      supplied.uid, 0, Number.MAX_SAFE_INTEGER
    ) || capturedMethods.some(method =>
      typeof method !== 'function' || types.isProxy(method)
    )) fail('INVALID_ARTIFACT_CONTEXT');

    // Forward only through captured methods and receiver. Function metadata
    // such as name and length is never inspected during port capture.
    const forward = method => (...args) =>
      Reflect.apply(method, receiver, args);
    return Object.freeze({
      fs: Object.freeze({
        lstat: forward(lstat),
        realpath: forward(realpath),
        open: forward(open)
      }),
      uid: supplied.uid
    });
  } catch {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
}

function validateArtifactFileSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)) {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
  try {
    if (typeof ARTIFACT_FILE_ABORTED_GETTER.call(signal) !== 'boolean') {
      fail('INVALID_ARTIFACT_CONTEXT');
    }
  } catch {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
}

function artifactFileLatch(state, code) {
  if (ARTIFACT_FILE_FAILURES.includes(code)) state.failures.add(code);
}

function artifactFileNoteAbort(signal, state) {
  if (signal === undefined) return false;
  try {
    if (ARTIFACT_FILE_ABORTED_GETTER.call(signal) === true) {
      artifactFileLatch(state, 'ABORTED');
      return true;
    }
  } catch {
    artifactFileLatch(state, 'ABORTED');
    return true;
  }
  return false;
}

function artifactFileCheckAbort(signal, state) {
  if (artifactFileNoteAbort(signal, state)) throw ARTIFACT_FILE_ABORT;
}

async function awaitArtifactFileIO(
  operation, receiver, args, signal, state, group
) {
  artifactFileCheckAbort(signal, state);
  let result;
  try {
    result = await Reflect.apply(operation, receiver, args);
  } catch {
    // This records an actual rejected host IO promise independently of any
    // simultaneous abort. The verifier's generic reduction cannot erase it.
    group.hostIOFailures++;
    artifactFileLatch(state, 'IO_FAILED');
    artifactFileNoteAbort(signal, state);
    throw ARTIFACT_FILE_FAILURE;
  }
  artifactFileCheckAbort(signal, state);
  return result;
}

function noteArtifactFileVerifierControl(group, state, priorFailures, hostIOCount, error) {
  if ((error !== ARTIFACT_FILE_ABORT &&
       error !== ARTIFACT_FILE_FAILURE) ||
      group.hostIOFailures !== hostIOCount) return;

  const causes = [...state.failures].filter(code =>
    ARTIFACT_FILE_CONTROL_CAUSES.has(code) && !priorFailures.has(code)
  );
  if (causes.length === 0) return;
  // There is one unchanged verifier invocation per group. This occurrence
  // belongs only to this group's private adapter boundary.
  group.internalControlFailure = true;
  for (const code of causes) group.internalControlCauses.add(code);
}

function trackArtifactFileVerifierBoundary(group, state, operation) {
  return async (...args) => {
    const hostIOCount = group.hostIOFailures;
    const priorFailures = new Set(state.failures);
    try {
      return await operation(...args);
    } catch (error) {
      noteArtifactFileVerifierControl(
        group, state, priorFailures, hostIOCount, error
      );
      throw error;
    }
  };
}

function artifactFileDataProperty(value, key) {
  if (!value || !['object', 'function'].includes(typeof value) ||
      types.isProxy(value)) return {valid: false, found: false};
  let current = value;
  while (current !== null) {
    if (types.isProxy(current)) return {valid: false, found: false};
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return {valid: false, found: false};
    }
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value')
        ? {valid: true, found: true, value: descriptor.value}
        : {valid: false, found: true};
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return {valid: false, found: false};
    }
  }
  return {valid: true, found: false};
}

function artifactFileMethod(value, key) {
  const property = artifactFileDataProperty(value, key);
  return property.valid && property.found &&
    typeof property.value === 'function' && !types.isProxy(property.value)
    ? property.value
    : null;
}

function captureArtifactFileStat(stat, kind, uid, expectedBytes = null) {
  if (!stat || typeof stat !== 'object' || Array.isArray(stat) ||
      types.isProxy(stat)) throw ARTIFACT_FILE_FAILURE;
  const fields = Object.create(null);
  for (const key of ARTIFACT_FILE_BYTE_FIELDS) {
    const property = artifactFileDataProperty(stat, key);
    if (!property.valid || !property.found ||
        typeof property.value !== 'bigint') throw ARTIFACT_FILE_FAILURE;
    fields[key] = property.value;
  }
  const uidProperty = artifactFileDataProperty(stat, 'uid');
  const linksProperty = artifactFileDataProperty(stat, 'nlink');
  const isFile = artifactFileMethod(stat, 'isFile');
  const isDirectory = artifactFileMethod(stat, 'isDirectory');
  const isSymbolicLink = artifactFileMethod(stat, 'isSymbolicLink');
  if (!uidProperty.valid || !uidProperty.found ||
      !linksProperty.valid || !linksProperty.found ||
      !isFile || !isDirectory || !isSymbolicLink) {
    throw ARTIFACT_FILE_FAILURE;
  }
  const uidValue = uidProperty.value;
  const linksValue = linksProperty.value;
  const uidMatches = typeof uidValue === 'bigint'
    ? uidValue >= 0n && uidValue === BigInt(uid)
    : Number.isSafeInteger(uidValue) && uidValue >= 0 && uidValue === uid;
  const linksMatch = typeof linksValue === 'bigint'
    ? linksValue === 1n
    : Number.isSafeInteger(linksValue) && linksValue === 1;
  let file;
  let directory;
  let symbolicLink;
  try {
    file = Reflect.apply(isFile, stat, []);
    directory = Reflect.apply(isDirectory, stat, []);
    symbolicLink = Reflect.apply(isSymbolicLink, stat, []);
  } catch {
    throw ARTIFACT_FILE_FAILURE;
  }
  if (typeof file !== 'boolean' || typeof directory !== 'boolean' ||
      typeof symbolicLink !== 'boolean') throw ARTIFACT_FILE_FAILURE;

  if (kind === 'file') {
    if (!file || directory || symbolicLink || !uidMatches || !linksMatch ||
        fields.size !== BigInt(expectedBytes)) {
      throw ARTIFACT_FILE_FAILURE;
    }
  } else if (!directory || file || symbolicLink) {
    throw ARTIFACT_FILE_FAILURE;
  }
  return Object.freeze({
    fields: Object.freeze(fields),
    uid: uidValue,
    nlink: linksValue,
    file,
    directory,
    symbolicLink
  });
}

function sameArtifactFileStat(left, right) {
  return ARTIFACT_FILE_BYTE_FIELDS.every(key =>
    left.fields[key] === right.fields[key]
  ) && left.uid === right.uid && left.nlink === right.nlink &&
    left.file === right.file && left.directory === right.directory &&
    left.symbolicLink === right.symbolicLink;
}

function artifactFileInodeKey(signature) {
  return `${signature.fields.dev}:${signature.fields.ino}`;
}

function rememberArtifactFileStat(state, group, path, stat) {
  const artifact = group.filesByPath.get(path);
  const isFile = artifact !== undefined;
  let signature;
  try {
    signature = captureArtifactFileStat(
      stat, isFile ? 'file' : 'directory', state.ports.uid,
      isFile ? artifact.byte_count : null
    );
  } catch {
    artifactFileLatch(state, 'FILE_CHANGED');
    throw ARTIFACT_FILE_FAILURE;
  }

  const prior = state.statByPath.get(path);
  if (prior && !sameArtifactFileStat(prior, signature)) {
    artifactFileLatch(state, 'FILE_CHANGED');
    throw ARTIFACT_FILE_FAILURE;
  }
  if (!prior) state.statByPath.set(path, signature);

  // A single inode may not witness two different lexical paths, including
  // paths encountered in separate artifact roots.
  const inode = artifactFileInodeKey(signature);
  const priorPath = state.inodeOwners.get(inode);
  if (priorPath !== undefined && priorPath !== path) {
    artifactFileLatch(state, 'FILE_CHANGED');
    throw ARTIFACT_FILE_FAILURE;
  }
  state.inodeOwners.set(inode, path);
  return signature;
}

function derivedArtifactFilePath(root, relative) {
  const path = join(root, ...relative.split('/'));
  if (typeof path !== 'string' || path === root ||
      encoder.encode(path).length > ARTIFACT_FILE_PATH_BYTES_MAX ||
      !withinPath(path, root)) fail('INVALID_ARTIFACT_CONTEXT');
  return path;
}

function buildArtifactFilePlan(captured) {
  const groups = new Map();
  const allFiles = new Map();
  let totalBytes = 0;
  let physicalAlias = false;

  for (const artifact of captured.context.artifacts) {
    if (!pathValue(artifact.root) ||
        !relativeValue(artifact.relative_path) ||
        !safeInteger(artifact.byte_count, 1, ARTIFACT_BYTES_MAX) ||
        !isSha(artifact.sha256)) fail('INVALID_ARTIFACT_CONTEXT');
    totalBytes += artifact.byte_count;
    if (!Number.isSafeInteger(totalBytes) ||
        totalBytes > ARTIFACT_TOTAL_MAX) fail('INVALID_ARTIFACT_CONTEXT');

    let group = groups.get(artifact.root);
    if (!group) {
      group = {
        root: artifact.root,
        entries: [],
        filesByPath: new Map(),
        directories: new Set([artifact.root]),
        allowedLstat: new Set([artifact.root]),
        allowedRealpath: new Set([artifact.root]),
        runsByPath: new Map(),
        hostIOFailures: 0,
        internalControlFailure: false,
        internalControlCauses: new Set()
      };
      groups.set(artifact.root, group);
    }
    const fullPath = derivedArtifactFilePath(
      artifact.root, artifact.relative_path
    );
    if (allFiles.has(fullPath)) physicalAlias = true;
    allFiles.set(fullPath, artifact);

    const entry = Object.freeze({artifact, fullPath});
    group.entries.push(entry);
    group.filesByPath.set(fullPath, artifact);
    group.allowedLstat.add(fullPath);
    group.allowedRealpath.add(fullPath);
    group.runsByPath.set(fullPath, {
      artifact,
      initialStat: null,
      openAttempted: false
    });

    const parts = artifact.relative_path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = derivedArtifactFilePath(
        artifact.root, parts.slice(0, index).join('/')
      );
      group.directories.add(directory);
      group.allowedLstat.add(directory);
    }
  }

  for (const group of groups.values()) {
    for (const path of group.filesByPath.keys()) {
      if (group.directories.has(path)) physicalAlias = true;
    }
  }
  return {
    groups: [...groups.values()],
    totalBytes,
    artifactCount: captured.context.artifacts.length,
    physicalAlias
  };
}

function artifactFileOutput(captureState, state, verifiedById, plan) {
  const ioFailures = [...state.failures].sort(asciiCompare);
  const verified = ioFailures.length === 0 &&
    verifiedById.size === plan.artifactCount;
  const artifactWitness = verified
    ? captureState.context.artifacts
      .map(artifact => verifiedById.get(artifact.artifact_id))
      .sort((left, right) =>
        asciiCompare(left.artifact_id, right.artifact_id)
      )
    : [];
  let reason = 'NONE';
  if (!verified) {
    for (const code of [
      'CLOSE_FAILED', 'ABORTED', 'LIMIT', 'FILE_CHANGED', 'IO_FAILED'
    ]) {
      if (state.failures.has(code)) {
        reason = ARTIFACT_FILE_OUTPUT_REASON[code];
        break;
      }
    }
    if (reason === 'NONE') reason = 'ARTIFACT_IO';
  }
  return deepFreeze({
    verification_scope: 'ARTIFACT_FILES_ONLY',
    verified,
    artifact_witness: artifactWitness,
    io_failures: ioFailures,
    reason
  });
}

function artifactFileExpectedCapture(captureState, group) {
  const witness = Object.create(null);
  for (const {artifact} of group.entries) {
    witness[artifact.relative_path] = Object.freeze({
      byte_count: artifact.byte_count,
      sha256: artifact.sha256
    });
  }
  return Object.freeze({
    job_id: captureState.context.job_id,
    artifact_witness: Object.freeze(witness)
  });
}

function artifactFileVerifierFailure(state, group, result) {
  const failureProperty = artifactFileDataProperty(result, 'failure');
  const verifiedProperty = artifactFileDataProperty(result, 'verified');
  if (verifiedProperty.valid && verifiedProperty.found &&
      verifiedProperty.value === true && failureProperty.valid &&
      failureProperty.found && failureProperty.value === null) return;
  if (!failureProperty.valid || !failureProperty.found ||
      !verifiedProperty.valid || !verifiedProperty.found) {
    artifactFileLatch(state, 'IO_FAILED');
    return;
  }
  const failure = failureProperty.value;
  const classification = artifactFileDataProperty(failure, 'classification');
  if (!classification.valid || !classification.found ||
      typeof classification.value !== 'string') {
    artifactFileLatch(state, 'IO_FAILED');
  } else if (classification.value === 'aborted') {
    artifactFileLatch(state, 'ABORTED');
  } else if (classification.value === 'close_failed') {
    artifactFileLatch(state, 'CLOSE_FAILED');
  } else if (classification.value === 'unsupported_open_flags') {
    artifactFileLatch(state, 'LIMIT');
  } else if ([
    'artifact_changed', 'directory_changed', 'expected_mismatch'
  ].includes(classification.value)) {
    artifactFileLatch(state, 'FILE_CHANGED');
  } else if (classification.value === 'io_failure') {
    // verifyArtifacts reduces our private control sentinel to io_failure.
    // Suppress only when this exact group invocation recorded that sentinel
    // at an adapter boundary and its explicit control causes remain latched.
    const attributedControl = group.internalControlFailure &&
      group.internalControlCauses.size > 0 &&
      [...group.internalControlCauses].every(code =>
        state.failures.has(code)
      );
    if (!attributedControl) artifactFileLatch(state, 'IO_FAILED');
  } else {
    artifactFileLatch(state, 'IO_FAILED');
  }
}

function artifactFileCaptureGroupWitness(state, group, result, verifiedById) {
  const witnessProperty = artifactFileDataProperty(result, 'artifact_witness');
  const jobProperty = artifactFileDataProperty(result, 'job_id');
  if (!witnessProperty.valid || !witnessProperty.found ||
      !jobProperty.valid || !jobProperty.found ||
      jobProperty.value !== state.captureState.context.job_id) {
    artifactFileLatch(state, 'FILE_CHANGED');
    return;
  }
  const witness = witnessProperty.value;
  if (!witness || typeof witness !== 'object' || types.isProxy(witness)) {
    artifactFileLatch(state, 'FILE_CHANGED');
    return;
  }
  let keys;
  try {
    keys = Reflect.ownKeys(witness);
  } catch {
    artifactFileLatch(state, 'FILE_CHANGED');
    return;
  }
  if (keys.length !== group.entries.length) {
    artifactFileLatch(state, 'FILE_CHANGED');
    return;
  }

  for (const {artifact} of group.entries) {
    const property = artifactFileDataProperty(witness, artifact.relative_path);
    if (!property.valid || !property.found || !property.value ||
        typeof property.value !== 'object' ||
        types.isProxy(property.value)) {
      artifactFileLatch(state, 'FILE_CHANGED');
      return;
    }
    const byteCount = artifactFileDataProperty(
      property.value, 'byte_count'
    );
    const sha256 = artifactFileDataProperty(property.value, 'sha256');
    if (!byteCount.valid || !byteCount.found ||
        !sha256.valid || !sha256.found ||
        byteCount.value !== artifact.byte_count ||
        sha256.value !== artifact.sha256) {
      artifactFileLatch(state, 'FILE_CHANGED');
      return;
    }
    verifiedById.set(artifact.artifact_id, deepFreeze({
      artifact_id: artifact.artifact_id,
      role: artifact.role,
      relative_path: artifact.relative_path,
      byte_count: artifact.byte_count,
      sha256: artifact.sha256,
      staged_artifact_id: artifact.staged_artifact_id
    }));
  }
  if (keys.some(key => typeof key !== 'string' ||
      !group.entries.some(entry =>
        entry.artifact.relative_path === key
      ))) artifactFileLatch(state, 'FILE_CHANGED');
}

function makeArtifactFileVerifierIO(group, state) {
  const requireAllowed = (path, allowed) => {
    if (typeof path !== 'string' || !allowed.has(path)) {
      artifactFileLatch(state, 'LIMIT');
      throw ARTIFACT_FILE_FAILURE;
    }
  };

  const lstat = async (path, ...args) => {
    requireAllowed(path, group.allowedLstat);
    if (args.length !== 1 || !args[0] ||
        typeof args[0] !== 'object' || types.isProxy(args[0])) {
      artifactFileLatch(state, 'LIMIT');
      throw ARTIFACT_FILE_FAILURE;
    }
    const option = artifactFileDataProperty(args[0], 'bigint');
    let optionKeys;
    try {
      optionKeys = Reflect.ownKeys(args[0]);
    } catch {
      optionKeys = [];
    }
    if (!option.valid || !option.found || option.value !== true ||
        optionKeys.length !== 1 || optionKeys[0] !== 'bigint') {
      artifactFileLatch(state, 'LIMIT');
      throw ARTIFACT_FILE_FAILURE;
    }
    const stat = await awaitArtifactFileIO(
      state.ports.fs.lstat, state.ports.fs, [path, args[0]],
      state.signal, state, group
    );
    rememberArtifactFileStat(state, group, path, stat);
    const run = group.runsByPath.get(path);
    if (run) {
      const signature = state.statByPath.get(path);
      if (!run.initialStat) run.initialStat = signature;
      else if (!sameArtifactFileStat(run.initialStat, signature)) {
        artifactFileLatch(state, 'FILE_CHANGED');
        throw ARTIFACT_FILE_FAILURE;
      }
    }
    return stat;
  };

  const realpath = async (path, ...args) => {
    requireAllowed(path, group.allowedRealpath);
    if (args.length !== 0) {
      artifactFileLatch(state, 'LIMIT');
      throw ARTIFACT_FILE_FAILURE;
    }
    const resolved = await awaitArtifactFileIO(
      state.ports.fs.realpath, state.ports.fs, [path],
      state.signal, state, group
    );
    if (typeof resolved !== 'string') {
      artifactFileLatch(state, 'FILE_CHANGED');
      throw ARTIFACT_FILE_FAILURE;
    }
    return resolved;
  };

  const closeUnderlying = owner => {
    if (owner.closePromise) return owner.closePromise;
    owner.closeAttempted = true;
    // Publish the one close promise before invoking host code, including
    // against synchronous reentry from a native-like close implementation.
    owner.closePromise = Promise.resolve().then(async () => {
      artifactFileNoteAbort(state.signal, state);
      if (!owner.closeMethod) {
        artifactFileLatch(state, 'CLOSE_FAILED');
        throw ARTIFACT_FILE_CLOSE_FAILURE;
      }
      try {
        await Reflect.apply(owner.closeMethod, owner.handle, []);
      } catch {
        artifactFileLatch(state, 'CLOSE_FAILED');
        artifactFileNoteAbort(state.signal, state);
        throw ARTIFACT_FILE_CLOSE_FAILURE;
      }
      artifactFileNoteAbort(state.signal, state);
    });
    return owner.closePromise;
  };

  const open = async (path, ...args) => {
    const artifact = group.filesByPath.get(path);
    const run = group.runsByPath.get(path);
    if (!artifact || !run || run.openAttempted) {
      artifactFileLatch(state, 'LIMIT');
      throw ARTIFACT_FILE_FAILURE;
    }
    run.openAttempted = true;
    if (!Number.isInteger(constants.O_RDONLY) ||
        !Number.isInteger(constants.O_NOFOLLOW) ||
        !Number.isInteger(constants.O_NONBLOCK) ||
        args.length !== 1 ||
        args[0] !==
          (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) {
      artifactFileLatch(state, 'LIMIT');
      throw ARTIFACT_FILE_FAILURE;
    }
    artifactFileCheckAbort(state.signal, state);

    let handle;
    try {
      handle = await Reflect.apply(
        state.ports.fs.open, state.ports.fs, [path, args[0]]
      );
    } catch {
      group.hostIOFailures++;
      artifactFileLatch(state, 'IO_FAILED');
      artifactFileNoteAbort(state.signal, state);
      throw ARTIFACT_FILE_FAILURE;
    }

    // Ownership begins immediately after open succeeds, before abort or
    // handle validation. Pre-return failures close this handle here once.
    const owner = {
      handle,
      closeMethod: null,
      statMethod: null,
      readMethod: null,
      closeAttempted: false,
      closePromise: null,
      position: 0,
      eofRequested: false
    };

    try {
      owner.closeMethod = artifactFileMethod(handle, 'close');
      artifactFileCheckAbort(state.signal, state);
      owner.statMethod = artifactFileMethod(handle, 'stat');
      owner.readMethod = artifactFileMethod(handle, 'read');
      if (!owner.statMethod || !owner.readMethod) {
        artifactFileLatch(state, 'FILE_CHANGED');
        throw ARTIFACT_FILE_FAILURE;
      }

      const openedStat = await awaitArtifactFileIO(
        owner.statMethod, handle, [{bigint: true}], state.signal, state, group
      );
      let openedSignature;
      try {
        openedSignature = captureArtifactFileStat(
          openedStat, 'file', state.ports.uid, artifact.byte_count
        );
      } catch {
        artifactFileLatch(state, 'FILE_CHANGED');
        throw ARTIFACT_FILE_FAILURE;
      }
      if (!run.initialStat ||
          !sameArtifactFileStat(run.initialStat, openedSignature)) {
        artifactFileLatch(state, 'FILE_CHANGED');
        throw ARTIFACT_FILE_FAILURE;
      }

      const wrappedHandle = {
        stat: trackArtifactFileVerifierBoundary(group, state,
          async (...statArgs) => {
          if (statArgs.length !== 1 || !statArgs[0] ||
              typeof statArgs[0] !== 'object' ||
              types.isProxy(statArgs[0])) {
            artifactFileLatch(state, 'LIMIT');
            throw ARTIFACT_FILE_FAILURE;
          }
          const option = artifactFileDataProperty(statArgs[0], 'bigint');
          if (!option.valid || !option.found || option.value !== true) {
            artifactFileLatch(state, 'LIMIT');
            throw ARTIFACT_FILE_FAILURE;
          }
          const stat = await awaitArtifactFileIO(
            owner.statMethod, handle, statArgs, state.signal, state, group
          );
          let signature;
          try {
            signature = captureArtifactFileStat(
              stat, 'file', state.ports.uid, artifact.byte_count
            );
          } catch {
            artifactFileLatch(state, 'FILE_CHANGED');
            throw ARTIFACT_FILE_FAILURE;
          }
          if (!sameArtifactFileStat(run.initialStat, signature)) {
            artifactFileLatch(state, 'FILE_CHANGED');
            throw ARTIFACT_FILE_FAILURE;
          }
          return stat;
        }),
        read: trackArtifactFileVerifierBoundary(group, state,
          async (buffer, offset, length, position) => {
          let bufferLength;
          try {
            if (!types.isUint8Array(buffer) || types.isProxy(buffer)) {
              throw ARTIFACT_FILE_FAILURE;
            }
            bufferLength = intrinsicByteLength.call(buffer);
          } catch {
            artifactFileLatch(state, 'LIMIT');
            throw ARTIFACT_FILE_FAILURE;
          }
          if (!Number.isSafeInteger(offset) || offset < 0 ||
              !Number.isSafeInteger(length) || length <= 0 ||
              !Number.isSafeInteger(offset + length) ||
              offset + length > bufferLength ||
              !Number.isSafeInteger(position) ||
              position !== owner.position || length > 65_536) {
            artifactFileLatch(state, 'LIMIT');
            throw ARTIFACT_FILE_FAILURE;
          }

          const expected = artifact.byte_count;
          const isEofRead = owner.position === expected;
          if (isEofRead) {
            if (owner.eofRequested || length !== 1 ||
                state.eofReads >= ARTIFACT_COUNT_MAX) {
              artifactFileLatch(state, 'LIMIT');
              throw ARTIFACT_FILE_FAILURE;
            }
            owner.eofRequested = true;
            state.eofReads++;
          } else if (owner.position > expected ||
              length > expected - owner.position ||
              length > state.totalBytes - state.payloadBytes) {
            artifactFileLatch(state, 'LIMIT');
            throw ARTIFACT_FILE_FAILURE;
          }
          state.requestedBytes += length;
          if (!Number.isSafeInteger(state.requestedBytes)) {
            artifactFileLatch(state, 'LIMIT');
            throw ARTIFACT_FILE_FAILURE;
          }

          const result = await awaitArtifactFileIO(
            owner.readMethod, handle,
            [buffer, offset, length, position], state.signal, state, group
          );
          const bytesReadProperty = artifactFileDataProperty(
            result, 'bytesRead'
          );
          const bytesRead = bytesReadProperty.value;
          if (!bytesReadProperty.valid || !bytesReadProperty.found ||
              !Number.isSafeInteger(bytesRead) || bytesRead < 0 ||
              bytesRead > length) {
            artifactFileLatch(state, 'FILE_CHANGED');
            throw ARTIFACT_FILE_FAILURE;
          }
          if (isEofRead) {
            if (bytesRead !== 0) artifactFileLatch(state, 'FILE_CHANGED');
            return result;
          }
          if (bytesRead === 0 ||
              state.payloadBytes + bytesRead > state.totalBytes ||
              owner.position + bytesRead > expected) {
            artifactFileLatch(state, 'FILE_CHANGED');
            return result;
          }
          state.payloadBytes += bytesRead;
          owner.position += bytesRead;
          return result;
        }),
        close: () => closeUnderlying(owner)
      };
      return wrappedHandle;
    } catch {
      try {
        await closeUnderlying(owner);
      } catch {
        // Keep both primary and cleanup failures in the bounded latch.
      }
      throw ARTIFACT_FILE_FAILURE;
    }
  };

  return Object.freeze({
    lstat: trackArtifactFileVerifierBoundary(group, state, lstat),
    realpath: trackArtifactFileVerifierBoundary(group, state, realpath),
    open: trackArtifactFileVerifierBoundary(group, state, open)
  });
}

/**
 * Verify only captured artifact file bytes through unchanged verifyArtifacts.
 * This does not verify a stage manifest, check receipt, check coverage,
 * product correctness, provenance, or native readiness. Filesystem paths and
 * raw errors remain private.
 */
export async function verifyProjectArtifactFilesWithPorts(
  captured, abortSignal, ports
) {
  const captureState = requireCapture(
    captured, 'INVALID_ARTIFACT_CONTEXT'
  );
  const capturedPorts = captureArtifactFilePorts(ports);
  validateArtifactFileSignal(abortSignal);
  const plan = buildArtifactFilePlan(captureState);
  const state = {
    captureState,
    ports: capturedPorts,
    signal: abortSignal,
    failures: new Set(),
    totalBytes: plan.totalBytes,
    payloadBytes: 0,
    requestedBytes: 0,
    eofReads: 0,
    statByPath: new Map(),
    inodeOwners: new Map()
  };
  const verifiedById = new Map();

  if (plan.physicalAlias) {
    artifactFileLatch(state, 'FILE_CHANGED');
    return artifactFileOutput(captureState, state, verifiedById, plan);
  }
  if (artifactFileNoteAbort(abortSignal, state)) {
    return artifactFileOutput(captureState, state, verifiedById, plan);
  }

  for (const group of plan.groups) {
    if (artifactFileNoteAbort(abortSignal, state)) break;
    const specification = Object.freeze({
      job_id: captureState.context.job_id,
      task_scope: group.root,
      provider_id: captureState.config.provider_id,
      requested_model: captureState.config.requested_model,
      max_wall_clock_sec: 1,
      max_steps: 1,
      required_artifacts: Object.freeze(
        group.entries.map(entry => entry.artifact.relative_path)
      )
    });
    const expectedCapture = artifactFileExpectedCapture(captureState, group);
    const io = makeArtifactFileVerifierIO(group, state);
    let result;
    try {
      result = await verifyArtifacts(specification, {
        fs: io,
        signal: abortSignal,
        expected_capture: expectedCapture
      });
    } catch {
      artifactFileLatch(state, 'IO_FAILED');
      artifactFileNoteAbort(abortSignal, state);
      break;
    }
    artifactFileNoteAbort(abortSignal, state);
    artifactFileVerifierFailure(state, group, result);
    const verified = artifactFileDataProperty(result, 'verified');
    const failure = artifactFileDataProperty(result, 'failure');
    if (verified.valid && verified.found &&
        verified.value === true && failure.valid && failure.found &&
        failure.value === null) {
      artifactFileCaptureGroupWitness(
        state, group, result, verifiedById
      );
    }
    if (state.failures.size !== 0) break;
  }
  return artifactFileOutput(captureState, state, verifiedById, plan);
}

const CANDIDATE_STAGE_MANIFEST_BYTES_MAX = 65_536;
const CANDIDATE_STAGE_ABORT = new Error('CANDIDATE_STAGE_ABORT');
const CANDIDATE_STAGE_FAILURE = new Error('CANDIDATE_STAGE_FAILURE');
const CANDIDATE_STAGE_WRITE_FORBIDDEN =
  new Error('CANDIDATE_STAGE_WRITE_FORBIDDEN');
const CANDIDATE_STAGE_BINDING_MISMATCH =
  new Error('CANDIDATE_STAGE_BINDING_MISMATCH');
const CANDIDATE_STAGE_MANIFEST_SCHEMA =
  'squire4.large_project_stage_manifest.v1';
const CANDIDATE_STAGE_VERIFICATION_SCHEMA =
  'squire4.large_project_stage_verification.v1';
const CANDIDATE_STAGE_CLASS_CAPS = Object.freeze({
  SOURCE: Object.freeze({
    count: 25, bytes: 524_288, aggregate: 2_097_152, key: 'source'
  }),
  LOCAL_ASSET: Object.freeze({
    count: 20, bytes: 524_288, aggregate: 2_097_152, key: 'local_asset'
  }),
  DOC: Object.freeze({
    count: 5, bytes: 65_536, aggregate: 131_072, key: 'doc'
  })
});
const CANDIDATE_STAGE_FILE_NAMES = Object.freeze([
  'stage-manifest.json', 'export-manifest.json', 'package-manifest.json'
]);

function candidateStageAborted(signal) {
  if (signal === undefined) return false;
  try {
    return Reflect.apply(ARTIFACT_FILE_ABORTED_GETTER, signal, []) === true;
  } catch {
    return true;
  }
}

function validateCandidateStageSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)) {
    fail('INVALID_ARTIFACT_CONTEXT');
  }

  // Check the complete chain before the intrinsic brand check. The intrinsic
  // getter performs receiver property lookup, which can reach a proxy in the
  // chain even when the receiver itself is an ordinary forged object.
  let current = signal;
  let foundNativePrototype = false;
  while (current !== null) {
    if (types.isProxy(current)) fail('INVALID_ARTIFACT_CONTEXT');
    let descriptor;
    let next;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, 'aborted');
      next = Object.getPrototypeOf(current);
    } catch {
      fail('INVALID_ARTIFACT_CONTEXT');
    }
    if (current === signal && descriptor) {
      fail('INVALID_ARTIFACT_CONTEXT');
    }
    if (current === ARTIFACT_FILE_ABORT_SIGNAL_PROTOTYPE) {
      if (!descriptor || !Object.hasOwn(descriptor, 'get') ||
          descriptor.get !== ARTIFACT_FILE_ABORTED_GETTER) {
        fail('INVALID_ARTIFACT_CONTEXT');
      }
      foundNativePrototype = true;
    } else if (descriptor) {
      fail('INVALID_ARTIFACT_CONTEXT');
    }
    current = next;
  }
  if (!foundNativePrototype) fail('INVALID_ARTIFACT_CONTEXT');

  // Brand-check only after every prototype node has passed the proxy and
  // shadowed-property checks. Operational abort handling remains separate.
  let aborted;
  try {
    aborted = Reflect.apply(ARTIFACT_FILE_ABORTED_GETTER, signal, []);
  } catch {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
  if (typeof aborted !== 'boolean') fail('INVALID_ARTIFACT_CONTEXT');
}

function candidateStageCheckAbort(signal) {
  if (candidateStageAborted(signal)) throw CANDIDATE_STAGE_ABORT;
}

async function candidateStageCall(method, receiver, args, signal) {
  candidateStageCheckAbort(signal);
  let result;
  try {
    result = await Reflect.apply(method, receiver, args);
  } catch (error) {
    candidateStageCheckAbort(signal);
    throw error;
  }
  candidateStageCheckAbort(signal);
  return result;
}

async function wrapCandidateStageHandle(handle, signal) {
  const closeMethod = artifactFileMethod(handle, 'close');
  const statMethod = artifactFileMethod(handle, 'stat');
  const readMethod = artifactFileMethod(handle, 'read');
  let closePromise = null;

  const close = () => {
    if (!closePromise) {
      if (!closeMethod) {
        closePromise = Promise.reject(CANDIDATE_STAGE_FAILURE);
      } else {
        closePromise = (async () => {
          // A close is cleanup: always settle its one real attempt, then report
          // any abort observed before or after that attempt.
          const abortedBeforeClose = candidateStageAborted(signal);
          let result;
          try {
            result = await Reflect.apply(closeMethod, handle, []);
          } catch (error) {
            if (abortedBeforeClose || candidateStageAborted(signal)) {
              throw CANDIDATE_STAGE_ABORT;
            }
            throw error;
          }
          if (abortedBeforeClose || candidateStageAborted(signal)) {
            throw CANDIDATE_STAGE_ABORT;
          }
          return result;
        })();
      }
    }
    return closePromise;
  };

  if (!closeMethod || !statMethod || !readMethod) {
    if (closeMethod) {
      try {
        await close();
      } catch {
        // The stage verifier reports only its fixed corrupt result.
      }
    }
    throw CANDIDATE_STAGE_FAILURE;
  }

  if (candidateStageAborted(signal)) {
    try {
      await close();
    } catch {
      // Keep the abort classification; raw cleanup errors stay private.
    }
    throw CANDIDATE_STAGE_ABORT;
  }

  return Object.freeze({
    stat: (...args) => candidateStageCall(
      statMethod, handle, args, signal
    ),
    read: (...args) => candidateStageCall(
      readMethod, handle, args, signal
    ),
    close
  });
}

function captureCandidateStagePorts(value, stageRoot, signal) {
  const supplied = closedRecord(
    value, ['fs', 'uid', 'readBytes'], 'INVALID_ARTIFACT_CONTEXT'
  );
  const receiver = supplied.fs;
  const methods = closedRecord(receiver, [
    'open', 'mkdir', 'lstat', 'chmod', 'readdir', 'realpath'
  ], 'INVALID_ARTIFACT_CONTEXT');
  const openMethod = methods.open;
  const lstatMethod = methods.lstat;
  const readdirMethod = methods.readdir;
  const realpathMethod = methods.realpath;
  const readBytesMethod = supplied.readBytes;
  const allMethods = [
    openMethod, methods.mkdir, lstatMethod, methods.chmod,
    readdirMethod, realpathMethod, readBytesMethod
  ];
  if (!safeInteger(supplied.uid, 0, Number.MAX_SAFE_INTEGER) ||
      allMethods.some(method =>
        typeof method !== 'function' || types.isProxy(method)
      )) fail('INVALID_ARTIFACT_CONTEXT');

  const forward = method => async (...args) =>
    candidateStageCall(method, receiver, args, signal);
  let controlReads = 0;
  const manifestPath = join(stageRoot, 'stage-manifest.json');
  const readBytes = async (path, maxBytes) => {
    if (path !== manifestPath ||
        maxBytes !== CANDIDATE_STAGE_MANIFEST_BYTES_MAX ||
        controlReads !== 0) throw CANDIDATE_STAGE_FAILURE;
    controlReads++;
    return candidateStageCall(
      readBytesMethod, value,
      [manifestPath, CANDIDATE_STAGE_MANIFEST_BYTES_MAX], signal
    );
  };
  const open = async (...args) => {
    candidateStageCheckAbort(signal);
    let handle;
    try {
      handle = await Reflect.apply(openMethod, receiver, args);
    } catch (error) {
      candidateStageCheckAbort(signal);
      throw error;
    }
    // Capture cleanup and operation methods immediately after acquisition.
    return wrapCandidateStageHandle(handle, signal);
  };
  const fs = Object.freeze({
    open,
    mkdir: async () => { throw CANDIDATE_STAGE_WRITE_FORBIDDEN; },
    lstat: forward(lstatMethod),
    chmod: async () => { throw CANDIDATE_STAGE_WRITE_FORBIDDEN; },
    readdir: forward(readdirMethod),
    realpath: forward(realpathMethod)
  });
  return Object.freeze({fs, uid: supplied.uid, readBytes});
}

function candidateStageOutput(
  verified, stageOperationId, manifestSha256, stagedArtifacts, reason
) {
  return deepFreeze({
    verification_scope: 'CANDIDATE_STAGE_ONLY',
    verified,
    stage_operation_id: stageOperationId,
    stage_manifest_sha256: manifestSha256,
    staged_artifacts: stagedArtifacts,
    reason
  });
}

function candidateStageFailure(reason) {
  return candidateStageOutput(false, null, null, [], reason);
}

function candidateStageArray(value, max, code) {
  if (types.isProxy(value) || !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!safeInteger(length, 0, max)) fail(code);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (keys.length !== length + 1) fail(code);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(code);
  }
  return result;
}

function candidateStageRelative(value) {
  if (typeof value !== 'string' || value.length < 1 ||
      value.length > 256 ||
      !/^[A-Za-z0-9._/-]+$/.test(value) ||
      value.startsWith('/') || value.endsWith('/')) return false;
  const parts = value.split('/');
  if (parts.length > 7 || parts.some(part =>
    !part || part === '.' || part === '..' || part.length > 64 ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
    CANDIDATE_STAGE_FILE_NAMES.includes(part.toLowerCase())
  )) return false;
  return !['project', 'evidence', 'frames'].includes(parts[0].toLowerCase());
}

function validateCandidateStageProfile(value, config, code) {
  const keys = Reflect.ownKeys(config.output_profile);
  const profile = closedRecord(value, keys, code);
  for (const key of keys) {
    if (profile[key] !== config.output_profile[key]) fail(code);
  }
}

function validateCandidateStageManifest(value, config, summary) {
  const code = 'STAGE_CORRUPT_OR_INCOMPLETE';
  const manifest = closedRecord(value, [
    'schema_version', 'output_profile', 'stage_operation_id',
    'caller_label', 'file_counts', 'file_count', 'total_bytes', 'files'
  ], code);
  if (manifest.schema_version !== CANDIDATE_STAGE_MANIFEST_SCHEMA ||
      typeof manifest.stage_operation_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(manifest.stage_operation_id) ||
      typeof manifest.caller_label !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(manifest.caller_label)) fail(code);
  validateCandidateStageProfile(manifest.output_profile, config, code);

  const counts = closedRecord(
    manifest.file_counts, ['source', 'local_asset', 'doc'], code
  );
  for (const limits of Object.values(CANDIDATE_STAGE_CLASS_CAPS)) {
    if (!safeInteger(counts[limits.key], 0, limits.count)) fail(code);
  }
  const files = candidateStageArray(manifest.files, 50, code);
  if (!safeInteger(manifest.file_count, 0, 50) ||
      manifest.file_count !== files.length ||
      !safeInteger(manifest.total_bytes, 0, 4_194_304) ||
      manifest.stage_operation_id !== summary.stage_operation_id) fail(code);

  const seenPaths = new Set();
  const directorySpellings = new Map();
  const actualCounts = {source: 0, local_asset: 0, doc: 0};
  const actualBytes = {source: 0, local_asset: 0, doc: 0};
  let totalBytes = 0;
  const metadata = [];
  for (const entryValue of files) {
    const entry = closedRecord(entryValue, [
      'path', 'classification', 'bytes', 'sha256'
    ], code);
    const limits = CANDIDATE_STAGE_CLASS_CAPS[entry.classification];
    if (!limits || !candidateStageRelative(entry.path) ||
        !safeInteger(entry.bytes, 0, limits.bytes) ||
        entry.classification === 'SOURCE' && entry.bytes === 0 ||
        !isSha(entry.sha256)) fail(code);
    const folded = entry.path.toLowerCase();
    if (seenPaths.has(folded) || directorySpellings.has(folded)) fail(code);
    seenPaths.add(folded);
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/');
      const key = directory.toLowerCase();
      if (seenPaths.has(key)) fail(code);
      const spelling = directorySpellings.get(key);
      if (spelling !== undefined && spelling !== directory) fail(code);
      directorySpellings.set(key, directory);
    }
    const count = ++actualCounts[limits.key];
    actualBytes[limits.key] += entry.bytes;
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(count) ||
        !Number.isSafeInteger(actualBytes[limits.key]) ||
        !Number.isSafeInteger(totalBytes) ||
        count > limits.count ||
        actualBytes[limits.key] > limits.aggregate ||
        totalBytes > 4_194_304) fail(code);
    metadata.push(Object.freeze({
      path: entry.path,
      classification: entry.classification,
      bytes: entry.bytes,
      sha256: entry.sha256
    }));
  }
  for (const key of ['source', 'local_asset', 'doc']) {
    if (counts[key] !== actualCounts[key]) fail(code);
  }
  if (totalBytes !== manifest.total_bytes ||
      summary.file_count !== files.length ||
      summary.total_bytes !== totalBytes) fail(code);

  return Object.freeze({
    stage_operation_id: manifest.stage_operation_id,
    files: Object.freeze(metadata)
  });
}

function candidateStageVerifiedSummary(value, config) {
  const status = artifactFileDataProperty(value, 'status');
  if (!status.valid || !status.found ||
      status.value !== 'VERIFIED') return null;
  const summary = closedRecord(value, [
    'schema_version', 'status', 'output_profile', 'stage_operation_id',
    'caller_label', 'manifest_sha256', 'file_count', 'total_bytes',
    'original_operation_acknowledgement', 'exit_code',
    'provenance_authenticity', 'crash_durability'
  ], 'STAGE_CORRUPT_OR_INCOMPLETE');
  if (summary.schema_version !== CANDIDATE_STAGE_VERIFICATION_SCHEMA ||
      summary.status !== 'VERIFIED' ||
      typeof summary.stage_operation_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(summary.stage_operation_id) ||
      typeof summary.caller_label !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(summary.caller_label) ||
      !isSha(summary.manifest_sha256) ||
      !safeInteger(summary.file_count, 0, 50) ||
      !safeInteger(summary.total_bytes, 0, 4_194_304) ||
      summary.original_operation_acknowledgement !== 'UNKNOWN' ||
      summary.exit_code !== 0 ||
      summary.provenance_authenticity !== 'NOT_ESTABLISHED' ||
      summary.crash_durability !== 'NOT_ESTABLISHED') {
    fail('STAGE_CORRUPT_OR_INCOMPLETE');
  }
  validateCandidateStageProfile(
    summary.output_profile, config, 'STAGE_CORRUPT_OR_INCOMPLETE'
  );
  return summary;
}

function copyCandidateStageManifestBytes(value) {
  const code = 'STAGE_CORRUPT_OR_INCOMPLETE';
  if (types.isProxy(value) || !types.isUint8Array(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype) fail(code);
  let length;
  try {
    length = Reflect.apply(intrinsicByteLength, value, []);
  } catch {
    fail(code);
  }
  if (!safeInteger(length, 0, CANDIDATE_STAGE_MANIFEST_BYTES_MAX)) fail(code);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (keys.length !== length ||
      keys.some((key, index) => key !== String(index))) fail(code);
  const copy = new Uint8Array(length);
  try {
    Uint8Array.prototype.set.call(copy, value);
  } catch {
    copy.fill(0);
    fail(code);
  }
  return copy;
}

/**
 * Verify the captured candidate stage through unchanged verifyLargeProjectStage
 * and bind its bounded manifest reread to the captured staged-artifact subset.
 * This does not verify delivered copies, check receipts, coverage, provenance,
 * product correctness, or native readiness.
 */
export async function verifyProjectArtifactStageWithPorts(
  captured, abortSignal, ports
) {
  let captureState;
  let capturedPorts;
  try {
    captureState = requireCapture(
      captured, 'INVALID_ARTIFACT_CONTEXT'
    );
    validateCandidateStageSignal(abortSignal);
    capturedPorts = captureCandidateStagePorts(
      ports, captureState.context.candidate.stage_root, abortSignal
    );
  } catch (error) {
    if (error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'INVALID_ARTIFACT_CONTEXT') throw error;
    fail('INVALID_ARTIFACT_CONTEXT');
  }

  const candidate = captureState.context.candidate;
  if (candidateStageAborted(abortSignal)) {
    return candidateStageFailure('ABORTED');
  }

  let verification;
  try {
    // The frozen verifier reads p.signal?.aborted after its awaits. Do not give
    // it the caller's mutable signal surface. Every projected IO wrapper above
    // checks the genuine captured intrinsic before and after its await; close
    // always settles before an abort is reduced to the fixed stage result.
    verification = await verifyLargeProjectStage(
      candidate.stage_root,
      {
        fs: capturedPorts.fs,
        uid: capturedPorts.uid
      }
    );
  } catch {
    return candidateStageFailure(
      candidateStageAborted(abortSignal)
        ? 'ABORTED'
        : 'STAGE_CORRUPT_OR_INCOMPLETE'
    );
  }
  if (candidateStageAborted(abortSignal)) {
    return candidateStageFailure('ABORTED');
  }

  const status = artifactFileDataProperty(verification, 'status');
  if (!status.valid || !status.found ||
      status.value !== 'VERIFIED') {
    return candidateStageFailure(
      candidateStageAborted(abortSignal)
        ? 'ABORTED'
        : 'STAGE_CORRUPT_OR_INCOMPLETE'
    );
  }

  let summary;
  try {
    summary = candidateStageVerifiedSummary(
      verification, captureState.config
    );
  } catch {
    return candidateStageFailure('STAGE_CORRUPT_OR_INCOMPLETE');
  }
  if (!summary ||
      summary.stage_operation_id !== candidate.stage_operation_id ||
      summary.manifest_sha256 !== candidate.stage_manifest_sha256) {
    return candidateStageFailure('BINDING_MISMATCH');
  }

  let manifestBytes = null;
  try {
    const value = await capturedPorts.readBytes(
      join(candidate.stage_root, 'stage-manifest.json'),
      CANDIDATE_STAGE_MANIFEST_BYTES_MAX
    );
    manifestBytes = copyCandidateStageManifestBytes(value);
  } catch {
    return candidateStageFailure(
      candidateStageAborted(abortSignal)
        ? 'ABORTED'
        : 'STAGE_CORRUPT_OR_INCOMPLETE'
    );
  }

  try {
    if (candidateStageAborted(abortSignal)) {
      return candidateStageFailure('ABORTED');
    }
    const manifestSha256 = hash(manifestBytes);
    if (manifestSha256 !== summary.manifest_sha256 ||
        manifestSha256 !== candidate.stage_manifest_sha256) {
      return candidateStageFailure('BINDING_MISMATCH');
    }

    const document = parseDocument(
      manifestBytes, 'STAGE_CORRUPT_OR_INCOMPLETE'
    );
    const manifest = validateCandidateStageManifest(
      document, captureState.config, summary
    );
    const manifestByPath = new Map(
      manifest.files.map(entry => [entry.path, entry])
    );
    const staged = captureState.context.artifacts
      .filter(artifact => artifact.role === 'staged')
      .sort((left, right) => asciiCompare(
        left.artifact_id, right.artifact_id
      ));
    const stagedArtifacts = [];
    for (const artifact of staged) {
      if (artifact.root !== candidate.stage_root ||
          artifact.relative_path === 'stage-manifest.json') {
        throw CANDIDATE_STAGE_BINDING_MISMATCH;
      }
      const member = manifestByPath.get(artifact.relative_path);
      if (!member || member.bytes !== artifact.byte_count ||
          member.sha256 !== artifact.sha256) {
        throw CANDIDATE_STAGE_BINDING_MISMATCH;
      }
      stagedArtifacts.push({
        artifact_id: artifact.artifact_id,
        role: 'staged',
        relative_path: artifact.relative_path,
        byte_count: artifact.byte_count,
        sha256: artifact.sha256,
        staged_artifact_id: null
      });
    }
    if (candidateStageAborted(abortSignal)) {
      return candidateStageFailure('ABORTED');
    }
    return candidateStageOutput(
      true, summary.stage_operation_id,
      summary.manifest_sha256, stagedArtifacts, 'NONE'
    );
  } catch (error) {
    if (candidateStageAborted(abortSignal)) {
      return candidateStageFailure('ABORTED');
    }
    return candidateStageFailure(
      error === CANDIDATE_STAGE_BINDING_MISMATCH
        ? 'BINDING_MISMATCH'
        : 'STAGE_CORRUPT_OR_INCOMPLETE'
    );
  } finally {
    manifestBytes.fill(0);
  }
}

// Internal resolver only. Direct import does not verify this module's source
// pins before import; the later fixed public bootstrap owns that guarantee.
const SIDECAR_SCHEMA = 'squire.project_artifact_check_sidecar.v2';
const SIDECAR_PROVENANCE =
  'TRUSTED_CALLER_EVIDENCE_NOT_CRYPTOGRAPHICALLY_ESTABLISHED';
const SIDECAR_IO = Object.freeze([
  'ABORTED', 'CLOSE_FAILED', 'FILE_CHANGED', 'IO_FAILED', 'LIMIT'
]);
const SIDECAR_REASON_ORDER = Object.freeze([
  'CLOSE_FAILED', 'ABORTED', 'ARTIFACT_LIMIT', 'ARTIFACT_CHANGED',
  'ARTIFACT_IO', 'STAGE_CORRUPT_OR_INCOMPLETE', 'MISSING_EVIDENCE',
  'INVALID_EVIDENCE', 'BINDING_MISMATCH', 'ROLE_INSUFFICIENT',
  'TERMINAL_INCOMPLETE', 'CHECK_FAILED', 'CHECK_UNAVAILABLE',
  'EXPLICIT_NOT_RUN', 'NONE'
]);
const SIDECAR_UNRESOLVED_REASONS = new Set([
  'CLOSE_FAILED', 'ABORTED', 'ARTIFACT_LIMIT', 'ARTIFACT_CHANGED',
  'ARTIFACT_IO', 'STAGE_CORRUPT_OR_INCOMPLETE', 'MISSING_EVIDENCE',
  'INVALID_EVIDENCE', 'BINDING_MISMATCH', 'ROLE_INSUFFICIENT',
  'TERMINAL_INCOMPLETE'
]);
const SIDECAR_LIMITATIONS = Object.freeze([
  'DESCENDANTS_NOT_ESTABLISHED', 'HOST_IO_NOT_PREEMPTIBLE',
  'NATIVE_NOT_EXECUTED_BY_RESOLVER', 'PRODUCT_NOT_EVALUATED',
  'STAGE_ACKNOWLEDGEMENT_UNKNOWN', 'TRUSTED_CALLER_ORIGIN'
]);
const SIDECAR_FS_KEYS = Object.freeze([
  'open', 'mkdir', 'lstat', 'chmod', 'readdir', 'realpath'
]);
const SIDECAR_KEYS = Object.freeze([
  'schema', 'job_id', 'operation_config_sha256', 'source_commit',
  'stage_manifest_sha256', 'artifact_witness', 'check_results', 'coverage',
  'reason', 'io_failures', 'limitations', 'task_correctness',
  'task_outcome_evaluated', 'provenance_authenticity'
]);
const SIDECAR_CHECK_KEYS = Object.freeze([
  'check_id', 'status', 'reason', 'artifact_subset_sha256',
  'evidence_binding', 'observer_role'
]);
const SIDECAR_WITNESS_KEYS = Object.freeze([
  'artifact_id', 'role', 'relative_path', 'byte_count', 'sha256',
  'staged_artifact_id'
]);
const SIDECAR_ABORT = new Error('SIDECAR_ABORT');
const SIDECAR_FAILURE = new Error('SIDECAR_FAILURE');
const SIDECAR_CLOSE_FAILURE = new Error('SIDECAR_CLOSE_FAILURE');

function sidecarCapturePorts(value) {
  const supplied = closedRecord(
    value, ['fs', 'uid', 'readBytes', 'verifyFile', 'reads'],
    'INVALID_ARTIFACT_CONTEXT'
  );
  const fsReceiver = supplied.fs;
  const fs = closedRecord(fsReceiver, SIDECAR_FS_KEYS,
    'INVALID_ARTIFACT_CONTEXT');
  const readsReceiver = supplied.reads;
  const reads = closedRecord(
    readsReceiver, ['lstat', 'readChunks'], 'INVALID_ARTIFACT_CONTEXT'
  );
  const methods = [
    ...SIDECAR_FS_KEYS.map(key => fs[key]),
    supplied.readBytes, supplied.verifyFile, reads.lstat, reads.readChunks
  ];
  if (!safeInteger(supplied.uid, 0, Number.MAX_SAFE_INTEGER) ||
      methods.some(method =>
        typeof method !== 'function' || types.isProxy(method)
      )) fail('INVALID_ARTIFACT_CONTEXT');
  return Object.freeze({
    receiver: value,
    fsReceiver,
    fs: Object.freeze({...fs}),
    uid: supplied.uid,
    readBytes: supplied.readBytes,
    verifyFile: supplied.verifyFile,
    readsReceiver,
    reads: Object.freeze({...reads})
  });
}

function sidecarAdd(state, local, reason, io = null) {
  if (reason) {
    state.reasons.add(reason);
    local?.add(reason);
  }
  if (io) state.ioFailures.add(io);
}

function sidecarReason(reasons) {
  for (const reason of SIDECAR_REASON_ORDER) {
    if (reasons.has(reason)) return reason;
  }
  return 'NONE';
}

function sidecarFixedCode(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function sidecarCaught(state, local, error) {
  if (error === SIDECAR_ABORT) {
    sidecarAdd(state, local, 'ABORTED', 'ABORTED');
  } else if (error === SIDECAR_FAILURE) {
    // The originating guard recorded its fixed cause before throwing.
  } else if (error === SIDECAR_CLOSE_FAILURE) {
    sidecarAdd(state, local, 'CLOSE_FAILED', 'CLOSE_FAILED');
  } else if (sidecarFixedCode(error) === 'ENOENT') {
    sidecarAdd(state, local, 'MISSING_EVIDENCE');
  } else {
    // Record every actual exception occurrence, including falsy thrown values.
    sidecarAdd(state, local, 'ARTIFACT_IO', 'IO_FAILED');
  }
}

function sidecarCheckAbort(signal, state, local = null) {
  if (candidateStageAborted(signal)) {
    sidecarAdd(state, local, 'ABORTED', 'ABORTED');
    throw SIDECAR_ABORT;
  }
}

async function sidecarAwait(state, local, signal, operation) {
  sidecarCheckAbort(signal, state, local);
  let value;
  try {
    value = await operation();
  } catch (error) {
    sidecarCaught(state, local, error);
    throw SIDECAR_FAILURE;
  }
  sidecarCheckAbort(signal, state, local);
  return value;
}

function sidecarIOReason(code) {
  return ({
    ABORTED: 'ABORTED',
    CLOSE_FAILED: 'CLOSE_FAILED',
    FILE_CHANGED: 'ARTIFACT_CHANGED',
    IO_FAILED: 'ARTIFACT_IO',
    LIMIT: 'ARTIFACT_LIMIT'
  })[code];
}

function sidecarReasonsFromIO(codes) {
  const result = new Set();
  for (const code of codes) {
    const reason = sidecarIOReason(code);
    if (reason) result.add(reason);
  }
  return result;
}

function sidecarPathInRoots(path, roots) {
  return roots.some(root => withinPath(path, root));
}

function sidecarStat(stat, uid, expectedBytes) {
  if (!stat || typeof stat !== 'object' || types.isProxy(stat)) return null;
  const fields = Object.create(null);
  for (const key of ARTIFACT_FILE_BYTE_FIELDS) {
    const property = artifactFileDataProperty(stat, key);
    if (!property.valid || !property.found ||
        typeof property.value !== 'bigint') return null;
    fields[key] = property.value;
  }
  const uidProperty = artifactFileDataProperty(stat, 'uid');
  const linksProperty = artifactFileDataProperty(stat, 'nlink');
  const isFile = artifactFileMethod(stat, 'isFile');
  const isDirectory = artifactFileMethod(stat, 'isDirectory');
  const isSymbolicLink = artifactFileMethod(stat, 'isSymbolicLink');
  if (!uidProperty.valid || !uidProperty.found ||
      !linksProperty.valid || !linksProperty.found ||
      !isFile || !isDirectory || !isSymbolicLink) return null;
  let file;
  let directory;
  let symbolicLink;
  try {
    file = Reflect.apply(isFile, stat, []);
    directory = Reflect.apply(isDirectory, stat, []);
    symbolicLink = Reflect.apply(isSymbolicLink, stat, []);
  } catch {
    return null;
  }
  const owner = typeof uidProperty.value === 'bigint'
    ? uidProperty.value >= 0n && uidProperty.value === BigInt(uid)
    : Number.isSafeInteger(uidProperty.value) &&
      uidProperty.value >= 0 && uidProperty.value === uid;
  const singleLink = typeof linksProperty.value === 'bigint'
    ? linksProperty.value === 1n
    : Number.isSafeInteger(linksProperty.value) && linksProperty.value === 1;
  if (file !== true || directory !== false || symbolicLink !== false ||
      !owner || !singleLink || fields.size !== BigInt(expectedBytes)) return null;
  return Object.freeze({
    fields: Object.freeze(fields),
    uid: uidProperty.value,
    nlink: linksProperty.value,
    file,
    directory,
    symbolicLink
  });
}

function sidecarSameStat(left, right) {
  return Boolean(left && right &&
    ARTIFACT_FILE_BYTE_FIELDS.every(key =>
      left.fields[key] === right.fields[key]
    ) && left.uid === right.uid && left.nlink === right.nlink &&
    left.file === right.file && left.directory === right.directory &&
    left.symbolicLink === right.symbolicLink);
}

async function sidecarPhysicalStat(
  identity, ports, signal, state, local
) {
  let stat;
  try {
    stat = await sidecarAwait(state, local, signal, () =>
      Reflect.apply(ports.fs.lstat, ports.fsReceiver, [
        identity.path, {bigint: true}
      ])
    );
  } catch {
    return null;
  }
  const signature = sidecarStat(stat, ports.uid, identity.bytes);
  if (!signature) {
    sidecarAdd(state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
    return null;
  }
  return signature;
}

async function sidecarEvidenceBefore(
  identity, roots, ports, signal, state, local
) {
  const stat = await sidecarPhysicalStat(
    identity, ports, signal, state, local
  );
  if (!stat) return null;
  let canonical;
  try {
    canonical = await sidecarAwait(state, local, signal, () =>
      Reflect.apply(ports.fs.realpath, ports.fsReceiver, [identity.path])
    );
  } catch {
    return null;
  }
  if (!pathValue(canonical)) {
    sidecarAdd(state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
    return null;
  }
  if (sidecarPathInRoots(canonical, roots)) {
    sidecarAdd(state, local, 'BINDING_MISMATCH');
    return null;
  }
  return Object.freeze({stat, canonical});
}

async function sidecarEvidenceAfter(
  identity, roots, ports, signal, state, local, before
) {
  const stat = await sidecarPhysicalStat(
    identity, ports, signal, state, local
  );
  if (!stat) return false;
  let canonical;
  try {
    canonical = await sidecarAwait(state, local, signal, () =>
      Reflect.apply(ports.fs.realpath, ports.fsReceiver, [identity.path])
    );
  } catch {
    return false;
  }
  if (!pathValue(canonical) || sidecarPathInRoots(canonical, roots)) {
    sidecarAdd(state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
    return false;
  }
  if (!sidecarSameStat(before.stat, stat) ||
      before.canonical !== canonical) {
    sidecarAdd(state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
    return false;
  }
  return true;
}

function sidecarCopyControl(value, state, local) {
  try {
    return copyBytes(value, RECEIPT_BYTES_MAX,
      'INVALID_EVIDENCE', 'ARTIFACT_LIMIT');
  } catch (error) {
    if (error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'ARTIFACT_LIMIT') {
      sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
    } else {
      sidecarAdd(state, local, 'INVALID_EVIDENCE');
    }
    return null;
  }
}

async function sidecarReadControl(
  identity, roots, ports, signal, state, local
) {
  const before = await sidecarEvidenceBefore(
    identity, roots, ports, signal, state, local
  );
  if (!before) return null;
  let value;
  try {
    value = await sidecarAwait(state, local, signal, () => {
      if (identity.bytes > RECEIPT_BYTES_MAX) {
        sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
        throw SIDECAR_FAILURE;
      }
      return Reflect.apply(ports.readBytes, ports.receiver, [
        identity.path, identity.bytes
      ]);
    });
  } catch {
    return null;
  }
  const bytes = sidecarCopyControl(value, state, local);
  if (!bytes) {
    await sidecarEvidenceAfter(
      identity, roots, ports, signal, state, local, before
    );
    return null;
  }
  const matches = bytes.length === identity.bytes &&
    hash(bytes) === identity.sha256;
  if (!matches) sidecarAdd(state, local, 'INVALID_EVIDENCE');
  const after = await sidecarEvidenceAfter(
    identity, roots, ports, signal, state, local, before
  );
  if (!matches || !after) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

function sidecarMethod(value, key, required = true) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) {
    throw SIDECAR_FAILURE;
  }
  for (let current = value; current !== null;) {
    if (types.isProxy(current)) throw SIDECAR_FAILURE;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      throw SIDECAR_FAILURE;
    }
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'function' ||
          types.isProxy(descriptor.value)) throw SIDECAR_FAILURE;
      return descriptor.value;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      throw SIDECAR_FAILURE;
    }
  }
  if (required) throw SIDECAR_FAILURE;
  return null;
}

function sidecarStreamGuard(state, local) {
  sidecarAdd(state, local, 'INVALID_EVIDENCE');
  throw SIDECAR_FAILURE;
}

function sidecarStreamMethod(value, key, state, local, required = true) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) {
    sidecarStreamGuard(state, local);
  }
  for (let current = value; current !== null;) {
    if (types.isProxy(current)) sidecarStreamGuard(state, local);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      sidecarStreamGuard(state, local);
    }
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'function' ||
          types.isProxy(descriptor.value)) {
        sidecarStreamGuard(state, local);
      }
      return descriptor.value;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      sidecarStreamGuard(state, local);
    }
  }
  if (required) sidecarStreamGuard(state, local);
  return null;
}

function sidecarIteratorResult(value, state, local) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      types.isProxy(value)) sidecarStreamGuard(state, local);
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    sidecarStreamGuard(state, local);
  }
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.some(key => key !== 'done' && key !== 'value')) {
    sidecarStreamGuard(state, local);
  }
  const done = Object.getOwnPropertyDescriptor(value, 'done');
  const chunk = Object.getOwnPropertyDescriptor(value, 'value');
  if (!done || !Object.hasOwn(done, 'value') ||
      typeof done.value !== 'boolean' ||
      chunk && !Object.hasOwn(chunk, 'value') ||
      !done.value && (!chunk || !types.isUint8Array(chunk.value) ||
        types.isProxy(chunk.value))) sidecarStreamGuard(state, local);
  return {done: done.value, value: chunk?.value};
}

function sidecarCloseIterator(owner, signal, state, local) {
  if (!owner || owner.completed) {
    return owner?.closePromise ?? Promise.resolve();
  }
  if (owner.closePromise) return owner.closePromise;
  owner.closePromise = Promise.resolve().then(async () => {
    if (candidateStageAborted(signal)) {
      sidecarAdd(state, local, 'ABORTED', 'ABORTED');
    }
    if (!owner.returnMethod) {
      sidecarAdd(state, local, 'CLOSE_FAILED', 'CLOSE_FAILED');
      throw SIDECAR_CLOSE_FAILURE;
    }
    try {
      const pending = Reflect.apply(owner.returnMethod, owner.iterator, []);
      const result = sidecarIteratorResult(await pending, state, local);
      if (!result.done) throw SIDECAR_CLOSE_FAILURE;
      if (candidateStageAborted(signal)) {
        sidecarAdd(state, local, 'ABORTED', 'ABORTED');
      }
      return result;
    } catch (error) {
      if (error !== SIDECAR_CLOSE_FAILURE) sidecarCaught(state, local, error);
      sidecarAdd(state, local, 'CLOSE_FAILED', 'CLOSE_FAILED');
      throw SIDECAR_CLOSE_FAILURE;
    }
  });
  return owner.closePromise;
}

function sidecarDefinitionReader(identity, ports, signal, state, local) {
  const stream = {
    requested: false, factoryUsed: false, owner: null, chunks: [],
    total: 0, eof: false, pending: new Set()
  };
  const track = pending => {
    stream.pending.add(pending);
    pending.then(
      () => stream.pending.delete(pending),
      () => stream.pending.delete(pending)
    );
    return pending;
  };
  const reads = Object.freeze({
    lstat(path) {
      if (path !== identity.path) {
        sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
        return track(Promise.reject(SIDECAR_FAILURE));
      }
      const pending = sidecarAwait(state, local, signal, () =>
        Reflect.apply(ports.reads.lstat, ports.readsReceiver, [path])
      ).then(stat => {
        const size = artifactFileDataProperty(stat, 'size');
        const file = artifactFileMethod(stat, 'isFile');
        const directory = artifactFileMethod(stat, 'isDirectory');
        const link = artifactFileMethod(stat, 'isSymbolicLink');
        let isFile;
        let isDirectory;
        let isLink;
        try {
          isFile = file && Reflect.apply(file, stat, []);
          isDirectory = directory && Reflect.apply(directory, stat, []);
          isLink = link && Reflect.apply(link, stat, []);
        } catch {
          isFile = false;
        }
        if (!size.valid || !size.found ||
            !Number.isSafeInteger(size.value) ||
            size.value !== identity.bytes || isFile !== true ||
            isDirectory !== false || isLink !== false) {
          sidecarAdd(state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
          throw SIDECAR_FAILURE;
        }
        return stat;
      }).catch(error => {
        sidecarCaught(state, local, error);
        throw SIDECAR_FAILURE;
      });
      return track(pending);
    },
    readChunks(path) {
      if (path !== identity.path || stream.requested) {
        sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
        throw SIDECAR_FAILURE;
      }
      stream.requested = true;
      let source;
      try {
        sidecarCheckAbort(signal, state, local);
        source = Reflect.apply(
          ports.reads.readChunks, ports.readsReceiver, [path]
        );
      } catch (error) {
        sidecarCaught(state, local, error);
        throw SIDECAR_FAILURE;
      }
      return Object.freeze({
        [Symbol.asyncIterator]() {
          if (stream.factoryUsed) {
            sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
            void sidecarCloseIterator(
              stream.owner, signal, state, local
            ).catch(() => {});
            throw SIDECAR_FAILURE;
          }
          stream.factoryUsed = true;
          try {
            sidecarCheckAbort(signal, state, local);
            const factory = sidecarStreamMethod(
              source, Symbol.asyncIterator, state, local
            );
            const iterator = Reflect.apply(factory, source, []);
            stream.owner = {
              iterator, nextMethod: null, returnMethod: null,
              nextActive: false, completed: false, closePromise: null
            };
            // Capture return first so setup failure can still close the owner.
            stream.owner.returnMethod = sidecarStreamMethod(
              iterator, 'return', state, local, false
            );
            stream.owner.nextMethod = sidecarStreamMethod(
              iterator, 'next', state, local
            );
            sidecarCheckAbort(signal, state, local);
          } catch (error) {
            if (error === SIDECAR_ABORT) {
              sidecarCaught(state, local, error);
            } else {
              sidecarCaught(state, local, error);
            }
            void sidecarCloseIterator(
              stream.owner, signal, state, local
            ).catch(() => {});
          }
          const owner = stream.owner;
          const facade = {
            next(...args) {
              let pending;
              pending = (async () => {
                try {
                  if (!owner || !owner.nextMethod) {
                    throw SIDECAR_FAILURE;
                  }
                  if (owner.completed) return {done: true};
                  if (owner.nextActive) {
                    sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
                    throw SIDECAR_FAILURE;
                  }
                  owner.nextActive = true;
                  try {
                    sidecarCheckAbort(signal, state, local);
                    let raw;
                    try {
                      raw = await Reflect.apply(
                        owner.nextMethod, owner.iterator, args
                      );
                    } catch (error) {
                      sidecarCaught(state, local, error);
                      throw SIDECAR_FAILURE;
                    }
                    sidecarCheckAbort(signal, state, local);
                    const item = sidecarIteratorResult(raw, state, local);
                    if (item.done) {
                      owner.completed = true;
                      stream.eof = true;
                      if (stream.total !== identity.bytes) {
                        sidecarAdd(
                          state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED'
                        );
                        throw SIDECAR_FAILURE;
                      }
                      return {done: true, value: item.value};
                    }
                    let length;
                    try {
                      length = intrinsicByteLength.call(item.value);
                    } catch {
                      sidecarAdd(state, local, 'INVALID_EVIDENCE');
                      throw SIDECAR_FAILURE;
                    }
                    const remaining = identity.bytes - stream.total;
                    if (!Number.isSafeInteger(length) || length === 0) {
                      sidecarAdd(state, local, 'INVALID_EVIDENCE');
                      throw SIDECAR_FAILURE;
                    }
                    if (length > remaining + 1) {
                      sidecarAdd(state, local, 'ARTIFACT_LIMIT', 'LIMIT');
                      throw SIDECAR_FAILURE;
                    }
                    if (length > remaining) {
                      sidecarAdd(
                        state, local, 'ARTIFACT_CHANGED', 'FILE_CHANGED'
                      );
                      throw SIDECAR_FAILURE;
                    }
                    const ownedBytes = new Uint8Array(length);
                    Uint8Array.prototype.set.call(ownedBytes, item.value);
                    stream.chunks.push(ownedBytes);
                    stream.total += length;
                    return {done: false, value: new Uint8Array(ownedBytes)};
                  } finally {
                    owner.nextActive = false;
                  }
                } catch (error) {
                  if (error === SIDECAR_ABORT) {
                    sidecarCaught(state, local, error);
                  } else if (error !== SIDECAR_FAILURE &&
                      error !== SIDECAR_CLOSE_FAILURE) {
                    sidecarCaught(state, local, error);
                  }
                  try {
                    await sidecarCloseIterator(owner, signal, state, local);
                  } catch {
                    // The cleanup occurrence is already in the fixed latch.
                  }
                  throw SIDECAR_FAILURE;
                }
              })();
              return track(pending);
            },
            async return() {
              try {
                return await sidecarCloseIterator(
                  owner, signal, state, local
                );
              } catch {
                throw SIDECAR_FAILURE;
              }
            },
            [Symbol.asyncIterator]() { return this; }
          };
          return facade;
        }
      });
    }
  });
  return {reads, stream};
}

async function sidecarReadDefinition(
  identity, roots, ports, signal, state, local
) {
  const before = await sidecarEvidenceBefore(
    identity, roots, ports, signal, state, local
  );
  if (!before) return null;
  const guarded = sidecarDefinitionReader(
    identity, ports, signal, state, local
  );
  let verification;
  let verifyFailed = false;
  try {
    sidecarCheckAbort(signal, state, local);
    verification = await Reflect.apply(
      ports.verifyFile, ports.receiver, [identity, guarded.reads]
    );
    sidecarCheckAbort(signal, state, local);
  } catch (error) {
    verifyFailed = true;
    sidecarCaught(state, local, error);
  }
  while (guarded.stream.pending.size) {
    await Promise.allSettled([...guarded.stream.pending]);
  }
  if (guarded.stream.owner && !guarded.stream.owner.completed) {
    try {
      await sidecarCloseIterator(
        guarded.stream.owner, signal, state, local
      );
    } catch {
      // Cleanup and the primary stream failure remain separate occurrences.
    }
  }
  const length = guarded.stream.total;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of guarded.stream.chunks) {
    Uint8Array.prototype.set.call(bytes, chunk, offset);
    offset += chunk.length;
    chunk.fill(0);
  }
  guarded.stream.chunks.length = 0;
  let exactIdentity = false;
  try {
    const value = closedRecord(
      verification, ['path', 'bytes', 'sha256'], 'INVALID_EVIDENCE'
    );
    exactIdentity = value.path === identity.path &&
      value.bytes === identity.bytes && value.sha256 === identity.sha256;
  } catch {
    exactIdentity = false;
  }
  const actualStream = guarded.stream.requested &&
    guarded.stream.factoryUsed && guarded.stream.eof &&
    offset === identity.bytes && length === identity.bytes &&
    hash(bytes) === identity.sha256;
  if (!actualStream || !exactIdentity || verifyFailed || local.size !== 0) {
    bytes.fill(0);
    if (!local.size) sidecarAdd(state, local, 'INVALID_EVIDENCE');
    await sidecarEvidenceAfter(
      identity, roots, ports, signal, state, local, before
    );
    return null;
  }
  if (!await sidecarEvidenceAfter(
    identity, roots, ports, signal, state, local, before
  )) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

function sidecarIdentity(pin) {
  return Object.freeze({
    path: pin.path, bytes: pin.bytes, sha256: pin.sha256
  });
}

function sidecarExpected(captured) {
  const capture = requireCapture(captured, 'INVALID_ARTIFACT_CONTEXT');
  return capture.context.required_checks.map(check => ({
    check,
    subset: projectArtifactSubsetHash(captured, check.check_id)
  }));
}

function sidecarCheck(check, subset, status, reason, binding) {
  return Object.freeze({
    check_id: check.check_id,
    status,
    reason,
    artifact_subset_sha256: subset,
    evidence_binding: binding,
    observer_role: 'trusted_owner_fixture'
  });
}

function sidecarReceiptError(error) {
  if (error instanceof ProjectArtifactCheckValidationError &&
      ['BINDING_MISMATCH', 'INVALID_EVIDENCE', 'ROLE_INSUFFICIENT',
        'TERMINAL_INCOMPLETE', 'ARTIFACT_LIMIT'].includes(error.code)) {
    return error.code;
  }
  return 'INVALID_EVIDENCE';
}

function sidecarVerifiedWitness(captured, fileResult) {
  const capture = requireCapture(captured);
  if (!fileResult || fileResult.verified !== true ||
      fileResult.reason !== 'NONE' ||
      fileResult.artifact_witness.length !==
        capture.context.artifacts.length) return null;
  const actual = new Map(
    fileResult.artifact_witness.map(item => [item.artifact_id, item])
  );
  const witness = [];
  for (const artifact of capture.context.artifacts) {
    const item = actual.get(artifact.artifact_id);
    if (!item || item.role !== artifact.role ||
        item.relative_path !== artifact.relative_path ||
        item.byte_count !== artifact.byte_count ||
        item.sha256 !== artifact.sha256 ||
        item.staged_artifact_id !== artifact.staged_artifact_id) return null;
    witness.push({
      artifact_id: artifact.artifact_id,
      role: artifact.role,
      relative_path: artifact.relative_path,
      byte_count: artifact.byte_count,
      sha256: artifact.sha256,
      staged_artifact_id: artifact.staged_artifact_id
    });
  }
  return witness.sort((left, right) =>
    asciiCompare(left.artifact_id, right.artifact_id)
  );
}

function sidecarBuild(capture, witness, checks, coverage, reasons, ioFailures) {
  const allReasons = new Set(reasons);
  for (const check of checks) {
    if (check.reason !== 'NONE') allReasons.add(check.reason);
  }
  for (const reason of sidecarReasonsFromIO(ioFailures)) {
    allReasons.add(reason);
  }
  return deepFreeze({
    schema: SIDECAR_SCHEMA,
    job_id: capture.context.job_id,
    operation_config_sha256: capture.configHash,
    source_commit: capture.context.candidate.source_commit,
    stage_manifest_sha256:
      capture.context.candidate.stage_manifest_sha256,
    artifact_witness: witness,
    check_results: checks,
    coverage,
    reason: coverage === 'DECLARED_CHECKS_PASSED'
      ? 'NONE'
      : sidecarReason(allReasons),
    io_failures: [...ioFailures].sort(asciiCompare),
    limitations: [...SIDECAR_LIMITATIONS],
    task_correctness: 'NOT_EVALUATED',
    task_outcome_evaluated: false,
    provenance_authenticity: SIDECAR_PROVENANCE
  });
}

function sidecarStageProjection(ports, stageRoot) {
  const forward = (method, receiver) => (...args) =>
    Reflect.apply(method, receiver, args);
  const fs = Object.freeze({
    open: forward(ports.fs.open, ports.fsReceiver),
    mkdir: async () => { throw SIDECAR_FAILURE; },
    lstat: forward(ports.fs.lstat, ports.fsReceiver),
    chmod: async () => { throw SIDECAR_FAILURE; },
    readdir: forward(ports.fs.readdir, ports.fsReceiver),
    realpath: forward(ports.fs.realpath, ports.fsReceiver)
  });
  let controlReads = 0;
  const manifestPath = join(stageRoot, 'stage-manifest.json');
  return Object.freeze({
    fs,
    uid: ports.uid,
    readBytes: (...args) => {
      if (args[0] !== manifestPath ||
          args[1] !== CANDIDATE_STAGE_MANIFEST_BYTES_MAX ||
          controlReads++ !== 0) throw SIDECAR_FAILURE;
      return Reflect.apply(ports.readBytes, ports.receiver, args);
    }
  });
}

function sidecarFileProjection(ports, signal, state) {
  const fileCall = async (method, receiver, args, cleanup = false) => {
    if (!cleanup) sidecarCheckAbort(signal, state);
    let value;
    try {
      value = await Reflect.apply(method, receiver, args);
    } catch {
      sidecarAdd(state, null, 'ARTIFACT_IO', 'IO_FAILED');
      if (candidateStageAborted(signal)) {
        sidecarAdd(state, null, 'ABORTED', 'ABORTED');
      }
      throw SIDECAR_FAILURE;
    }
    if (!cleanup) sidecarCheckAbort(signal, state);
    else if (candidateStageAborted(signal)) {
      sidecarAdd(state, null, 'ABORTED', 'ABORTED');
    }
    return value;
  };
  let fileControl = false;
  const guarded = async (method, receiver, args) => {
    try {
      return await fileCall(method, receiver, args);
    } catch (error) {
      if (error === SIDECAR_ABORT) fileControl = true;
      throw error;
    }
  };
  const fs = {
    lstat: (...args) => guarded(ports.fs.lstat, ports.fsReceiver, args),
    realpath: (...args) =>
      guarded(ports.fs.realpath, ports.fsReceiver, args),
    async open(path, ...args) {
      sidecarCheckAbort(signal, state);
      let handle;
      try {
        handle = await Reflect.apply(
          ports.fs.open, ports.fsReceiver, [path, ...args]
        );
      } catch {
        sidecarAdd(state, null, 'ARTIFACT_IO', 'IO_FAILED');
        if (candidateStageAborted(signal)) {
          sidecarAdd(state, null, 'ABORTED', 'ABORTED');
        }
        throw SIDECAR_FAILURE;
      }
      let closeMethod;
      try {
        closeMethod = sidecarMethod(handle, 'close');
      } catch {
        sidecarAdd(state, null, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
      }
      let closePromise = null;
      const close = () => {
        if (!closePromise) {
          closePromise = Promise.resolve().then(async () => {
            if (!closeMethod) {
              sidecarAdd(state, null, 'CLOSE_FAILED', 'CLOSE_FAILED');
              throw SIDECAR_CLOSE_FAILURE;
            }
            try {
              await fileCall(closeMethod, handle, [], true);
            } catch {
              sidecarAdd(state, null, 'CLOSE_FAILED', 'CLOSE_FAILED');
              throw SIDECAR_CLOSE_FAILURE;
            }
          });
        }
        return closePromise;
      };
      if (candidateStageAborted(signal)) {
        fileControl = true;
        sidecarAdd(state, null, 'ABORTED', 'ABORTED');
        try { await close(); } catch {}
        throw SIDECAR_ABORT;
      }
      let statMethod;
      let readMethod;
      try {
        statMethod = sidecarMethod(handle, 'stat');
        readMethod = sidecarMethod(handle, 'read');
      } catch {
        sidecarAdd(state, null, 'ARTIFACT_CHANGED', 'FILE_CHANGED');
        try { await close(); } catch {}
        throw SIDECAR_FAILURE;
      }
      return {
        stat: (...statArgs) =>
          guarded(statMethod, handle, statArgs),
        read: (...readArgs) => guarded(readMethod, handle, readArgs),
        close
      };
    }
  };
  return {
    ports: Object.freeze({fs: Object.freeze(fs), uid: ports.uid}),
    get fileControl() { return fileControl; },
    get hasHostIOFailure() {
      return state.ioFailures.has('IO_FAILED');
    }
  };
}

/**
 * Read-only internal resolver. It uses the accepted pure capture, stage, and
 * artifact helpers; it does not execute checks or authenticate evidence origin.
 * Public lazy-import/source-pin guarantees are supplied by a later bootstrap.
 */
export async function resolveProjectArtifactChecksWithPorts(
  configBytes, artifactContextBytes, abortSignal, ports
) {
  let captured;
  let capture;
  let capturedPorts;
  let expected;
  try {
    captured = captureProjectArtifactCheckData({
      configBytes, artifactContextBytes
    });
    capture = requireCapture(captured, 'INVALID_ARTIFACT_CONTEXT');
    capturedPorts = sidecarCapturePorts(ports);
    validateCandidateStageSignal(abortSignal);
    expected = sidecarExpected(captured);
  } catch {
    fail('INVALID_ARTIFACT_CONTEXT');
  }

  const state = {reasons: new Set(), ioFailures: new Set()};
  const unresolved = reason => expected.map(item =>
    sidecarCheck(item.check, item.subset, 'blocked', reason, 'unresolved')
  );
  const stageRoot = capture.context.candidate.stage_root;
  let stage;
  try {
    stage = await verifyProjectArtifactStageWithPorts(
      captured, abortSignal,
      sidecarStageProjection(capturedPorts, stageRoot)
    );
  } catch {
    stage = null;
  }
  if (!stage || stage.verified !== true || stage.reason !== 'NONE' ||
      stage.stage_operation_id !==
        capture.context.candidate.stage_operation_id ||
      stage.stage_manifest_sha256 !==
        capture.context.candidate.stage_manifest_sha256) {
    const reason = stage?.reason === 'ABORTED'
      ? 'ABORTED'
      : stage?.reason === 'BINDING_MISMATCH'
        ? 'BINDING_MISMATCH'
        : 'STAGE_CORRUPT_OR_INCOMPLETE';
    state.reasons.add(reason);
    if (reason === 'ABORTED') state.ioFailures.add('ABORTED');
    const sidecar = sidecarBuild(
      capture, [], unresolved(reason), 'BLOCKED',
      state.reasons, state.ioFailures
    );
    return Object.freeze({
      sidecar, bytes: encodeProjectArtifactCheckSidecar(sidecar)
    });
  }

  // The accepted file helper requires exactly {lstat, realpath, open}.
  // Its signal parameter is omitted: these captured wrappers check the
  // intrinsic around actual IO without exposing a caller getter to verifyArtifacts.
  const fileProjection = sidecarFileProjection(
    capturedPorts, abortSignal, state
  );
  let fileResult;
  try {
    fileResult = await verifyProjectArtifactFilesWithPorts(
      captured, undefined, fileProjection.ports
    );
  } catch {
    fileResult = null;
  }
  const witness = sidecarVerifiedWitness(captured, fileResult);
  if (!witness || fileResult.io_failures.length !== 0 ||
      state.ioFailures.size !== 0) {
    for (const code of fileResult?.io_failures ?? []) {
      if (!SIDECAR_IO.includes(code)) continue;
      if (code === 'IO_FAILED' && fileProjection.fileControl &&
          !fileProjection.hasHostIOFailure) continue;
      state.ioFailures.add(code);
    }
    if (candidateStageAborted(abortSignal)) {
      state.reasons.add('ABORTED');
      state.ioFailures.add('ABORTED');
    }
    if (state.ioFailures.size === 0) {
      state.reasons.add(fileResult?.reason === 'ARTIFACT_CHANGED'
        ? 'ARTIFACT_CHANGED' : 'ARTIFACT_IO');
      if (fileResult?.reason !== 'ARTIFACT_CHANGED') {
        state.ioFailures.add('IO_FAILED');
      }
    }
    const reason = sidecarReason(new Set([
      ...state.reasons, ...sidecarReasonsFromIO(state.ioFailures)
    ]));
    const sidecar = sidecarBuild(
      capture, [], unresolved(reason), 'BLOCKED',
      state.reasons, state.ioFailures
    );
    return Object.freeze({
      sidecar, bytes: encodeProjectArtifactCheckSidecar(sidecar)
    });
  }

  const roots = capture.context.artifacts.map(item => item.root);
  const results = [];
  for (let index = 0; index < expected.length; index++) {
    const item = expected[index];
    if (candidateStageAborted(abortSignal) ||
        state.ioFailures.has('ABORTED') ||
        state.ioFailures.has('LIMIT')) {
      if (candidateStageAborted(abortSignal)) {
        sidecarAdd(state, null, 'ABORTED', 'ABORTED');
      }
      const reason = sidecarReason(new Set([
        ...state.reasons, ...sidecarReasonsFromIO(state.ioFailures)
      ]));
      for (let rest = index; rest < expected.length; rest++) {
        const pending = expected[rest];
        results.push(sidecarCheck(
          pending.check, pending.subset, 'blocked', reason, 'unresolved'
        ));
      }
      break;
    }
    const local = new Set();
    const definition = await sidecarReadDefinition(
      sidecarIdentity(item.check.definition_pin), roots,
      capturedPorts, abortSignal, state, local
    );
    let receipt = null;
    if (definition) {
      receipt = await sidecarReadControl(
        sidecarIdentity(item.check.receipt_pin), roots,
        capturedPorts, abortSignal, state, local
      );
    }
    if (!definition || !receipt) {
      definition?.fill(0);
      receipt?.fill(0);
      results.push(sidecarCheck(
        item.check, item.subset, 'blocked', sidecarReason(local), 'unresolved'
      ));
      continue;
    }
    try {
      const envelope = captureProjectArtifactCheckReceipt({
        captured,
        check_id: item.check.check_id,
        receiptBytes: receipt,
        definitionBytes: definition
      });
      results.push(sidecarCheck(
        item.check, item.subset,
        envelope.receipt.status, envelope.receipt.reason, 'verified'
      ));
    } catch (error) {
      const reason = sidecarReceiptError(error);
      sidecarAdd(state, null, reason);
      results.push(sidecarCheck(
        item.check, item.subset, 'blocked', reason, 'unresolved'
      ));
    } finally {
      definition.fill(0);
      receipt.fill(0);
    }
  }

  const unresolvedEvidence = results.some(
    result => result.evidence_binding === 'unresolved'
  );
  const negative = results.some(result => result.status !== 'passed');
  const coverage = state.ioFailures.size || unresolvedEvidence
    ? 'BLOCKED'
    : negative
      ? 'DECLARED_CHECKS_FAILED'
      : 'DECLARED_CHECKS_PASSED';
  const sidecar = sidecarBuild(
    capture, witness, results, coverage, state.reasons, state.ioFailures
  );
  return Object.freeze({
    sidecar, bytes: encodeProjectArtifactCheckSidecar(sidecar)
  });
}

function sidecarArray(value, max, code) {
  if (!Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!safeInteger(length, 0, max)) fail(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(code); }
  if (keys.length !== length + 1) fail(code);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(code);
  }
  return result;
}

function sidecarEncoderWitness(value) {
  const code = 'INVALID_ARTIFACT_CONTEXT';
  const entries = sidecarArray(value, ARTIFACT_COUNT_MAX, code);
  const result = [];
  const ids = new Set();
  let total = 0;
  for (const raw of entries) {
    const item = closedRecord(raw, SIDECAR_WITNESS_KEYS, code);
    if (!isToken(item.artifact_id) || ids.has(item.artifact_id) ||
        !['staged', 'delivered_copy'].includes(item.role) ||
        !relativeValue(item.relative_path) ||
        !safeInteger(item.byte_count, 1, ARTIFACT_BYTES_MAX) ||
        !isSha(item.sha256)) fail(code);
    if (item.role === 'staged') {
      if (item.staged_artifact_id !== null) fail(code);
    } else if (!isToken(item.staged_artifact_id)) {
      fail(code);
    }
    total += item.byte_count;
    if (!Number.isSafeInteger(total) || total > ARTIFACT_TOTAL_MAX) fail(code);
    ids.add(item.artifact_id);
    result.push(item);
  }
  if (!isSortedUnique(result.map(item => item.artifact_id))) fail(code);
  const byId = new Map(result.map(item => [item.artifact_id, item]));
  for (const item of result) {
    if (item.role !== 'delivered_copy') continue;
    const source = byId.get(item.staged_artifact_id);
    if (!source || source.role !== 'staged' ||
        source.byte_count !== item.byte_count ||
        source.sha256 !== item.sha256) fail(code);
  }
  return result;
}

function sidecarEncoderChecks(value) {
  const code = 'INVALID_ARTIFACT_CONTEXT';
  const entries = sidecarArray(value, CHECK_COUNT_MAX, code);
  if (entries.length === 0) fail(code);
  const ids = new Set();
  return entries.map(raw => {
    const item = closedRecord(raw, SIDECAR_CHECK_KEYS, code);
    if (!isToken(item.check_id) || ids.has(item.check_id) ||
        !['passed', 'failed', 'blocked', 'not_run'].includes(item.status) ||
        !REASONS.has(item.reason) ||
        !isSha(item.artifact_subset_sha256) ||
        !['verified', 'unresolved'].includes(item.evidence_binding) ||
        item.observer_role !== 'trusted_owner_fixture') fail(code);
    ids.add(item.check_id);
    const verifiedReason =
      item.status === 'passed' && item.reason === 'NONE' ||
      item.status === 'failed' &&
        ['CHECK_FAILED', 'ABORTED', 'CHECK_UNAVAILABLE'].includes(item.reason) ||
      item.status === 'blocked' && item.reason === 'CHECK_UNAVAILABLE' ||
      item.status === 'not_run' && item.reason === 'EXPLICIT_NOT_RUN';
    const unresolvedReason = item.status === 'blocked' &&
      SIDECAR_UNRESOLVED_REASONS.has(item.reason);
    if (item.evidence_binding === 'verified'
      ? !verifiedReason
      : !unresolvedReason) fail(code);
    return item;
  });
}

function sidecarValidate(value) {
  const code = 'INVALID_ARTIFACT_CONTEXT';
  const copy = cloneBounded(value, code);
  const sidecar = closedRecord(copy, SIDECAR_KEYS, code);
  if (sidecar.schema !== SIDECAR_SCHEMA ||
      typeof sidecar.job_id !== 'string' || !UUID4.test(sidecar.job_id) ||
      !isSha(sidecar.operation_config_sha256) ||
      typeof sidecar.source_commit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(sidecar.source_commit) ||
      !isSha(sidecar.stage_manifest_sha256) ||
      !['DECLARED_CHECKS_PASSED', 'DECLARED_CHECKS_FAILED',
        'BLOCKED'].includes(sidecar.coverage) ||
      !REASONS.has(sidecar.reason) ||
      sidecar.task_correctness !== 'NOT_EVALUATED' ||
      sidecar.task_outcome_evaluated !== false ||
      sidecar.provenance_authenticity !== SIDECAR_PROVENANCE) fail(code);
  sidecar.artifact_witness = sidecarEncoderWitness(sidecar.artifact_witness);
  sidecar.check_results = sidecarEncoderChecks(sidecar.check_results);
  sidecar.io_failures = sidecarArray(sidecar.io_failures, SIDECAR_IO.length, code);
  if (sidecar.io_failures.some(item =>
    typeof item !== 'string' || !SIDECAR_IO.includes(item)
  ) || !isSortedUnique(sidecar.io_failures)) fail(code);
  sidecar.limitations = sidecarArray(
    sidecar.limitations, SIDECAR_LIMITATIONS.length, code
  );
  if (sidecar.limitations.length !== SIDECAR_LIMITATIONS.length ||
      sidecar.limitations.some((item, index) =>
        item !== SIDECAR_LIMITATIONS[index]
      )) fail(code);

  const unresolved = sidecar.check_results.some(
    item => item.evidence_binding === 'unresolved'
  );
  const negative = sidecar.check_results.some(item => item.status !== 'passed');
  const allVerified = sidecar.check_results.every(
    item => item.evidence_binding === 'verified'
  );
  if (sidecar.coverage === 'DECLARED_CHECKS_PASSED' &&
      (!sidecar.artifact_witness.length || !allVerified || negative ||
       sidecar.io_failures.length || sidecar.reason !== 'NONE')) fail(code);
  if (sidecar.coverage === 'DECLARED_CHECKS_FAILED' &&
      (!sidecar.artifact_witness.length || !allVerified || !negative ||
       sidecar.io_failures.length)) fail(code);
  if (sidecar.coverage === 'BLOCKED' &&
      (sidecar.reason === 'NONE' ||
       !unresolved && !sidecar.io_failures.length &&
         sidecar.artifact_witness.length ||
       !sidecar.artifact_witness.length &&
         !sidecar.check_results.every(item =>
           item.status === 'blocked' &&
           item.evidence_binding === 'unresolved'
         ))) fail(code);

  const reasons = new Set(sidecar.check_results
    .filter(item => item.reason !== 'NONE')
    .map(item => item.reason));
  for (const reason of sidecarReasonsFromIO(sidecar.io_failures)) {
    reasons.add(reason);
  }
  const expectedReason = sidecar.coverage === 'DECLARED_CHECKS_PASSED'
    ? 'NONE'
    : sidecarReason(reasons);
  if (sidecar.reason !== expectedReason) fail(code);
  return sidecar;
}

/** Canonical data encoding only; it does not authenticate physical origin. */
export function encodeProjectArtifactCheckSidecar(value) {
  const sidecar = sidecarValidate(value);
  let bytes;
  try {
    bytes = canonicalBytes(sidecar);
  } catch {
    fail('INVALID_ARTIFACT_CONTEXT');
  }
  if (bytes.length > CONTEXT_BYTES_MAX) fail('INVALID_ARTIFACT_CONTEXT');
  return new Uint8Array(bytes);
}
