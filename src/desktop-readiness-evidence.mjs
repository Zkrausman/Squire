// Pure v3 readiness data capture and validation.
//
// This module validates caller-supplied bytes and claims only. It performs no
// filesystem, process, provider, clock, observer, or admission operation. A
// successful result is not native readiness or product qualification.
import {types} from 'node:util';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  parseReceiptJson, snapshotReceiptData
} from './offline-run-summary.mjs';
import {canonicalBytes, hash, verifyExactFile} from './bounded-codegen-plan.mjs';
import {artifactPath} from './job-spec.mjs';
import {verifyArtifacts} from './artifact-verifier.mjs';
import {
  validateDesktopCodingLargeObservationConfig
} from './project-configuration.mjs';
import {validateDesktopRuntimeIdentity} from './desktop-profile.mjs';

export const DESKTOP_READINESS_COMPANION_PATHS = Object.freeze([
  'src/desktop-readiness-evidence.mjs',
  'src/project-artifact-check-evidence.mjs',
  'src/artifact-verifier.mjs',
  'src/job-record.mjs'
]);

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTEXT_BYTES_MAX = 65_536;
const ROUTE_BYTES_MAX = 16_384;
const EVIDENCE_BYTES_MAX = 65_536;
const DEFINITION_BYTES_MAX = 1_048_576;
const DEFINITION_TOTAL_MAX = 16_777_216;
const SOURCE_PIN_BYTES_MAX = 1_048_576;
const SOURCE_PIN_TOTAL_MAX = 4_194_304;
const RUNTIME_PIN_BYTES_MAX = 67_108_864;
const RUNTIME_PIN_TOTAL_MAX = 268_435_456;
const PROBE_WITNESS_TOTAL_MAX = 4_194_304;
const PROBE_ARTIFACT_COUNT_MAX = 16;
const PROBE_ARTIFACT_BYTES_MAX = 67_108_864;
const MAX_AGE_MS = 300_000;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/;
const EXIT_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'OTHER_SIGNAL']);
const STOP_CODES = new Set([
  'STOP_REQUESTED', 'TERM_ATTEMPTED', 'KILL_ATTEMPTED',
  'DEADLINE', 'OUTPUT_CAP'
]);
const CLEANUP_CODES = new Set([
  'CLOSE_FAILED', 'PIPE_UNKNOWN', 'SELECTOR_UNKNOWN', 'PROCESS_UNKNOWN'
]);
const CAPABILITY_STATUS = new Set([
  'passed', 'failed', 'denied', 'unsupported', 'unknown', 'not_run'
]);
const CAPABILITY_EVIDENCE = Object.freeze({
  api_shape: 'API_CONTRACT',
  own_widget_render_readback: 'NATIVE_RENDER',
  artifact_return: 'ARTIFACT_READBACK',
  own_window_active: 'NATIVE_ACTIVE',
  direct_owned_cleanup: 'DIRECT_PROCESS_CLEANUP'
});
const DOMAIN_TAGS = new Set([
  'squire.desktop-readiness.requirements.v2',
  'squire.desktop-readiness.route.v2',
  'squire.desktop-runtime-descriptor.v2',
  'squire.desktop-readiness.artifact-witness.v2'
]);

const capturedBytes = new WeakMap();
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength'
).get;
const intrinsicAbortSignalAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype, 'aborted'
).get;
const READINESS_PREFLIGHT_ABORT = new Error('READINESS_PREFLIGHT_ABORT');
const READINESS_PREFLIGHT_FAILURE = new Error('READINESS_PREFLIGHT_FAILURE');
const PROBE_ARTIFACT_ABORT = new Error('PROBE_ARTIFACT_ABORT');
const PROBE_ARTIFACT_FAILURE = new Error('PROBE_ARTIFACT_FAILURE');
const PROBE_ARTIFACT_LIMIT = new Error('PROBE_ARTIFACT_LIMIT');
const PROBE_ARTIFACT_INVALID_STAT = new Error('PROBE_ARTIFACT_INVALID_STAT');
const PROBE_FAILURE_CODES = new Set([
  'ABORTED', 'LIMIT', 'FILE_CHANGED', 'IO_FAILED', 'CLOSE_FAILED'
]);
const PROBE_STAT_FIELDS = Object.freeze([
  'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'
]);

export class DesktopReadinessValidationError extends TypeError {
  constructor(code) {
    super(code);
    this.name = 'DesktopReadinessValidationError';
    this.code = code;
  }
}

function fail(code) {
  throw new DesktopReadinessValidationError(code);
}

function requireThat(condition, code) {
  if (!condition) fail(code);
}

function isSafeInteger(value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isSha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function pathValue(value) {
  if (typeof value !== 'string' || value.length < 1 ||
      new TextEncoder().encode(value).length > 512 ||
      value === '/' || !value.startsWith('/') ||
      value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.slice(1).split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..');
}

function relativeValue(value) {
  if (!artifactPath(value) ||
      new TextEncoder().encode(value).length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.length <= 16 &&
    parts.every(part => part.length > 0 && part !== '.' && part !== '..');
}

function tokenValue(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function ownDataRecord(value, required, optional = [], code = 'INVALID_READINESS_CONTEXT') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    fail(code);
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (keys.some(key => typeof key !== 'string' ||
      !required.includes(key) && !optional.includes(key)) ||
      required.some(key => !keys.includes(key))) fail(code);
  const output = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(code);
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[key] = descriptor.value;
  }
  return output;
}

function cloneData(value, budget, seen = new Set(), code = 'INVALID_READINESS_CONTEXT') {
  budget.nodes++;
  if (budget.nodes > 20_000) fail(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.bytes += new TextEncoder().encode(value).length;
    if (budget.bytes > budget.maxBytes) fail(code);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code);
    return value;
  }
  if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) {
    fail(code);
  }

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
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!isSafeInteger(length, 0, 20_000) || keys.length !== length + 1) fail(code);
    const result = [];
    seen.add(value);
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
      result.push(cloneData(descriptor.value, budget, seen, code));
    }
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= length) fail(code);
    }
    seen.delete(value);
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const result = Object.create(null);
  seen.add(value);
  for (const key of keys) {
    if (typeof key !== 'string' ||
        key === '__proto__' || key === 'constructor' || key === 'prototype') fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    budget.bytes += new TextEncoder().encode(key).length;
    if (budget.bytes > budget.maxBytes) fail(code);
    result[key] = cloneData(descriptor.value, budget, seen, code);
  }
  seen.delete(value);
  return result;
}

function cloneBoundedData(value, maxBytes = CONTEXT_BYTES_MAX, code = 'INVALID_READINESS_CONTEXT') {
  return cloneData(value, {nodes: 0, bytes: 0, maxBytes}, new Set(), code);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  if (types.isProxy(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen);
    }
  }
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function copyBytes(value, maxBytes, code) {
  if (!types.isUint8Array(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype) fail(code);
  let length;
  try {
    length = intrinsicByteLength.call(value);
  } catch {
    fail(code);
  }
  if (!isSafeInteger(length, 0, maxBytes)) fail(code);
  const result = new Uint8Array(length);
  try {
    Uint8Array.prototype.set.call(result, value);
  } catch {
    fail(code);
  }
  return result;
}

function parseDocument(bytes, maxBytes, code) {
  const copy = copyBytes(bytes, maxBytes, code);
  try {
    // Keep the project's bounded JSON grammar and descriptor-safe snapshot in
    // the data path, then enforce safe integers and dense data ourselves.
    const parsed = parseReceiptJson(copy);
    return {copy, value: cloneBoundedData(snapshotReceiptData(parsed), maxBytes, code)};
  } catch {
    fail(code);
  }
}

function closed(value, required, code = 'INVALID_READINESS_CONTEXT') {
  const data = ownDataRecord(value, required, [], code);
  return data;
}

function checkPath(value, code) {
  requireThat(pathValue(value), code);
}

function checkRelative(value, code) {
  requireThat(relativeValue(value), code);
}

function checkSha(value, code) {
  requireThat(isSha(value), code);
}

function validatePin(value, code, maxBytes = SOURCE_PIN_BYTES_MAX) {
  const pin = closed(value, ['path', 'bytes', 'sha256'], code);
  checkPath(pin.path, code);
  requireThat(isSafeInteger(pin.bytes, 1, maxBytes), code);
  checkSha(pin.sha256, code);
  return pin;
}

function validateSourcePins(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    fail(code);
  }
  const pins = ownDataRecord(value, DESKTOP_READINESS_COMPANION_PATHS, [], code);
  let total = 0;
  const result = Object.create(null);
  for (const relative of DESKTOP_READINESS_COMPANION_PATHS) {
    checkRelative(relative, code);
    const pin = closed(pins[relative], ['bytes', 'sha256'], code);
    requireThat(isSafeInteger(pin.bytes, 1, SOURCE_PIN_BYTES_MAX), code);
    checkSha(pin.sha256, code);
    total += pin.bytes;
    if (!Number.isSafeInteger(total) || total > SOURCE_PIN_TOTAL_MAX) fail(code);
    result[relative] = Object.freeze({bytes: pin.bytes, sha256: pin.sha256});
  }
  return deepFreeze(result);
}

function validateProcessIdentity(value, code) {
  const identity = closed(value, ['pid', 'start_ticks', 'boot_id'], code);
  requireThat(isSafeInteger(identity.pid, 1, 2_147_483_647), code);
  requireThat(typeof identity.start_ticks === 'string' &&
    POSITIVE_DECIMAL.test(identity.start_ticks), code);
  requireThat(typeof identity.boot_id === 'string' && UUID.test(identity.boot_id), code);
  return identity;
}

function validateDesktopDescriptor(value, code) {
  let descriptor;
  try {
    descriptor = validateDesktopRuntimeIdentity(value);
  } catch {
    fail(code);
  }
  let total = 0;
  const pins = [
    descriptor.executable,
    ...descriptor.typelibs.map(entry => ({
      bytes: entry.bytes, sha256: entry.sha256
    })),
    ...descriptor.libraries.map(entry => ({
      bytes: entry.bytes, sha256: entry.sha256
    }))
  ];
  for (const pin of pins) {
    requireThat(isSafeInteger(pin.bytes, 1, RUNTIME_PIN_BYTES_MAX), code);
    checkSha(pin.sha256, code);
    total += pin.bytes;
    if (!Number.isSafeInteger(total) || total > RUNTIME_PIN_TOTAL_MAX) fail(code);
  }
  requireThat(descriptor.status === 'NOT_QUALIFIED', code);
  return descriptor;
}

