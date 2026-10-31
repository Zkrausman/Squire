// Explicitly captures and records a validated project result. No task is launched.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {types} from 'node:util';
import {parseReceiptJson, REPORT_MAX_BYTES, snapshotReceiptData} from './offline-run-summary.mjs';
import {
  projectProjectRunSummary,projectNativeProjectRunSummary,
  projectNativeProjectCodingObservationRunSummary,
  projectNativeProjectLargeObservationRunSummary
} from './project-summary.mjs';
import {
  PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA,
  PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA
} from './project-coding-profile.mjs';

const rootKeys = [
  'schema', 'status', 'reason', 'generation', 'staging', 'task_correctness',
  'task_outcome_evaluated', 'runtime_admitted', 'operator_admitted',
  'workspace_disposition', 'descendant_guarantee', 'operator_receipt',
  'direct_child_invocations', 'outer_observation_target_ms', 'event_loop_condition'
];
const generationKeys = ['record', 'runtime_evidence', 'diagnostic_retention'];
const destinationKeys = ['directory', 'filename'];
const portKeys = ['fs', 'uid'];
const errorCodes = new Set([
  'INVALID_INPUT', 'INVALID_RECEIPT', 'RECEIPT_TOO_LARGE',
  'INVALID_DESTINATION', 'INVALID_PORTS', 'WRITE_FAILED'
]);
const NATIVE_RECEIPT_SCHEMA='SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1';

class ReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProjectResultReceiptError';
    this.code = code;
  }
}
function fail(code) {
  throw new ReceiptError(errorCodes.has(code) ? code : 'INVALID_INPUT');
}
function ownDataFields(value, required, optional = [], code = 'INVALID_INPUT') {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const names = Reflect.ownKeys(value);
    if (names.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
        required.some(key => !names.includes(key))) fail(code);
    const output = Object.create(null);
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
      output[key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    fail(code);
  }
}
function captureSelectedData(value,observation=false,largeObservation=false) {
  const root = ownDataFields(value, [
    ...rootKeys,
    ...(observation?['execution_profile','post_generation_closeout']:[]),
    ...(largeObservation?['execution_profile','output_profile','post_generation_closeout']:[])
  ]);
  if (root.generation !== null) {
    const generation = ownDataFields(root.generation, generationKeys, ['late_observations']);
    if (Object.hasOwn(generation, 'late_observations') &&
        (typeof generation.late_observations !== 'function' || types.isProxy(generation.late_observations))) {
      fail('INVALID_INPUT');
    }
    const selected = Object.create(null);
    for (const key of generationKeys) selected[key] = generation[key];
    root.generation = selected;
  }
  return snapshotReceiptData(root);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
function encodeEnvelope(envelope,native,observation=false,largeObservation=false) {
  let encoded;
  try {
    encoded = new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
  } catch {
    fail('INVALID_RECEIPT');
  }
  if (encoded.length > REPORT_MAX_BYTES) fail('RECEIPT_TOO_LARGE');
  let parsed;
  try {
    parsed = parseReceiptJson(encoded);
  } catch {
    fail('INVALID_RECEIPT');
  }
  const projection = largeObservation?projectNativeProjectLargeObservationRunSummary(parsed):
    observation?projectNativeProjectCodingObservationRunSummary(parsed):native
    ? projectNativeProjectRunSummary(parsed)
    : projectProjectRunSummary(parsed);
  if (projection.readiness === 'INVALID_RECEIPT') fail('INVALID_RECEIPT');
  return encoded;
}
export function createProjectResultReceipt(value) {
  let receipt;
  try {
    receipt = captureSelectedData(value);
  } catch {
    fail('INVALID_INPUT');
  }
  const projection = projectProjectRunSummary(receipt);
  if (projection.readiness === 'INVALID_RECEIPT') fail('INVALID_RECEIPT');
  return deepFreeze(receipt);
}
export function createNativeProjectResultReceipt(liveResult) {
  return createNativeReceipt(liveResult,false);
}
export function createNativeProjectCodingObservationResultReceipt(liveResult) {
  return createNativeReceipt(liveResult,true);
}
export function createNativeProjectLargeObservationResultReceipt(liveResult) {
  let result;
  try {
    result=captureSelectedData(liveResult,false,true);
  } catch {
    fail('INVALID_INPUT');
  }
  const envelope={schema:PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA,result};
  const projection=projectNativeProjectLargeObservationRunSummary(envelope);
  if(projection.readiness==='INVALID_RECEIPT')fail('INVALID_RECEIPT');
  let bytes;
  try {
    bytes=new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
  } catch {
    fail('INVALID_RECEIPT');
  }
  if(bytes.length>REPORT_MAX_BYTES){
    bytes.fill(0);
    fail('RECEIPT_TOO_LARGE');
  }
  bytes.fill(0);
  return deepFreeze(envelope);
}
function createNativeReceipt(liveResult,observation) {
  let result;
  try {
    result = captureSelectedData(liveResult,observation);
  } catch {
    fail('INVALID_INPUT');
  }
  const envelope = {schema:observation?PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA:NATIVE_RECEIPT_SCHEMA,result};
  const projection=observation?projectNativeProjectCodingObservationRunSummary(envelope):projectNativeProjectRunSummary(envelope);
  if (projection.readiness === 'INVALID_RECEIPT') fail('INVALID_RECEIPT');
  let bytes;
  try {
    bytes = new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
  } catch {
    fail('INVALID_RECEIPT');
  }
  if (bytes.length > REPORT_MAX_BYTES) {
    bytes.fill(0);
    fail('RECEIPT_TOO_LARGE');
  }
  bytes.fill(0);
  return deepFreeze(envelope);
}
function encodeValidatedReceipt(value) {
  const receipt = createProjectResultReceipt(value);
  return encodeEnvelope(receipt, false);
}
function encodeValidatedNativeReceipt(value) {
  const receipt = createNativeProjectResultReceipt(value);
  return encodeEnvelope(receipt, true);
}
function validateDestination(value) {
  const fields = ownDataFields(value, destinationKeys, [], 'INVALID_DESTINATION');
  const {directory, filename} = fields;
  try {
    if (typeof directory !== 'string' || directory === '/' || !directory.startsWith('/') ||
        directory.includes('\0') || resolve(directory) !== directory ||
        typeof filename !== 'string' || filename.length < 1 || filename.length > 128 ||
        !/^[A-Za-z0-9._-]+$/.test(filename) || filename === '.' || filename === '..' ||
        filename.includes('/') || filename.includes('\0')) fail('INVALID_DESTINATION');
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    fail('INVALID_DESTINATION');
  }
  return {directory, filename};
}
function findDataMethod(target, key) {
  if (!target || typeof target !== 'object' && typeof target !== 'function') throw 0;
  for (let current = target; current !== null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw 0;
    return descriptor.value;
  }
  throw 0;
}
function callMethod(target, key, args = []) {
  return Reflect.apply(findDataMethod(target, key), target, args);
}
function validatePorts(value) {
  const fields = ownDataFields(value, portKeys, [], 'INVALID_PORTS');
  if (!fields.fs || typeof fields.fs !== 'object' ||
      !Number.isSafeInteger(fields.uid) || fields.uid < 0) fail('INVALID_PORTS');
  try {
    findDataMethod(fields.fs, 'lstat');
    findDataMethod(fields.fs, 'open');
  } catch {
    fail('INVALID_PORTS');
  }
  return fields;
}
function ownStatField(stat, key) {
  if (!stat || typeof stat !== 'object' || types.isProxy(stat)) throw 0;
  const descriptor = Object.getOwnPropertyDescriptor(stat, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw 0;
  return descriptor.value;
}
function statView(stat) {
  const view = {
    dev: ownStatField(stat, 'dev'),
    ino: ownStatField(stat, 'ino'),
    uid: ownStatField(stat, 'uid'),
    nlink: ownStatField(stat, 'nlink'),
    mode: ownStatField(stat, 'mode'),
    size: ownStatField(stat, 'size'),
    mtimeMs: ownStatField(stat, 'mtimeMs'),
    ctimeMs: ownStatField(stat, 'ctimeMs'),
    isFile: callMethod(stat, 'isFile'),
    isDirectory: callMethod(stat, 'isDirectory'),
    isSymbolicLink: callMethod(stat, 'isSymbolicLink')
  };
  if (![view.dev, view.ino, view.uid, view.nlink, view.mode, view.size].every(Number.isSafeInteger) ||
      view.dev < 0 || view.ino < 0 || view.uid < 0 || view.nlink < 0 ||
      view.mode < 0 || view.size < 0 || !Number.isFinite(view.mtimeMs) ||
      !Number.isFinite(view.ctimeMs) ||
      ![view.isFile, view.isDirectory, view.isSymbolicLink].every(value => typeof value === 'boolean')) throw 0;
  return view;
}
function parentView(stat, uid, selected = null) {
  const view = statView(stat);
  if (!view.isDirectory || view.isSymbolicLink || view.uid !== uid ||
      (view.mode & 0o7777) !== 0o700 ||
      selected && (view.dev !== selected.dev || view.ino !== selected.ino ||
        view.uid !== selected.uid || view.nlink !== selected.nlink ||
        (view.mode & 0o7777) !== selected.mode)) throw 0;
  return {dev: view.dev, ino: view.ino, uid: view.uid, nlink: view.nlink, mode: view.mode & 0o7777};
}
function leafView(stat, uid, size, selected = null) {
  const view = statView(stat);
  if (!view.isFile || view.isSymbolicLink || view.uid !== uid || view.nlink !== 1 ||
      (view.mode & 0o7777) !== 0o600 || view.size !== size ||
      selected && (view.dev !== selected.dev || view.ino !== selected.ino)) throw 0;
  return view;
}
function sameReadState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.nlink === right.nlink && (left.mode & 0o7777) === (right.mode & 0o7777) &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function readBytesCount(result) {
  if (!result || typeof result !== 'object' || types.isProxy(result)) throw 0;
  const descriptor = Object.getOwnPropertyDescriptor(result, 'bytesRead');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value)) throw 0;
  return descriptor.value;
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
async function writeEncodedReceipt(encoded, destination, ports, schema) {
  let target;
  let capability;
  try {
    target = validateDestination(destination);
    capability = validatePorts(ports);
  } catch (error) {
    encoded.fill(0);
    if (error instanceof ReceiptError && errorCodes.has(error.code)) throw error;
    fail('INVALID_PORTS');
  }
  let handle = null;
  let closeAttempted = false;
  let readback = null;
  let failure = null;
  let acknowledgement = null;
  const path = join(target.directory, target.filename);
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const parent = parentView(
      await callMethod(capability.fs, 'lstat', [target.directory]),
      capability.uid
    );
    handle = await callMethod(capability.fs, 'open', [path, flags, 0o600]);
    const initial = leafView(await callMethod(handle, 'stat'), capability.uid, 0);
    await callMethod(handle, 'writeFile', [encoded]);
    const beforeRead = leafView(
      await callMethod(handle, 'stat'),
      capability.uid,
      encoded.length,
      initial
    );
    readback = new Uint8Array(encoded.length + 1);
    let offset = 0;
    let reads = 0;
    let eofObserved = false;
    while (offset < readback.length && reads < 65) {
      const requested = Math.min(4096, readback.length - offset);
      const result = await callMethod(handle, 'read', [readback, offset, requested, offset]);
      reads++;
      const count = readBytesCount(result);
      if (count < 0 || count > requested) throw 0;
      if (count === 0) {
        if (offset !== encoded.length) throw 0;
        eofObserved = true;
        break;
      }
      offset += count;
      if (offset > encoded.length) throw 0;
    }
    if (!eofObserved || offset !== encoded.length || reads > 65 ||
        !bytesEqual(readback.subarray(0, offset), encoded) ||
        sha256(readback.subarray(0, offset)) !== sha256(encoded)) throw 0;
    const afterRead = leafView(
      await callMethod(handle, 'stat'),
      capability.uid,
      encoded.length,
      initial
    );
    if (!sameReadState(beforeRead, afterRead)) throw 0;
    parentView(await callMethod(capability.fs, 'lstat', [target.directory]), capability.uid, parent);
    const finalLeaf = leafView(
      await callMethod(capability.fs, 'lstat', [path]),
      capability.uid,
      encoded.length,
      initial
    );
    const finalHandle = leafView(
      await callMethod(handle, 'stat'),
      capability.uid,
      encoded.length,
      initial
    );
    if (!sameReadState(afterRead, finalLeaf) || !sameReadState(afterRead, finalHandle)) throw 0;
    acknowledgement = Object.freeze({
      schema,
      status: 'RECORDED',
      byte_count: encoded.length,
      sha256: sha256(encoded),
      crash_durability: 'NOT_ESTABLISHED',
      source_authenticity: 'NOT_ESTABLISHED'
    });
  } catch {
    failure = 'WRITE_FAILED';
  } finally {
    if (handle !== null && !closeAttempted) {
      closeAttempted = true;
      try {
        await callMethod(handle, 'close');
      } catch {
        failure ??= 'WRITE_FAILED';
        acknowledgement = null;
      }
    }
    readback?.fill(0);
    encoded.fill(0);
  }
  if (failure) fail(failure);
  return acknowledgement;
}
export async function writeProjectResultReceipt(value, destination, ports) {
  const encoded = encodeValidatedReceipt(value);
  return writeEncodedReceipt(encoded,destination,ports,'squire2.project_result_write_receipt.v1');
}
export async function writeNativeProjectResultReceipt(liveResult, destination, ports) {
  const encoded = encodeValidatedNativeReceipt(liveResult);
  return writeEncodedReceipt(encoded,destination,ports,'squire3.native_project_result_write_receipt.v1');
}
export async function writeNativeProjectCodingObservationResultReceipt(liveResult,destination,ports){
  const receipt=createNativeProjectCodingObservationResultReceipt(liveResult);
  const encoded=encodeEnvelope(receipt,true,true);
  return writeEncodedReceipt(encoded,destination,ports,'squire3.native_project_coding_observation_result_write_receipt.v1');
}
export async function writeNativeProjectLargeObservationResultReceipt(liveResult,destination,ports){
  const receipt=createNativeProjectLargeObservationResultReceipt(liveResult);
  const encoded=encodeEnvelope(receipt,true,false,true);
  return writeEncodedReceipt(encoded,destination,ports,'squire3.native_project_large_observation_result_write_receipt.v1');
}