function validateRouteData(value, code = 'INVALID_READINESS_CONTEXT') {
  const route = closed(value, [
    'backend', 'backend_gtype', 'display_name', 'environment', 'session',
    'runtime_identity'
  ], code);
  requireThat(route.backend === 'broadway' &&
    route.backend_gtype === 'GdkBroadwayDisplay' &&
    route.display_name === 'Broadway', code);

  const environment = closed(route.environment, [
    'GDK_BACKEND', 'BROADWAY_DISPLAY', 'XDG_RUNTIME_DIR'
  ], code);
  requireThat(environment.GDK_BACKEND === 'broadway' &&
    environment.BROADWAY_DISPLAY === ':41', code);
  checkPath(environment.XDG_RUNTIME_DIR, code);

  const session = closed(route.session, [
    'probe_run_id', 'controller', 'server', 'host', 'port', 'socket_path',
    'socket_dev', 'socket_ino'
  ], code);
  requireThat(tokenValue(session.probe_run_id), code);
  validateProcessIdentity(session.controller, code);
  validateProcessIdentity(session.server, code);
  requireThat(session.host === '127.0.0.1' && session.port === 8121, code);
  checkPath(session.socket_path, code);
  requireThat(session.socket_path === `${environment.XDG_RUNTIME_DIR}/broadway42.socket`, code);
  requireThat(typeof session.socket_dev === 'string' &&
    DECIMAL.test(session.socket_dev), code);
  requireThat(typeof session.socket_ino === 'string' &&
    POSITIVE_DECIMAL.test(session.socket_ino), code);
  route.runtime_identity = validateDesktopDescriptor(route.runtime_identity, code);
  return route;
}

function validateWitnessData(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    fail(code);
  }
  const entries = ownDataRecord(value, [], Object.keys(value), code);
  const names = Object.keys(entries);
  requireThat(names.length >= 1 && names.length <= 16, code);
  let total = 0;
  const result = Object.create(null);
  for (const name of names) {
    checkRelative(name, code);
    const entry = closed(entries[name], ['byte_count', 'sha256'], code);
    requireThat(isSafeInteger(entry.byte_count, 1, RUNTIME_PIN_BYTES_MAX), code);
    checkSha(entry.sha256, code);
    total += entry.byte_count;
    if (!Number.isSafeInteger(total) || total > PROBE_WITNESS_TOTAL_MAX) fail(code);
    result[name] = Object.freeze({byte_count: entry.byte_count, sha256: entry.sha256});
  }
  return deepFreeze(result);
}

function validateRequirementsData(value, code = 'INVALID_READINESS_CONTEXT') {
  const requirements = closed(value, [
    'schema', 'operation_config_sha256', 'job_id', 'scope', 'source_commit',
    'prompt_sha256', 'desktop_descriptor_sha256', 'route',
    'observer_policy_sha256', 'needs_input', 'required_capabilities',
    'max_age_ms', 'fixture_definition_sha256', 'observer_definition_sha256'
  ], code);
  requireThat(requirements.schema === 'squire.desktop_readiness_requirements.v2', code);
  checkSha(requirements.operation_config_sha256, code);
  requireThat(typeof requirements.job_id === 'string' && UUID4.test(requirements.job_id), code);
  checkPath(requirements.scope, code);
  requireThat(typeof requirements.source_commit === 'string' &&
    /^[a-f0-9]{40}$/.test(requirements.source_commit), code);
  checkSha(requirements.prompt_sha256, code);
  checkSha(requirements.desktop_descriptor_sha256, code);
  requirements.route = validateRouteData(requirements.route, code);
  checkSha(requirements.observer_policy_sha256, code);
  requireThat(typeof requirements.needs_input === 'boolean', code);
  const expected = requirements.needs_input
    ? ['api_shape', 'own_widget_render_readback', 'artifact_return',
      'own_window_active', 'direct_owned_cleanup']
    : ['api_shape', 'own_widget_render_readback', 'artifact_return',
      'direct_owned_cleanup'];
  requireThat(Array.isArray(requirements.required_capabilities) &&
    requirements.required_capabilities.length === expected.length &&
    requirements.required_capabilities.every((name, index) => name === expected[index]), code);
  requireThat(isSafeInteger(requirements.max_age_ms, 1, MAX_AGE_MS), code);
  checkSha(requirements.fixture_definition_sha256, code);
  checkSha(requirements.observer_definition_sha256, code);
  return requirements;
}

function validateInspectionData(value, code) {
  const inspection = closed(value, ['root', 'witness'], code);
  checkPath(inspection.root, code);
  inspection.witness = validateWitnessData(inspection.witness, code);
  return inspection;
}

function validateContextData(value, code = 'INVALID_READINESS_CONTEXT') {
  const context = closed(value, [
    'schema', 'requirements', 'proof_pin', 'observer_definition_pin',
    'fixture_definition_pin', 'observer_terminal_pin', 'probe_artifacts',
    'companion_source_pins'
  ], code);
  requireThat(context.schema === 'squire.desktop_readiness_context.v2', code);
  context.requirements = validateRequirementsData(context.requirements, code);
  context.proof_pin = validatePin(context.proof_pin, code, EVIDENCE_BYTES_MAX);
  context.observer_definition_pin = validatePin(
    context.observer_definition_pin, code, DEFINITION_BYTES_MAX
  );
  context.fixture_definition_pin = validatePin(
    context.fixture_definition_pin, code, DEFINITION_BYTES_MAX
  );
  context.observer_terminal_pin = validatePin(
    context.observer_terminal_pin, code, EVIDENCE_BYTES_MAX
  );
  context.probe_artifacts = validateInspectionData(context.probe_artifacts, code);
  context.companion_source_pins = validateSourcePins(context.companion_source_pins, code);
  return context;
}

function validateExecutedTerminalData(value, code) {
  const terminal = closed(value, [
    'process', 'started_at_ms', 'ended_at_ms', 'direct_child_exit_observed',
    'exit_kind', 'exit_code', 'signal', 'stdout_eof', 'stderr_eof',
    'stop_codes', 'cleanup_codes', 'descendant_guarantee'
  ], code);
  terminal.process = validateProcessIdentity(terminal.process, code);
  requireThat(isSafeInteger(terminal.started_at_ms, 0), code);
  requireThat(isSafeInteger(terminal.ended_at_ms, terminal.started_at_ms), code);
  requireThat(typeof terminal.direct_child_exit_observed === 'boolean', code);
  requireThat(['natural', 'signal', 'unknown'].includes(terminal.exit_kind), code);
  requireThat(terminal.exit_code === null ||
    isSafeInteger(terminal.exit_code, 0, 255), code);
  requireThat(terminal.signal === null ||
    typeof terminal.signal === 'string' && EXIT_SIGNALS.has(terminal.signal), code);
  if (terminal.exit_kind === 'natural') {
    requireThat(terminal.exit_code !== null && terminal.signal === null, code);
  } else if (terminal.exit_kind === 'signal') {
    requireThat(terminal.exit_code === null && terminal.signal !== null, code);
  } else {
    requireThat(terminal.exit_code === null && terminal.signal === null, code);
  }
  requireThat(typeof terminal.stdout_eof === 'boolean' &&
    typeof terminal.stderr_eof === 'boolean', code);
  terminal.stop_codes = validateCodeArray(terminal.stop_codes, STOP_CODES, code);
  terminal.cleanup_codes = validateCodeArray(terminal.cleanup_codes, CLEANUP_CODES, code);
  requireThat(terminal.descendant_guarantee === 'NOT_ESTABLISHED', code);
  return terminal;
}

function validateCodeArray(value, allowed, code) {
  requireThat(Array.isArray(value) && value.length <= 8, code);
  const result = [...value];
  requireThat(result.every(item => typeof item === 'string' && allowed.has(item)) &&
    new Set(result).size === result.length, code);
  return result;
}

function validateObserverTerminalData(value, code) {
  const receipt = closed(value, [
    'schema', 'probe_run_id', 'requirements_sha256', 'route_sha256',
    'fixture_definition_sha256', 'observer_definition_sha256', 'terminal'
  ], code);
  requireThat(receipt.schema === 'squire.desktop_readiness_terminal.v2', code);
  requireThat(tokenValue(receipt.probe_run_id), code);
  checkSha(receipt.requirements_sha256, code);
  checkSha(receipt.route_sha256, code);
  checkSha(receipt.fixture_definition_sha256, code);
  checkSha(receipt.observer_definition_sha256, code);
  receipt.terminal = validateExecutedTerminalData(receipt.terminal, code);
  return receipt;
}

function validateCapabilityData(value, code) {
  const capability = closed(value, ['name', 'status', 'evidence_kind', 'detail'], code);
  requireThat(Object.hasOwn(CAPABILITY_EVIDENCE, capability.name), code);
  requireThat(CAPABILITY_STATUS.has(capability.status), code);
  requireThat(capability.evidence_kind === CAPABILITY_EVIDENCE[capability.name], code);
  if (capability.status !== 'passed') {
    requireThat(capability.detail === null, code);
    return capability;
  }
  if (capability.name === 'api_shape') {
    const detail = closed(capability.detail, [
      'activity_property_kind', 'backend_gtype', 'display_name'
    ], code);
    requireThat(detail.activity_property_kind === 'boolean' &&
      detail.backend_gtype === 'GdkBroadwayDisplay' &&
      detail.display_name === 'Broadway', code);
    capability.detail = detail;
  } else if (capability.name === 'own_widget_render_readback') {
    const detail = closed(capability.detail, [
      'mapped', 'width', 'height', 'decoded_width', 'decoded_height',
      'png_relative'
    ], code);
    requireThat(detail.mapped === true &&
      isSafeInteger(detail.width, 1, 4096) &&
      isSafeInteger(detail.height, 1, 4096) &&
      detail.decoded_width === detail.width &&
      detail.decoded_height === detail.height, code);
    checkRelative(detail.png_relative, code);
    capability.detail = detail;
  } else if (capability.name === 'artifact_return') {
    const detail = closed(capability.detail, ['witness_sha256'], code);
    checkSha(detail.witness_sha256, code);
    capability.detail = detail;
  } else if (capability.name === 'own_window_active') {
    const detail = closed(capability.detail, ['active', 'target', 'process'], code);
    requireThat(detail.active === true && detail.target === 'OWN_FIXTURE', code);
    detail.process = validateProcessIdentity(detail.process, code);
    capability.detail = detail;
  } else {
    const detail = closed(capability.detail, ['terminal_sha256'], code);
    checkSha(detail.terminal_sha256, code);
    capability.detail = detail;
  }
  return capability;
}

function validateProofData(value, code) {
  const proof = closed(value, [
    'schema', 'requirements_sha256', 'observed_at_ms', 'route',
    'fixture_definition_sha256', 'observer_definition_sha256',
    'observer_policy_sha256', 'capabilities', 'terminal_receipt_sha256',
    'artifact_witness_sha256'
  ], code);
  requireThat(proof.schema === 'squire.desktop_readiness_observation.v2', code);
  checkSha(proof.requirements_sha256, code);
  requireThat(isSafeInteger(proof.observed_at_ms, 0), code);
  proof.route = validateRouteData(proof.route, code);
  checkSha(proof.fixture_definition_sha256, code);
  checkSha(proof.observer_definition_sha256, code);
  checkSha(proof.observer_policy_sha256, code);
  requireThat(Array.isArray(proof.capabilities) && proof.capabilities.length <= 5, code);
  proof.capabilities = proof.capabilities.map(item => validateCapabilityData(item, code));
  requireThat(new Set(proof.capabilities.map(item => item.name)).size ===
    proof.capabilities.length, code);
  checkSha(proof.terminal_receipt_sha256, code);
  checkSha(proof.artifact_witness_sha256, code);
  return proof;
}

function sameDesktopRuntimeDescriptor(left, right) {
  return readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', left
  ) === readinessDomainHash('squire.desktop-runtime-descriptor.v2', right);
}

// ProcessIdentity values are validated records, not desktop descriptors.
function sameProcessIdentity(left, right) {
  const a = validateProcessIdentity(left, 'READINESS_EVIDENCE_BLOCKED');
  const b = validateProcessIdentity(right, 'READINESS_EVIDENCE_BLOCKED');
  return a.pid === b.pid &&
    a.start_ticks === b.start_ticks &&
    a.boot_id === b.boot_id;
}

function within(path, scope) {
  return path === scope || path.startsWith(`${scope}/`);
}

function joinedPath(root, relative) {
  return join(root, ...relative.split('/'));
}

function validateScopeSeparation(config, context, code) {
  const scope = config.scope;
  const paths = [
    context.proof_pin.path,
    context.observer_terminal_pin.path,
    context.fixture_definition_pin.path,
    context.observer_definition_pin.path,
    context.probe_artifacts.root,
    ...Object.keys(context.probe_artifacts.witness).map(
      relative => joinedPath(context.probe_artifacts.root, relative)
    ),
    ...DESKTOP_READINESS_COMPANION_PATHS.map(relative => join(SOURCE_ROOT, relative))
  ];
  requireThat(paths.every(path => pathValue(path) && !within(path, scope)), code);
}

function compareReadinessBindings({
  config, configBytes, context, selectedRoute, proof, terminal,
  fixtureDefinitionBytes, observerDefinitionBytes,
  observerTerminalBytes, proofBytes
}) {
  const requirements = context.requirements;
  const descriptor = validateDesktopDescriptor(config.desktop_runtime_identity,
    'READINESS_EVIDENCE_BLOCKED');
  const descriptorHash = readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', descriptor
  );
  const requirementsHash = readinessDomainHash(
    'squire.desktop-readiness.requirements.v2', requirements
  );
  const routeHash = readinessDomainHash(
    'squire.desktop-readiness.route.v2', selectedRoute
  );
  const witnessHash = readinessDomainHash(
    'squire.desktop-readiness.artifact-witness.v2',
    context.probe_artifacts.witness
  );

  requireThat(requirements.operation_config_sha256 === hash(configBytes) &&
    requirements.job_id === config.job_id &&
    requirements.scope === config.scope &&
    requirements.source_commit === config.source_commit &&
    requirements.prompt_sha256 === config.prompt.sha256 &&
    requirements.desktop_descriptor_sha256 === descriptorHash &&
    sameDesktopRuntimeDescriptor(requirements.route.runtime_identity, descriptor) &&
    sameDesktopRuntimeDescriptor(selectedRoute.runtime_identity, descriptor),
  'READINESS_EVIDENCE_BLOCKED');

  requireThat(readinessDomainHash(
    'squire.desktop-readiness.route.v2', requirements.route
  ) === routeHash &&
    readinessDomainHash('squire.desktop-readiness.route.v2', proof.route) === routeHash &&
    terminal.route_sha256 === routeHash, 'READINESS_EVIDENCE_BLOCKED');

  requireThat(readinessDomainHash(
    'squire.desktop-readiness.requirements.v2', requirements
  ) === proof.requirements_sha256 &&
    terminal.requirements_sha256 === requirementsHash, 'READINESS_EVIDENCE_BLOCKED');

  const fixtureHash = hash(fixtureDefinitionBytes);
  const observerHash = hash(observerDefinitionBytes);
  requireThat(fixtureDefinitionBytes.length === context.fixture_definition_pin.bytes &&
    observerDefinitionBytes.length === context.observer_definition_pin.bytes &&
    fixtureHash === context.fixture_definition_pin.sha256 &&
    fixtureHash === requirements.fixture_definition_sha256 &&
    fixtureHash === proof.fixture_definition_sha256 &&
    fixtureHash === terminal.fixture_definition_sha256, 'READINESS_EVIDENCE_BLOCKED');
  requireThat(observerHash === context.observer_definition_pin.sha256 &&
    observerHash === requirements.observer_definition_sha256 &&
    observerHash === proof.observer_definition_sha256 &&
    observerHash === terminal.observer_definition_sha256, 'READINESS_EVIDENCE_BLOCKED');
  requireThat(proof.observer_policy_sha256 === requirements.observer_policy_sha256,
    'READINESS_EVIDENCE_BLOCKED');

  requireThat(hash(proofBytes) === context.proof_pin.sha256 &&
    proofBytes.length === context.proof_pin.bytes &&
    hash(observerTerminalBytes) === context.observer_terminal_pin.sha256 &&
    observerTerminalBytes.length === context.observer_terminal_pin.bytes &&
    proof.terminal_receipt_sha256 === context.observer_terminal_pin.sha256 &&
    proof.artifact_witness_sha256 === witnessHash, 'READINESS_EVIDENCE_BLOCKED');

  const expectedNames = requirements.required_capabilities;
  requireThat(proof.capabilities.length === expectedNames.length &&
    proof.capabilities.every((capability, index) =>
      capability.name === expectedNames[index] && capability.status === 'passed'),
  'READINESS_EVIDENCE_BLOCKED');

  const byName = new Map(proof.capabilities.map(capability => [
    capability.name, capability
  ]));
  const render = byName.get('own_widget_render_readback')?.detail;
  const returned = byName.get('artifact_return')?.detail;
  const cleanup = byName.get('direct_owned_cleanup')?.detail;
  requireThat(render && Object.hasOwn(context.probe_artifacts.witness, render.png_relative) &&
    returned?.witness_sha256 === witnessHash &&
    cleanup?.terminal_sha256 === context.observer_terminal_pin.sha256,
  'READINESS_EVIDENCE_BLOCKED');

  if (requirements.needs_input) {
    const active = byName.get('own_window_active')?.detail;
    requireThat(active?.active === true &&
      sameProcessIdentity(active.process, terminal.terminal.process),
    'READINESS_EVIDENCE_BLOCKED');
  }

  requireThat(terminal.schema === 'squire.desktop_readiness_terminal.v2' &&
    terminal.probe_run_id === requirements.route.session.probe_run_id &&
    terminal.probe_run_id === proof.route.session.probe_run_id &&
    terminal.terminal.direct_child_exit_observed === true &&
    terminal.terminal.exit_kind === 'natural' &&
    terminal.terminal.exit_code === 0 &&
    terminal.terminal.signal === null &&
    terminal.terminal.stdout_eof === true &&
    terminal.terminal.stderr_eof === true &&
    terminal.terminal.stop_codes.length === 0 &&
    terminal.terminal.cleanup_codes.length === 0, 'READINESS_EVIDENCE_BLOCKED');
  requireThat(!sameProcessIdentity(
    terminal.terminal.process, requirements.route.session.controller
  ) && !sameProcessIdentity(
    terminal.terminal.process, requirements.route.session.server
  ),
  'READINESS_EVIDENCE_BLOCKED');
  requireThat(proof.observed_at_ms >= terminal.terminal.started_at_ms &&
    proof.observed_at_ms <= terminal.terminal.ended_at_ms, 'READINESS_EVIDENCE_BLOCKED');
  validateScopeSeparation(config, context, 'READINESS_EVIDENCE_BLOCKED');

  return Object.freeze({
    config, context, selected_route: selectedRoute, proof, observer_terminal: terminal,
    requirements_sha256: requirementsHash,
    route_sha256: routeHash,
    descriptor_sha256: descriptorHash,
    artifact_witness_sha256: witnessHash,
    native_app_status: 'NOT_QUALIFIED',
    validation_scope: 'PURE_DATA_ONLY'
  });
}

function freezeCapture(record, bytes) {
  const result = deepFreeze(record);
  capturedBytes.set(result, bytes);
  return result;
}

/**
 * Descriptor-safe validator for a ReadinessContext object. It validates
 * structure, bounds, safe integers, routes, pins, and witness metadata only.
 */
export function validateDesktopReadinessContext(value) {
  try {
    const copy = cloneBoundedData(value);
    return deepFreeze(validateContextData(copy));
  } catch (error) {
    if (error instanceof DesktopReadinessValidationError &&
        error.code === 'INVALID_READINESS_CONTEXT') throw error;
    fail('INVALID_READINESS_CONTEXT');
  }
}

/** Validate a closed Route value without asserting any OS observation. */
export function validateDesktopReadinessRoute(value) {
  try {
    return deepFreeze(validateRouteData(cloneBoundedData(value)));
  } catch {
    fail('INVALID_READINESS_CONTEXT');
  }
}

/**
 * Validate faithful terminal representation. Signal exits retain a null
 * numeric exit code; this validator does not treat a signal as clean readiness.
 */
export function validateDesktopReadinessExecutedTerminal(value) {
  try {
    return deepFreeze(validateExecutedTerminalData(cloneBoundedData(value),
      'READINESS_EVIDENCE_BLOCKED'));
  } catch (error) {
    if (error instanceof DesktopReadinessValidationError) throw error;
    fail('READINESS_EVIDENCE_BLOCKED');
  }
}

/**
 * Domain-separated canonical hash for the four fixed v3 readiness domains.
 * Values are validated before canonical serialization.
 */
export function readinessDomainHash(tag, value) {
  if (!DOMAIN_TAGS.has(tag)) fail('INVALID_READINESS_CONTEXT');
  let captured;
  try {
    captured = cloneBoundedData(value, 65_536);
    if (tag === 'squire.desktop-readiness.route.v2') {
      captured = validateRouteData(captured);
    } else if (tag === 'squire.desktop-readiness.requirements.v2') {
      captured = validateRequirementsData(captured);
    } else if (tag === 'squire.desktop-runtime-descriptor.v2') {
      captured = validateDesktopDescriptor(captured, 'INVALID_READINESS_CONTEXT');
    } else {
      captured = validateWitnessData(captured, 'INVALID_READINESS_CONTEXT');
    }
    return hash(canonicalBytes({domain: tag, value: captured}));
  } catch (error) {
    if (error instanceof DesktopReadinessValidationError) throw error;
    fail('INVALID_READINESS_CONTEXT');
  }
}

/**
 * Validate the exact four companion-pin map and resolve its fixed relative
 * names against this module's source root. This does not read or verify files.
 */
export function validateDesktopReadinessCompanionSourcePins(value) {
  try {
    return validateSourcePins(cloneBoundedData(value), 'INVALID_READINESS_CONTEXT');
  } catch (error) {
    if (error instanceof DesktopReadinessValidationError) throw error;
    fail('INVALID_READINESS_CONTEXT');
  }
}

export function resolveDesktopReadinessCompanionSourcePins(value) {
  const pins = validateDesktopReadinessCompanionSourcePins(value);
  const resolved = Object.create(null);
  for (const relative of DESKTOP_READINESS_COMPANION_PATHS) {
    resolved[join(SOURCE_ROOT, relative)] = pins[relative];
  }
  return deepFreeze(resolved);
}

/**
 * Capture and bind the supplied data documents. Inputs are intrinsic copied
 * Uint8Arrays. The supplied definition bytes are compared with their pins;
 * no filesystem or runtime verification is performed here.
 */
export function captureDesktopReadinessData(input) {
  const inputFields = [
    'configBytes', 'readinessContextBytes', 'selectedRouteBytes', 'proofBytes',
    'observerTerminalBytes', 'fixtureDefinitionBytes', 'observerDefinitionBytes'
  ];
  const supplied = ownDataRecord(input, inputFields, [], 'INVALID_READINESS_CONTEXT');
  const bytes = Object.create(null);
  bytes.config = copyBytes(supplied.configBytes, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT');
  bytes.context = copyBytes(
    supplied.readinessContextBytes, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
  );
  bytes.selected_route = copyBytes(
    supplied.selectedRouteBytes, ROUTE_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
  );
  bytes.proof = copyBytes(supplied.proofBytes, EVIDENCE_BYTES_MAX, 'READINESS_EVIDENCE_BLOCKED');
  bytes.observer_terminal = copyBytes(
    supplied.observerTerminalBytes, EVIDENCE_BYTES_MAX, 'READINESS_EVIDENCE_BLOCKED'
  );
  bytes.fixture_definition = copyBytes(
    supplied.fixtureDefinitionBytes, DEFINITION_BYTES_MAX, 'READINESS_EVIDENCE_BLOCKED'
  );
  bytes.observer_definition = copyBytes(
    supplied.observerDefinitionBytes, DEFINITION_BYTES_MAX, 'READINESS_EVIDENCE_BLOCKED'
  );
  requireThat(bytes.fixture_definition.length + bytes.observer_definition.length <=
    DEFINITION_TOTAL_MAX, 'READINESS_EVIDENCE_BLOCKED');

  let config;
  let context;
  let selectedRoute;
  try {
    const configDocument = parseDocument(
      bytes.config, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
    );
    config = validateDesktopCodingLargeObservationConfig(configDocument.value);
    context = validateContextData(parseDocument(
      bytes.context, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
    ).value);
    selectedRoute = validateRouteData(parseDocument(
      bytes.selected_route, ROUTE_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
    ).value);
  } catch {
    fail('INVALID_READINESS_CONTEXT');
  }

  let proof;
  let terminal;
  try {
    proof = validateProofData(parseDocument(
      bytes.proof, EVIDENCE_BYTES_MAX, 'READINESS_EVIDENCE_BLOCKED'
    ).value, 'READINESS_EVIDENCE_BLOCKED');
    terminal = validateObserverTerminalData(parseDocument(
      bytes.observer_terminal, EVIDENCE_BYTES_MAX, 'READINESS_EVIDENCE_BLOCKED'
    ).value, 'READINESS_EVIDENCE_BLOCKED');
  } catch (error) {
    if (error instanceof DesktopReadinessValidationError &&
        error.code === 'READINESS_EVIDENCE_BLOCKED') throw error;
    fail('READINESS_EVIDENCE_BLOCKED');
  }

  const contextRequirements = context.requirements;
  requireThat(bytes.proof.length === context.proof_pin.bytes &&
    hash(bytes.proof) === context.proof_pin.sha256 &&
    bytes.observer_terminal.length === context.observer_terminal_pin.bytes &&
    hash(bytes.observer_terminal) === context.observer_terminal_pin.sha256,
  'READINESS_EVIDENCE_BLOCKED');

  const bound = compareReadinessBindings({
    config, configBytes: bytes.config, context, selectedRoute, proof, terminal,
    fixtureDefinitionBytes: bytes.fixture_definition,
    observerDefinitionBytes: bytes.observer_definition,
    observerTerminalBytes: bytes.observer_terminal,
    proofBytes: bytes.proof
  });
  requireThat(bound.context.requirements === contextRequirements,
    'READINESS_EVIDENCE_BLOCKED');
  return freezeCapture(bound, bytes);
}

/**
 * Assert proof freshness against caller-supplied timestamps. The caller owns
 * obtaining both times; this pure function starts no clock and grants no
 * admission authority.
 */
export function assertDesktopReadinessCurrent(captured, now_ms, previous_now_ms = null) {
  const bytes = capturedBytes.get(captured);
  requireThat(bytes && Object.isFrozen(captured) &&
    captured.validation_scope === 'PURE_DATA_ONLY', 'READINESS_EVIDENCE_BLOCKED');
  requireThat(isSafeInteger(now_ms, 0) &&
    (previous_now_ms === null || isSafeInteger(previous_now_ms, 0)) &&
    (previous_now_ms === null || now_ms >= previous_now_ms),
  'READINESS_EVIDENCE_BLOCKED');
  const proofAt = captured.proof.observed_at_ms;
  const endedAt = captured.observer_terminal.terminal.ended_at_ms;
  const age = now_ms - proofAt;
  requireThat(now_ms >= endedAt && endedAt >= proofAt &&
    Number.isSafeInteger(age) && age >= 0 &&
    age <= captured.context.requirements.max_age_ms,
  'READINESS_EVIDENCE_BLOCKED');
  return captured;
}

/** Return a fresh copy of one captured byte document for later pure use. */
export function copyCapturedDesktopReadinessBytes(captured, name) {
  const bytes = capturedBytes.get(captured);
  const allowed = new Set([
    'config', 'context', 'selected_route', 'proof', 'observer_terminal',
    'fixture_definition', 'observer_definition'
  ]);
  requireThat(bytes && allowed.has(name), 'READINESS_EVIDENCE_BLOCKED');
  return new Uint8Array(bytes[name]);
}

function captureReadinessPreflightPorts(value) {
  const supplied = ownDataRecord(
    value, ['fs', 'verifyFile', 'reads'], [], 'INVALID_READINESS_CONTEXT'
  );
  const fs = ownDataRecord(
    supplied.fs, ['realpath', 'lstat'], [], 'INVALID_READINESS_CONTEXT'
  );
  const reads = ownDataRecord(
    supplied.reads, ['lstat', 'readChunks'], [], 'INVALID_READINESS_CONTEXT'
  );
  const functions = [
    fs.realpath, fs.lstat, supplied.verifyFile, reads.lstat, reads.readChunks
  ];
  requireThat(functions.every(value =>
    typeof value === 'function' && !types.isProxy(value)
  ), 'INVALID_READINESS_CONTEXT');
  return Object.freeze({
    fs: Object.freeze(fs),
    verifyFile: supplied.verifyFile,
    reads: Object.freeze(reads)
  });
}

function validateReadinessPreflightSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)) {
    fail('INVALID_READINESS_CONTEXT');
  }
  try {
    requireThat(typeof intrinsicAbortSignalAborted.call(signal) === 'boolean',
      'INVALID_READINESS_CONTEXT');
  } catch {
    fail('INVALID_READINESS_CONTEXT');
  }
}

function readinessPreflightAborted(signal) {
  return signal !== undefined && intrinsicAbortSignalAborted.call(signal);
}

function throwIfReadinessPreflightAborted(signal) {
  if (readinessPreflightAborted(signal)) throw READINESS_PREFLIGHT_ABORT;
}

function recordReadinessPreflightPrimaryFailure(state, error) {
  if (state.primaryFailure) return;
  state.primaryFailure = true;
  state.primaryError = error;
}

function recordReadinessPreflightCleanupFailure(state, error) {
  if (state.cleanupFailure) return;
  state.cleanupFailure = true;
  state.cleanupError = error;
}

function noteReadinessPreflightAbort(signal, state) {
  try {
    throwIfReadinessPreflightAborted(signal);
  } catch (error) {
    recordReadinessPreflightPrimaryFailure(state, error);
  }
}

async function awaitReadinessPreflight(operation, signal) {
  throwIfReadinessPreflightAborted(signal);
  let result;
  try {
    result = await operation();
  } catch (error) {
    throwIfReadinessPreflightAborted(signal);
    throw error;
  }
  throwIfReadinessPreflightAborted(signal);
  return result;
}

function getReadinessIteratorMethod(target, key, required = true) {
  if (!target || typeof target !== 'object' || types.isProxy(target)) {
    throw READINESS_PREFLIGHT_FAILURE;
  }
  for (let current = target; current !== null; current = Object.getPrototypeOf(current)) {
    if (types.isProxy(current)) throw READINESS_PREFLIGHT_FAILURE;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) {
      throw READINESS_PREFLIGHT_FAILURE;
    }
    return descriptor.value;
  }
  if (required) throw READINESS_PREFLIGHT_FAILURE;
  return null;
}

function captureReadinessIteratorResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      types.isProxy(value)) throw READINESS_PREFLIGHT_FAILURE;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw READINESS_PREFLIGHT_FAILURE;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => key !== 'done' && key !== 'value')) {
    throw READINESS_PREFLIGHT_FAILURE;
  }
  const doneDescriptor = Object.getOwnPropertyDescriptor(value, 'done');
  const valueDescriptor = Object.getOwnPropertyDescriptor(value, 'value');
  if (!doneDescriptor || !Object.hasOwn(doneDescriptor, 'value') ||
      typeof doneDescriptor.value !== 'boolean' ||
      valueDescriptor && !Object.hasOwn(valueDescriptor, 'value')) {
    throw READINESS_PREFLIGHT_FAILURE;
  }

  const done = doneDescriptor.value;
  if (!done && (!valueDescriptor ||
      !types.isUint8Array(valueDescriptor.value) ||
      types.isProxy(valueDescriptor.value))) {
    throw READINESS_PREFLIGHT_FAILURE;
  }
  return Object.freeze({
    done,
    ...(valueDescriptor ? {value: valueDescriptor.value} : {})
  });
}

async function closeReadinessIterator(owner, signal, state, value) {
  if (!owner || owner.completed) return owner?.doneResult ?? null;
  if (owner.closePromise) return owner.closePromise;

  // Claim ownership before invoking host code so reentrant calls cannot
  // close the same underlying iterator twice.
  owner.closeAttempted = true;
  owner.closePromise = Promise.resolve().then(async () => {
    noteReadinessPreflightAbort(signal, state);
    if (!owner.returnMethod) {
      recordReadinessPreflightCleanupFailure(
        state, READINESS_PREFLIGHT_FAILURE
      );
      return null;
    }
    try {
      const pending = Reflect.apply(owner.returnMethod, owner.iterator, [value]);
      noteReadinessPreflightAbort(signal, state);
      const result = await pending;
      noteReadinessPreflightAbort(signal, state);
      const captured = captureReadinessIteratorResult(result);
      if (captured.done !== true) throw READINESS_PREFLIGHT_FAILURE;
      return captured;
    } catch (error) {
      recordReadinessPreflightCleanupFailure(state, error);
      noteReadinessPreflightAbort(signal, state);
      return null;
    }
  });
  return owner.closePromise;
}

function createAbortAwareReadChunks(readChunks, reads, path, signal, state) {
  throwIfReadinessPreflightAborted(signal);
  let source;
  try {
    source = Reflect.apply(readChunks, reads, [path]);
  } catch (error) {
    recordReadinessPreflightPrimaryFailure(state, error);
    throw error;
  }
  noteReadinessPreflightAbort(signal, state);

  return {
    [Symbol.asyncIterator]() {
      let owner = null;
      const facade = {
        async next(...args) {
          if (owner?.completed) return owner.doneResult;
          if (state.primaryFailure || state.cleanupFailure ||
              owner?.setupFailure || !owner) {
            if (!state.primaryFailure && !state.cleanupFailure) {
              recordReadinessPreflightPrimaryFailure(
                state,
                owner?.setupFailure
                  ? owner.setupError
                  : READINESS_PREFLIGHT_FAILURE
              );
            }
            if (owner) await closeReadinessIterator(owner, signal, state);
            if (state.primaryFailure) throw state.primaryError;
            throw state.cleanupError;
          }

          try {
            // Check immediately before every underlying next call, including
            // the call after a previously yielded chunk.
            throwIfReadinessPreflightAborted(signal);
            const result = await Reflect.apply(owner.nextMethod, owner.iterator, args);
            throwIfReadinessPreflightAborted(signal);
            const captured = captureReadinessIteratorResult(result);
            if (captured.done) {
              owner.completed = true;
              owner.doneResult = captured;
            }
            return captured;
          } catch (error) {
            recordReadinessPreflightPrimaryFailure(state, error);
            noteReadinessPreflightAbort(signal, state);
            await closeReadinessIterator(owner, signal, state);
            throw state.primaryError;
          }
        },
        async return(value) {
          if (!owner) {
            recordReadinessPreflightPrimaryFailure(
              state, READINESS_PREFLIGHT_FAILURE
            );
            throw state.primaryError;
          }
          const result = await closeReadinessIterator(owner, signal, state, value);
          if (state.cleanupFailure) throw state.cleanupError;
          if (state.primaryFailure) throw state.primaryError;
          if (!result) throw READINESS_PREFLIGHT_FAILURE;
          return result;
        },
        [Symbol.asyncIterator]() {
          return this;
        }
      };

      try {
        throwIfReadinessPreflightAborted(signal);
        const iteratorFactory = getReadinessIteratorMethod(
          source, Symbol.asyncIterator
        );
        const iterator = Reflect.apply(iteratorFactory, source, []);
        // The iterator is owned as soon as its factory returns. Any later
        // method lookup or setup failure uses the same cleanup path.
        owner = {
          iterator,
          nextMethod: null,
          returnMethod: null,
          completed: false,
          doneResult: null,
          closeAttempted: false,
          closePromise: null,
          setupError: null
        };
        owner.returnMethod = getReadinessIteratorMethod(iterator, 'return', false);
        owner.nextMethod = getReadinessIteratorMethod(iterator, 'next');
        throwIfReadinessPreflightAborted(signal);
      } catch (error) {
        recordReadinessPreflightPrimaryFailure(state, error);
        if (owner) {
          owner.setupFailure = true;
          owner.setupError = error;
        }
      }
      return facade;
    }
  };
}

function readinessPinnedIdentities(captured) {
  const context = captured.context;
  const evidence = [
    {pin: context.proof_pin, maxBytes: EVIDENCE_BYTES_MAX},
    {pin: context.observer_terminal_pin, maxBytes: EVIDENCE_BYTES_MAX},
    {pin: context.fixture_definition_pin, maxBytes: DEFINITION_BYTES_MAX},
    {pin: context.observer_definition_pin, maxBytes: DEFINITION_BYTES_MAX}
  ].map(({pin, maxBytes}) => {
    requireThat(pathValue(pin.path) && isSafeInteger(pin.bytes, 1, maxBytes) &&
      isSha(pin.sha256), 'READINESS_EVIDENCE_BLOCKED');
    return Object.freeze({path: pin.path, bytes: pin.bytes, sha256: pin.sha256});
  });

  const definitionsTotal =
    context.fixture_definition_pin.bytes + context.observer_definition_pin.bytes;
  requireThat(Number.isSafeInteger(definitionsTotal) &&
    definitionsTotal <= DEFINITION_TOTAL_MAX, 'READINESS_EVIDENCE_BLOCKED');

  const descriptor = captured.config.desktop_runtime_identity;
  const runtime = [
    {
      path: descriptor.executable.path,
      bytes: descriptor.executable.bytes,
      sha256: descriptor.executable.sha256
    },
    ...descriptor.typelibs.map(entry => ({
      path: entry.typelib, bytes: entry.bytes, sha256: entry.sha256
    })),
    ...descriptor.libraries.map(entry => ({
      path: entry.path, bytes: entry.bytes, sha256: entry.sha256
    }))
  ];
  let runtimeTotal = 0;
  for (const identity of runtime) {
    requireThat(pathValue(identity.path) &&
      isSafeInteger(identity.bytes, 1, RUNTIME_PIN_BYTES_MAX) &&
      isSha(identity.sha256), 'READINESS_EVIDENCE_BLOCKED');
    runtimeTotal += identity.bytes;
    requireThat(Number.isSafeInteger(runtimeTotal) &&
      runtimeTotal <= RUNTIME_PIN_TOTAL_MAX, 'READINESS_EVIDENCE_BLOCKED');
  }

  return Object.freeze({
    evidence: Object.freeze(evidence),
    runtime: Object.freeze(runtime.map(identity => Object.freeze(identity)))
  });
}

function readinessCanonicalPaths(context) {
  return [
    context.proof_pin.path,
    context.observer_terminal_pin.path,
    context.fixture_definition_pin.path,
    context.observer_definition_pin.path,
    context.probe_artifacts.root,
    ...Object.keys(context.probe_artifacts.witness).sort().map(
      relative => joinedPath(context.probe_artifacts.root, relative)
    )
  ];
}

function genuineReadinessEnoent(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error) ||
      !(error instanceof Error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return Boolean(descriptor && Object.hasOwn(descriptor, 'value') &&
    descriptor.value === 'ENOENT');
}

/**
 * Rehash captured evidence and runtime pins, then check canonical scope
 * separation. Probe artifact contents remain NOT_EVALUATED.
 */
export async function verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
  captured, abortSignal, ports
) {
  const bytes = capturedBytes.get(captured);
  requireThat(bytes && Object.isFrozen(captured) &&
    captured.validation_scope === 'PURE_DATA_ONLY',
  'READINESS_EVIDENCE_BLOCKED');
  const capturedPorts = captureReadinessPreflightPorts(ports);
  validateReadinessPreflightSignal(abortSignal);

  const {config, context} = captured;
  const identities = readinessPinnedIdentities(captured);
  validateScopeSeparation(config, context, 'READINESS_EVIDENCE_BLOCKED');
  const scope = config.scope;

  try {
    throwIfReadinessPreflightAborted(abortSignal);
    for (const identity of [...identities.evidence, ...identities.runtime]) {
      const state = {
        primaryFailure: false,
        primaryError: undefined,
        cleanupFailure: false,
        cleanupError: undefined
      };
      const reads = Object.freeze({
        lstat: path => awaitReadinessPreflight(
          () => Reflect.apply(capturedPorts.reads.lstat, capturedPorts.reads, [path]),
          abortSignal
        ),
        readChunks: path => createAbortAwareReadChunks(
          capturedPorts.reads.readChunks, capturedPorts.reads,
          path, abortSignal, state
        )
      });

      try {
        await awaitReadinessPreflight(
          () => Reflect.apply(capturedPorts.verifyFile, undefined, [identity, reads]),
          abortSignal
        );
      } catch (error) {
        recordReadinessPreflightPrimaryFailure(state, error);
      }
      if (state.primaryFailure || state.cleanupFailure) {
        throw READINESS_PREFLIGHT_FAILURE;
      }
    }

    const canonicalParent = await awaitReadinessPreflight(
      () => Reflect.apply(capturedPorts.fs.realpath, capturedPorts.fs, [dirname(scope)]),
      abortSignal
    );
    if (canonicalParent !== '/' && !pathValue(canonicalParent)) {
      throw READINESS_PREFLIGHT_FAILURE;
    }
    const canonicalScope = join(canonicalParent, basename(scope));
    if (canonicalScope !== scope) throw READINESS_PREFLIGHT_FAILURE;

    try {
      await awaitReadinessPreflight(
        () => Reflect.apply(capturedPorts.fs.lstat, capturedPorts.fs, [scope]),
        abortSignal
      );
      throw READINESS_PREFLIGHT_FAILURE;
    } catch (error) {
      if (error === READINESS_PREFLIGHT_ABORT ||
          error === READINESS_PREFLIGHT_FAILURE ||
          !genuineReadinessEnoent(error)) throw READINESS_PREFLIGHT_FAILURE;
    }

    for (const path of readinessCanonicalPaths(context)) {
      const canonicalPath = await awaitReadinessPreflight(
        () => Reflect.apply(capturedPorts.fs.realpath, capturedPorts.fs, [path]),
        abortSignal
      );
      if (!pathValue(canonicalPath) || within(canonicalPath, canonicalScope)) {
        throw READINESS_PREFLIGHT_FAILURE;
      }
    }
    throwIfReadinessPreflightAborted(abortSignal);
  } catch {
    fail('READINESS_EVIDENCE_BLOCKED');
  }

  return Object.freeze({
    captured,
    verification_scope: 'PINNED_FILES_AND_CANONICAL_SCOPE_ONLY',
    probe_artifact_status: 'NOT_EVALUATED',
    native_app_status: 'NOT_QUALIFIED'
  });
}

function captureReadinessProbePorts(value) {
  const supplied = ownDataRecord(
    value, ['fs', 'uid'], [], 'INVALID_READINESS_CONTEXT'
  );
  const fs = ownDataRecord(
    supplied.fs, ['lstat', 'realpath', 'open'], [],
    'INVALID_READINESS_CONTEXT'
  );
  requireThat(
    [fs.lstat, fs.realpath, fs.open].every(method =>
      typeof method === 'function' && !types.isProxy(method)
    ) && isSafeInteger(supplied.uid, 0),
    'INVALID_READINESS_CONTEXT'
  );
  return Object.freeze({fs: Object.freeze(fs), uid: supplied.uid});
}

function buildReadinessProbeArtifactPlan(captured) {
  const inspection = captured.context.probe_artifacts;
  const root = inspection.root;
  requireThat(pathValue(root), 'READINESS_EVIDENCE_BLOCKED');

  const names = Object.keys(inspection.witness).sort();
  requireThat(names.length >= 1 && names.length <= PROBE_ARTIFACT_COUNT_MAX,
    'READINESS_EVIDENCE_BLOCKED');

  const entries = [];
  const files = new Map();
  const directories = new Set([root]);
  const allowedPaths = new Set([root]);
  let totalBytes = 0;

  for (const relative of names) {
    const witness = inspection.witness[relative];
    requireThat(relativeValue(relative) &&
      isSafeInteger(witness.byte_count, 1, PROBE_ARTIFACT_BYTES_MAX) &&
      isSha(witness.sha256), 'READINESS_EVIDENCE_BLOCKED');
    totalBytes += witness.byte_count;
    requireThat(Number.isSafeInteger(totalBytes) &&
      totalBytes <= PROBE_WITNESS_TOTAL_MAX,
    'READINESS_EVIDENCE_BLOCKED');

    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = join(root, ...parts.slice(0, index));
      requireThat(pathValue(directory) && !files.has(directory),
        'READINESS_EVIDENCE_BLOCKED');
      directories.add(directory);
      allowedPaths.add(directory);
    }

    const path = joinedPath(root, relative);
    requireThat(pathValue(path) && within(path, root) && path !== root &&
      !directories.has(path) && !files.has(path),
    'READINESS_EVIDENCE_BLOCKED');
    const entry = Object.freeze({
      path,
      relative,
      byte_count: witness.byte_count,
      sha256: witness.sha256
    });
    entries.push(entry);
    files.set(path, entry);
    allowedPaths.add(path);
  }

  return Object.freeze({
    root,
    entries: Object.freeze(entries),
    files,
    directories,
    allowedPaths,
    totalBytes
  });
}

function readinessProbeDataProperty(value, key) {
  if (!value || !['object', 'function'].includes(typeof value) ||
      types.isProxy(value)) return {valid: false, found: false};
  for (let current = value; current !== null;) {
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
  return {valid: false, found: false};
}

function readinessProbeMethod(value, key) {
  const property = readinessProbeDataProperty(value, key);
  return property.valid && property.found &&
    typeof property.value === 'function' && !types.isProxy(property.value)
    ? property.value
    : null;
}

function captureReadinessProbeStat(stat) {
  const values = Object.create(null);
  for (const key of PROBE_STAT_FIELDS) {
    const property = readinessProbeDataProperty(stat, key);
    if (!property.valid || !property.found ||
        typeof property.value !== 'bigint') {
      throw PROBE_ARTIFACT_INVALID_STAT;
    }
    values[key] = property.value;
  }

  const uid = readinessProbeDataProperty(stat, 'uid');
  const nlink = readinessProbeDataProperty(stat, 'nlink');
  const isFile = readinessProbeMethod(stat, 'isFile');
  const isDirectory = readinessProbeMethod(stat, 'isDirectory');
  const isSymbolicLink = readinessProbeMethod(stat, 'isSymbolicLink');
  if (!uid.valid || !uid.found || !nlink.valid || !nlink.found ||
      !isFile || !isDirectory || !isSymbolicLink) {
    throw PROBE_ARTIFACT_INVALID_STAT;
  }

  let file;
  let directory;
  let symbolicLink;
  try {
    file = Reflect.apply(isFile, stat, []);
    directory = Reflect.apply(isDirectory, stat, []);
    symbolicLink = Reflect.apply(isSymbolicLink, stat, []);
  } catch {
    throw PROBE_ARTIFACT_INVALID_STAT;
  }
  if (typeof file !== 'boolean' || typeof directory !== 'boolean' ||
      typeof symbolicLink !== 'boolean') {
    throw PROBE_ARTIFACT_INVALID_STAT;
  }

  return Object.freeze({
    values: Object.freeze(values),
    uid: uid.value,
    nlink: nlink.value,
    file,
    directory,
    symbolicLink
  });
}

function sameReadinessProbeFileStat(left, right) {
  return PROBE_STAT_FIELDS.every(key =>
    left.values[key] === right.values[key]
  ) && left.uid === right.uid && left.nlink === right.nlink &&
    left.file === right.file && left.directory === right.directory &&
    left.symbolicLink === right.symbolicLink;
}

function readinessProbeFileStat(stat, entry, uid) {
  const captured = captureReadinessProbeStat(stat);
  const ownerMatches =
    typeof captured.uid === 'bigint' && captured.uid === BigInt(uid) ||
    typeof captured.uid === 'number' &&
      Number.isSafeInteger(captured.uid) && captured.uid === uid;
  const oneLink =
    typeof captured.nlink === 'bigint' && captured.nlink === 1n ||
    typeof captured.nlink === 'number' &&
      Number.isSafeInteger(captured.nlink) && captured.nlink === 1;
  if (!captured.file || captured.directory || captured.symbolicLink ||
      !ownerMatches || !oneLink ||
      captured.values.size !== BigInt(entry.byte_count)) {
    throw PROBE_ARTIFACT_INVALID_STAT;
  }
  return captured;
}

function readinessProbeDirectoryStat(stat) {
  const captured = captureReadinessProbeStat(stat);
  if (!captured.directory || captured.file || captured.symbolicLink) {
    throw PROBE_ARTIFACT_INVALID_STAT;
  }
}

function latchReadinessProbeFailure(state, code) {
  if (PROBE_FAILURE_CODES.has(code)) state.failures.add(code);
}

function noteReadinessProbeAbort(signal, state) {
  if (readinessPreflightAborted(signal)) {
    latchReadinessProbeFailure(state, 'ABORTED');
    return true;
  }
  return false;
}

function checkReadinessProbeAbort(signal, state) {
  if (noteReadinessProbeAbort(signal, state)) throw PROBE_ARTIFACT_ABORT;
}

async function awaitReadinessProbeIO(operation, signal, state) {
  checkReadinessProbeAbort(signal, state);
  let result;
  try {
    result = await operation();
  } catch (error) {
    latchReadinessProbeFailure(state, 'IO_FAILED');
    noteReadinessProbeAbort(signal, state);
    throw error;
  }
  checkReadinessProbeAbort(signal, state);
  return result;
}

function readinessProbeReadBytes(result) {
  const property = readinessProbeDataProperty(result, 'bytesRead');
  if (!property.valid || !property.found ||
      !Number.isSafeInteger(property.value)) {
    throw PROBE_ARTIFACT_INVALID_STAT;
  }
  return property.value;
}

function closeReadinessProbeHandle(owner, signal, state) {
  if (owner.closePromise) return owner.closePromise;
  owner.closePromise = Promise.resolve().then(async () => {
    noteReadinessProbeAbort(signal, state);
    if (!owner.closeMethod) {
      latchReadinessProbeFailure(state, 'CLOSE_FAILED');
      throw PROBE_ARTIFACT_FAILURE;
    }
    try {
      await Reflect.apply(owner.closeMethod, owner.handle, []);
    } catch (error) {
      latchReadinessProbeFailure(state, 'CLOSE_FAILED');
      noteReadinessProbeAbort(signal, state);
      throw error;
    }
    noteReadinessProbeAbort(signal, state);
  });
  return owner.closePromise;
}

function createReadinessProbeArtifactIO(plan, capturedPorts, signal, state) {
  const execution = new Map(plan.entries.map(entry => [
    entry.path, {initialStat: null, openAttempted: false}
  ]));

  const requireAllowedPath = path => {
    if (typeof path !== 'string' || !plan.allowedPaths.has(path)) {
      latchReadinessProbeFailure(state, 'LIMIT');
      throw PROBE_ARTIFACT_LIMIT;
    }
  };

  const lstat = async (path, ...args) => {
    requireAllowedPath(path);
    const stat = await awaitReadinessProbeIO(
      () => Reflect.apply(capturedPorts.fs.lstat, capturedPorts.fs,
        [path, ...args]),
      signal, state
    );
    try {
      if (plan.directories.has(path)) {
        readinessProbeDirectoryStat(stat);
      } else {
        const entry = plan.files.get(path);
        const run = execution.get(path);
        if (!entry || !run) throw PROBE_ARTIFACT_INVALID_STAT;
        const signature = readinessProbeFileStat(stat, entry, capturedPorts.uid);
        if (run.initialStat &&
            !sameReadinessProbeFileStat(run.initialStat, signature)) {
          throw PROBE_ARTIFACT_INVALID_STAT;
        }
        if (!run.initialStat) run.initialStat = signature;
      }
    } catch {
      latchReadinessProbeFailure(state, 'FILE_CHANGED');
      throw PROBE_ARTIFACT_FAILURE;
    }
    return stat;
  };

  const realpath = async (path, ...args) => {
    requireAllowedPath(path);
    return awaitReadinessProbeIO(
      () => Reflect.apply(capturedPorts.fs.realpath, capturedPorts.fs,
        [path, ...args]),
      signal, state
    );
  };

  const open = async (path, ...args) => {
    const entry = plan.files.get(path);
    const run = execution.get(path);
    if (!entry || !run || run.openAttempted) {
      latchReadinessProbeFailure(state, 'LIMIT');
      throw PROBE_ARTIFACT_LIMIT;
    }
    run.openAttempted = true;
    checkReadinessProbeAbort(signal, state);

    let handle;
    try {
      handle = await Reflect.apply(capturedPorts.fs.open,
        capturedPorts.fs, [path, ...args]);
    } catch (error) {
      latchReadinessProbeFailure(state, 'IO_FAILED');
      noteReadinessProbeAbort(signal, state);
      throw error;
    }

    // Claim the acquired handle before checking abort or inspecting its shape.
    const owner = {
      handle,
      closeMethod: null,
      statMethod: null,
      readMethod: null,
      closePromise: null,
      position: 0,
      eofRequested: false
    };

    try {
      owner.closeMethod = readinessProbeMethod(handle, 'close');
      checkReadinessProbeAbort(signal, state);
      owner.statMethod = readinessProbeMethod(handle, 'stat');
      owner.readMethod = readinessProbeMethod(handle, 'read');
      if (!owner.statMethod || !owner.readMethod) {
        latchReadinessProbeFailure(state, 'FILE_CHANGED');
        throw PROBE_ARTIFACT_FAILURE;
      }

      const openedStat = await awaitReadinessProbeIO(
        () => Reflect.apply(owner.statMethod, handle, [{bigint: true}]),
        signal, state
      );
      let signature;
      try {
        signature = readinessProbeFileStat(openedStat, entry, capturedPorts.uid);
      } catch {
        latchReadinessProbeFailure(state, 'FILE_CHANGED');
        throw PROBE_ARTIFACT_FAILURE;
      }
      if (!run.initialStat ||
          !sameReadinessProbeFileStat(run.initialStat, signature)) {
        latchReadinessProbeFailure(state, 'FILE_CHANGED');
        throw PROBE_ARTIFACT_FAILURE;
      }

      const wrappedHandle = {
        stat: async (...statArgs) => {
          const stat = await awaitReadinessProbeIO(
            () => Reflect.apply(owner.statMethod, handle, statArgs),
            signal, state
          );
          try {
            const current = readinessProbeFileStat(
              stat, entry, capturedPorts.uid
            );
            if (!sameReadinessProbeFileStat(run.initialStat, current)) {
              throw PROBE_ARTIFACT_INVALID_STAT;
            }
          } catch {
            latchReadinessProbeFailure(state, 'FILE_CHANGED');
            throw PROBE_ARTIFACT_FAILURE;
          }
          return stat;
        },
        read: async (buffer, offset, length, position) => {
          let bufferLength;
          try {
            if (!types.isUint8Array(buffer) || types.isProxy(buffer)) {
              throw PROBE_ARTIFACT_LIMIT;
            }
            bufferLength = intrinsicByteLength.call(buffer);
          } catch {
            latchReadinessProbeFailure(state, 'LIMIT');
            throw PROBE_ARTIFACT_LIMIT;
          }
          if (!Number.isSafeInteger(offset) || offset < 0 ||
              !Number.isSafeInteger(length) || length <= 0 ||
              offset + length > bufferLength ||
              !Number.isSafeInteger(position) ||
              position !== owner.position) {
            latchReadinessProbeFailure(state, 'LIMIT');
            throw PROBE_ARTIFACT_LIMIT;
          }

          const expected = entry.byte_count;
          const payloadRemaining = expected - owner.position;
          const isEofRead = owner.position === expected;
          if (isEofRead) {
            if (owner.eofRequested || length !== 1 ||
                state.eofAllowances >= PROBE_ARTIFACT_COUNT_MAX) {
              latchReadinessProbeFailure(state, 'LIMIT');
              throw PROBE_ARTIFACT_LIMIT;
            }
            owner.eofRequested = true;
            state.eofAllowances++;
          } else if (owner.position > expected ||
              length > payloadRemaining ||
              length > state.totalBytes - state.payloadBytes ||
              length > 65_536) {
            latchReadinessProbeFailure(state, 'LIMIT');
            throw PROBE_ARTIFACT_LIMIT;
          }

          const result = await awaitReadinessProbeIO(
            () => Reflect.apply(owner.readMethod, handle,
              [buffer, offset, length, position]),
            signal, state
          );
          let bytesRead;
          try {
            bytesRead = readinessProbeReadBytes(result);
          } catch {
            latchReadinessProbeFailure(state, 'FILE_CHANGED');
            throw PROBE_ARTIFACT_FAILURE;
          }

          if (bytesRead < 0 || bytesRead > length ||
              isEofRead && bytesRead !== 0 ||
              !isEofRead && bytesRead === 0) {
            latchReadinessProbeFailure(state, 'FILE_CHANGED');
            throw PROBE_ARTIFACT_FAILURE;
          }
          if (!isEofRead) {
            if (state.payloadBytes + bytesRead > state.totalBytes) {
              latchReadinessProbeFailure(state, 'LIMIT');
              throw PROBE_ARTIFACT_LIMIT;
            }
            state.payloadBytes += bytesRead;
            owner.position += bytesRead;
          }
          return result;
        },
        close: () => closeReadinessProbeHandle(owner, signal, state)
      };
      return wrappedHandle;
    } catch (error) {
      try {
        await closeReadinessProbeHandle(owner, signal, state);
      } catch {
        // The latch preserves cleanup failure even when its payload is falsy.
      }
      throw error;
    }
  };

  return Object.freeze({lstat, realpath, open});
}

function noteReadinessProbeVerifierFailure(state, result) {
  const classification = result?.failure?.classification;
  if (classification === 'aborted') {
    latchReadinessProbeFailure(state, 'ABORTED');
  } else if (classification === 'close_failed') {
    latchReadinessProbeFailure(state, 'CLOSE_FAILED');
  } else if (classification === 'unsupported_open_flags') {
    latchReadinessProbeFailure(state, 'LIMIT');
  } else if ([
    'expected_mismatch', 'artifact_changed', 'directory_changed',
    'unsafe_path', 'unsafe_root', 'empty_artifact',
    'artifact_size_unrepresentable', 'invalid_stat'
  ].includes(classification)) {
    latchReadinessProbeFailure(state, 'FILE_CHANGED');
  } else {
    latchReadinessProbeFailure(state, 'IO_FAILED');
  }
}

function readinessProbeWitnessMatches(actual, entries) {
  if (!actual || typeof actual !== 'object' || types.isProxy(actual)) {
    return false;
  }
  let keys;
  try {
    keys = Reflect.ownKeys(actual);
  } catch {
    return false;
  }
  if (keys.length !== entries.length) return false;
  for (const entry of entries) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, entry.relative);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    const value = descriptor.value;
    if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
    const byteCount = readinessProbeDataProperty(value, 'byte_count');
    const sha256 = readinessProbeDataProperty(value, 'sha256');
    if (!byteCount.valid || !byteCount.found ||
        !sha256.valid || !sha256.found ||
        byteCount.value !== entry.byte_count ||
        sha256.value !== entry.sha256) return false;
  }
  return keys.every(key =>
    typeof key === 'string' &&
    entries.some(entry => entry.relative === key)
  );
}

/**
 * Verify only the captured probe-artifact bytes through the unchanged
 * verifyArtifacts implementation. This does not evaluate rendered content,
 * readiness, or native application qualification.
 */
export async function verifyDesktopReadinessProbeArtifactsWithPorts(
  captured, abortSignal, ports
) {
  const bytes = capturedBytes.get(captured);
  requireThat(bytes && Object.isFrozen(captured) &&
    captured.validation_scope === 'PURE_DATA_ONLY',
  'READINESS_EVIDENCE_BLOCKED');
  const capturedPorts = captureReadinessProbePorts(ports);
  validateReadinessPreflightSignal(abortSignal);
  const plan = buildReadinessProbeArtifactPlan(captured);
  const state = {
    failures: new Set(),
    payloadBytes: 0,
    eofAllowances: 0,
    totalBytes: plan.totalBytes
  };

  try {
    checkReadinessProbeAbort(abortSignal, state);
    const specification = Object.freeze({
      job_id: captured.config.job_id,
      task_scope: plan.root,
      provider_id: captured.config.provider_id,
      requested_model: captured.config.requested_model,
      max_wall_clock_sec: 1,
      max_steps: 1,
      required_artifacts: Object.freeze(
        plan.entries.map(entry => entry.relative)
      )
    });
    const expectedCapture = Object.freeze({
      job_id: captured.config.job_id,
      artifact_witness: captured.context.probe_artifacts.witness
    });
    const io = createReadinessProbeArtifactIO(
      plan, capturedPorts, abortSignal, state
    );
    const result = await verifyArtifacts(specification, {
      fs: io,
      signal: abortSignal,
      expected_capture: expectedCapture
    });

    if (result?.verified !== true || result.failure !== null) {
      noteReadinessProbeVerifierFailure(state, result);
    } else if (result.job_id !== captured.config.job_id ||
        !readinessProbeWitnessMatches(
          result.artifact_witness, plan.entries
        )) {
      latchReadinessProbeFailure(state, 'FILE_CHANGED');
    }
    noteReadinessProbeAbort(abortSignal, state);
    if (state.failures.size !== 0) fail('READINESS_EVIDENCE_BLOCKED');
  } catch {
    noteReadinessProbeAbort(abortSignal, state);
    fail('READINESS_EVIDENCE_BLOCKED');
  }

  return Object.freeze({
    captured,
    verification_scope: 'PROBE_ARTIFACT_BYTES_ONLY',
    artifact_content_verification: 'VERIFIED',
    readiness_status: 'NOT_EVALUATED',
    native_app_status: 'NOT_QUALIFIED'
  });
}

function captureReadinessEvidenceReaderPorts(value) {
  const supplied = ownDataRecord(
    value, ['readBytes', 'reads'], [], 'INVALID_READINESS_CONTEXT'
  );
  const reads = ownDataRecord(
    supplied.reads, ['lstat', 'readChunks'], [], 'INVALID_READINESS_CONTEXT'
  );
  requireThat(
    [supplied.readBytes, reads.lstat, reads.readChunks].every(method =>
      typeof method === 'function' && !types.isProxy(method)
    ),
    'INVALID_READINESS_CONTEXT'
  );
  return Object.freeze({
    readBytes: supplied.readBytes,
    reads: Object.freeze(reads)
  });
}

function validateReadinessAcquisitionBindings(
  config, configBytes, context, selectedRoute
) {
  const requirements = context.requirements;
  const descriptor = validateDesktopDescriptor(
    config.desktop_runtime_identity, 'READINESS_EVIDENCE_BLOCKED'
  );
  const descriptorHash = readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', descriptor
  );
  const routeHash = readinessDomainHash(
    'squire.desktop-readiness.route.v2', selectedRoute
  );
  requireThat(
    requirements.operation_config_sha256 === hash(configBytes) &&
      requirements.job_id === config.job_id &&
      requirements.scope === config.scope &&
      requirements.source_commit === config.source_commit &&
      requirements.prompt_sha256 === config.prompt.sha256 &&
      requirements.desktop_descriptor_sha256 === descriptorHash &&
      sameDesktopRuntimeDescriptor(requirements.route.runtime_identity, descriptor) &&
      sameDesktopRuntimeDescriptor(selectedRoute.runtime_identity, descriptor) &&
      readinessDomainHash(
        'squire.desktop-readiness.route.v2', requirements.route
      ) === routeHash,
    'READINESS_EVIDENCE_BLOCKED'
  );
  validateScopeSeparation(config, context, 'READINESS_EVIDENCE_BLOCKED');
}

async function readReadinessSmallPinnedDocument(identity, ports, signal) {
  let copy = null;
  try {
    throwIfReadinessPreflightAborted(signal);
    const value = await awaitReadinessPreflight(
      () => Reflect.apply(
        ports.readBytes, ports, [identity.path, identity.bytes]
      ),
      signal
    );
    copy = copyBytes(value, identity.bytes, 'READINESS_EVIDENCE_BLOCKED');
    requireThat(
      copy.length === identity.bytes && hash(copy) === identity.sha256,
      'READINESS_EVIDENCE_BLOCKED'
    );
    return copy;
  } catch {
    copy?.fill(0);
    fail('READINESS_EVIDENCE_BLOCKED');
  }
}

function copyReadinessDefinitionChunk(value, maxBytes) {
  // Buffers are Uint8Array views too. Reject proxies before any prototype or
  // property inspection, then use only typed-array intrinsics for the copy.
  if (types.isProxy(value) || !types.isUint8Array(value)) {
    fail('READINESS_EVIDENCE_BLOCKED');
  }
  let size;
  try {
    size = intrinsicByteLength.call(value);
  } catch {
    fail('READINESS_EVIDENCE_BLOCKED');
  }
  requireThat(isSafeInteger(size, 0, maxBytes), 'READINESS_EVIDENCE_BLOCKED');
  const owned = new Uint8Array(size);
  try {
    Uint8Array.prototype.set.call(owned, value);
  } catch {
    owned.fill(0);
    fail('READINESS_EVIDENCE_BLOCKED');
  }
  return owned;
}

async function readReadinessDefinitionPinnedDocument(identity, ports, signal) {
  const chunks = [];
  let total = 0;
  let reachedEof = false;
  let resultBytes = null;
  const state = {
    primaryFailure: false,
    primaryError: undefined,
    cleanupFailure: false,
    cleanupError: undefined
  };

  const reads = Object.freeze({
    lstat(path) {
      if (path !== identity.path) {
        recordReadinessPreflightPrimaryFailure(
          state, READINESS_PREFLIGHT_FAILURE
        );
        return Promise.reject(state.primaryError);
      }
      return awaitReadinessPreflight(
        () => Reflect.apply(ports.reads.lstat, ports.reads, [path]),
        signal
      );
    },
    readChunks(path) {
      if (path !== identity.path) {
        recordReadinessPreflightPrimaryFailure(
          state, READINESS_PREFLIGHT_FAILURE
        );
        throw state.primaryError;
      }

      let guarded;
      try {
        throwIfReadinessPreflightAborted(signal);
        guarded = createAbortAwareReadChunks(
          ports.reads.readChunks, ports.reads, path, signal, state
        );
      } catch (error) {
        recordReadinessPreflightPrimaryFailure(state, error);
        throw state.primaryError;
      }

      return Object.freeze({
        [Symbol.asyncIterator]() {
          let iterator = null;
          let nextMethod = null;
          let returnMethod = null;
          let guardedIteratorAcquired = false;
          let setupFailure = false;
          try {
            throwIfReadinessPreflightAborted(signal);
            const factory = getReadinessIteratorMethod(
              guarded, Symbol.asyncIterator
            );
            iterator = Reflect.apply(factory, guarded, []);
            guardedIteratorAcquired = true;

            // Capture cleanup first. If later setup or the abort check fails,
            // the returned facade can still close its owned iterator in next().
            returnMethod = getReadinessIteratorMethod(
              iterator, 'return', false
            );
            nextMethod = getReadinessIteratorMethod(iterator, 'next');
            throwIfReadinessPreflightAborted(signal);
          } catch (error) {
            setupFailure = true;
            recordReadinessPreflightPrimaryFailure(state, error);
          }

          let completed = false;
          let doneResult = null;
          const closeAfterFailure = async () => {
            if (!guardedIteratorAcquired) return;
            if (!returnMethod) {
              recordReadinessPreflightCleanupFailure(
                state, READINESS_PREFLIGHT_FAILURE
              );
              return;
            }
            try {
              await Reflect.apply(returnMethod, iterator, []);
            } catch (error) {
              // The accepted facade records a real cleanup failure. A
              // completed close may instead rethrow the already-recorded
              // primary failure.
              if (!state.cleanupFailure && !state.primaryFailure) {
                recordReadinessPreflightCleanupFailure(state, error);
              }
            }
          };

          return Object.freeze({
            async next(...args) {
              if (completed) return doneResult;
              if (setupFailure || state.primaryFailure ||
                  state.cleanupFailure || !nextMethod) {
                if (!state.primaryFailure && !state.cleanupFailure) {
                  recordReadinessPreflightPrimaryFailure(
                    state, READINESS_PREFLIGHT_FAILURE
                  );
                }
                await closeAfterFailure();
                if (state.primaryFailure) throw state.primaryError;
                throw state.cleanupError;
              }

              let owned = null;
              try {
                throwIfReadinessPreflightAborted(signal);
                const value = await Reflect.apply(
                  nextMethod, iterator, args
                );
                throwIfReadinessPreflightAborted(signal);
                const entry = captureReadinessIteratorResult(value);
                if (entry.done) {
                  completed = true;
                  doneResult = entry;
                  reachedEof = true;
                  requireThat(
                    total === identity.bytes,
                    'READINESS_EVIDENCE_BLOCKED'
                  );
                  return entry;
                }

                const remaining = identity.bytes - total;
                owned = copyReadinessDefinitionChunk(entry.value, remaining);
                if (owned.length > 0) chunks.push(owned);
                total += owned.length;
                const output = Object.freeze({done: false, value: owned});
                owned = null;
                return output;
              } catch (error) {
                owned?.fill(0);
                recordReadinessPreflightPrimaryFailure(state, error);
                noteReadinessPreflightAbort(signal, state);
                await closeAfterFailure();
                if (state.primaryFailure) throw state.primaryError;
                throw state.cleanupError;
              }
            },
            async return(value) {
              if (completed) return doneResult;
              if (!guardedIteratorAcquired) {
                if (state.primaryFailure) throw state.primaryError;
                recordReadinessPreflightPrimaryFailure(
                  state, READINESS_PREFLIGHT_FAILURE
                );
                throw state.primaryError;
              }
              if (!returnMethod) {
                recordReadinessPreflightCleanupFailure(
                  state, READINESS_PREFLIGHT_FAILURE
                );
                throw state.cleanupError;
              }
              try {
                const result = await Reflect.apply(
                  returnMethod, iterator, [value]
                );
                const captured = captureReadinessIteratorResult(result);
                if (captured.done !== true) {
                  recordReadinessPreflightCleanupFailure(
                    state, READINESS_PREFLIGHT_FAILURE
                  );
                  throw state.cleanupError;
                }
                return captured;
              } catch (error) {
                if (state.cleanupFailure) throw state.cleanupError;
                if (state.primaryFailure) throw state.primaryError;
                recordReadinessPreflightCleanupFailure(state, error);
                throw state.cleanupError;
              }
            },
            [Symbol.asyncIterator]() {
              return this;
            }
          });
        }
      });
    }
  });

  try {
    const verification = await verifyExactFile(identity, reads);
    throwIfReadinessPreflightAborted(signal);
    requireThat(
      verification.path === identity.path &&
        !state.primaryFailure && !state.cleanupFailure &&
        reachedEof && total === identity.bytes,
      'READINESS_EVIDENCE_BLOCKED'
    );
    resultBytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      Uint8Array.prototype.set.call(resultBytes, chunk, offset);
      offset += chunk.length;
    }
    requireThat(
      offset === identity.bytes && hash(resultBytes) === identity.sha256,
      'READINESS_EVIDENCE_BLOCKED'
    );
    return resultBytes;
  } catch {
    resultBytes?.fill(0);
    fail('READINESS_EVIDENCE_BLOCKED');
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/**
 * Acquire the four fixed, context-pinned readiness documents using exact
 * bounded reads. This returns the same PURE_DATA_ONLY capture as
 * captureDesktopReadinessData; it performs no clock, scope or native check.
 */
export async function captureDesktopReadinessFromFilesWithPorts(
  configBytes, readinessContextBytes, selectedRouteBytes, abortSignal, ports
) {
  let configCopy = null;
  let contextCopy = null;
  let routeCopy = null;
  const evidenceCopies = [];

  try {
    let config;
    let context;
    let selectedRoute;
    let capturedPorts;
    try {
      // Copy all caller documents before suspension or host-provided IO.
      configCopy = copyBytes(
        configBytes, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
      );
      contextCopy = copyBytes(
        readinessContextBytes, CONTEXT_BYTES_MAX,
        'INVALID_READINESS_CONTEXT'
      );
      routeCopy = copyBytes(
        selectedRouteBytes, ROUTE_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
      );
      capturedPorts = captureReadinessEvidenceReaderPorts(ports);
      validateReadinessPreflightSignal(abortSignal);

      config = validateDesktopCodingLargeObservationConfig(
        parseDocument(
          configCopy, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
        ).value
      );
      context = validateContextData(parseDocument(
        contextCopy, CONTEXT_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
      ).value);
      selectedRoute = validateRouteData(parseDocument(
        routeCopy, ROUTE_BYTES_MAX, 'INVALID_READINESS_CONTEXT'
      ).value);
    } catch (error) {
      if (error instanceof DesktopReadinessValidationError &&
          error.code === 'READINESS_EVIDENCE_BLOCKED') throw error;
      fail('INVALID_READINESS_CONTEXT');
    }

    validateReadinessAcquisitionBindings(
      config, configCopy, context, selectedRoute
    );

    const identities = [
      {
        path: context.proof_pin.path,
        bytes: context.proof_pin.bytes,
        sha256: context.proof_pin.sha256,
        maxBytes: EVIDENCE_BYTES_MAX,
        definition: false
      },
      {
        path: context.observer_terminal_pin.path,
        bytes: context.observer_terminal_pin.bytes,
        sha256: context.observer_terminal_pin.sha256,
        maxBytes: EVIDENCE_BYTES_MAX,
        definition: false
      },
      {
        path: context.fixture_definition_pin.path,
        bytes: context.fixture_definition_pin.bytes,
        sha256: context.fixture_definition_pin.sha256,
        maxBytes: DEFINITION_BYTES_MAX,
        definition: true
      },
      {
        path: context.observer_definition_pin.path,
        bytes: context.observer_definition_pin.bytes,
        sha256: context.observer_definition_pin.sha256,
        maxBytes: DEFINITION_BYTES_MAX,
        definition: true
      }
    ].map(identity => {
      requireThat(
        pathValue(identity.path) &&
          isSafeInteger(identity.bytes, 1, identity.maxBytes) &&
          isSha(identity.sha256),
        'READINESS_EVIDENCE_BLOCKED'
      );
      return Object.freeze(identity);
    });
    const definitionsTotal = identities[2].bytes + identities[3].bytes;
    requireThat(
      Number.isSafeInteger(definitionsTotal) &&
        definitionsTotal <= DEFINITION_TOTAL_MAX,
      'READINESS_EVIDENCE_BLOCKED'
    );

    throwIfReadinessPreflightAborted(abortSignal);
    for (const identity of identities) {
      const bytes = identity.definition
        ? await readReadinessDefinitionPinnedDocument(
          identity, capturedPorts, abortSignal
        )
        : await readReadinessSmallPinnedDocument(
          identity, capturedPorts, abortSignal
        );
      evidenceCopies.push(bytes);
      throwIfReadinessPreflightAborted(abortSignal);
    }

    throwIfReadinessPreflightAborted(abortSignal);
    let captured;
    try {
      captured = captureDesktopReadinessData({
        configBytes: configCopy,
        readinessContextBytes: contextCopy,
        selectedRouteBytes: routeCopy,
        proofBytes: evidenceCopies[0],
        observerTerminalBytes: evidenceCopies[1],
        fixtureDefinitionBytes: evidenceCopies[2],
        observerDefinitionBytes: evidenceCopies[3]
      });
    } catch (error) {
      if (error instanceof DesktopReadinessValidationError &&
          error.code === 'INVALID_READINESS_CONTEXT') {
        fail('INVALID_READINESS_CONTEXT');
      }
      fail('READINESS_EVIDENCE_BLOCKED');
    }
    throwIfReadinessPreflightAborted(abortSignal);
    return captured;
  } catch (error) {
    if (error instanceof DesktopReadinessValidationError &&
        ['INVALID_READINESS_CONTEXT', 'READINESS_EVIDENCE_BLOCKED'].includes(
          error.code
        )) throw error;
    fail('READINESS_EVIDENCE_BLOCKED');
  } finally {
    configCopy?.fill(0);
    contextCopy?.fill(0);
    routeCopy?.fill(0);
    for (const bytes of evidenceCopies) bytes.fill(0);
  }
}
