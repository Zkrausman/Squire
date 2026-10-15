import { digest } from './contracts.mjs';

export const DIAGNOSTIC_FEEDBACK_MAX_BYTES = 8192;
export const WITHHELD_DIAGNOSTIC_FEEDBACK = Object.freeze({
  version: 1,
  state: 'withheld',
  message: 'Verification diagnostics withheld by configured disclosure policy.'
});
export const UNAVAILABLE_DIAGNOSTIC_FEEDBACK = Object.freeze({
  version: 1,
  state: 'unavailable',
  message: 'Verification diagnostics unavailable.'
});

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_POLICY_BYTES = 1024 * 1024;
const checkNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const disclosureKeys = new Set(['version', 'stdout', 'stderr', 'metadata']);
const streamNames = ['stdout', 'stderr'];
const legacyVerificationKeys = ['passed', 'results', 'notRun', 'failureTail', 'failedChecks', 'stdout', 'stderr', 'diagnosticFeedbackV1'];
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => Buffer.byteLength(value, 'utf8');
const serializedBytes = value => byteLength(JSON.stringify(value));

function parseDisclosure(check) {
  const declaration = check?.diagnosticDisclosureV1;
  if (declaration === undefined) return { stdout: 'withheld', stderr: 'withheld', metadata: 'withheld' };
  if (!isObject(declaration) || declaration.version !== 1 || Object.keys(declaration).some(key => !disclosureKeys.has(key))) return null;
  for (const key of ['stdout', 'stderr', 'metadata']) {
    if (Object.hasOwn(declaration, key) && !['approved', 'withheld'].includes(declaration[key])) return null;
  }
  return { stdout: declaration.stdout ?? 'withheld', stderr: declaration.stderr ?? 'withheld', metadata: declaration.metadata ?? 'withheld' };
}

function boundedChecks(checks) {
  if (!Array.isArray(checks) || checks.length > 30) return false;
  let bytes = 0;
  for (const check of checks) {
    if (!isObject(check) || !checkNamePattern.test(check.name ?? '') || !Array.isArray(check.argv) || check.argv.length > 100) return false;
    bytes += byteLength(check.name);
    for (const arg of check.argv) {
      if (typeof arg !== 'string' || arg.length > 16000 || arg.includes('\0')) return false;
      bytes += byteLength(arg);
      if (bytes > MAX_POLICY_BYTES) return false;
    }
    if (!Number.isSafeInteger(check.timeoutSeconds)) return false;
    const policy = parseDisclosure(check);
    if (!policy) return false;
    bytes += 32;
    if (bytes > MAX_POLICY_BYTES) return false;
  }
  return true;
}

function normalizeBinding(binding, checks) {
  if (!isObject(binding) || binding.phase !== 'candidate-verification' || !boundedChecks(checks) ||
      !shaPattern.test(binding.headSha ?? '') || !shaPattern.test(binding.treeSha ?? '')) return null;
  const policyDigest = digest(checks);
  if (binding.policyDigest !== policyDigest) return null;
  return { headSha: binding.headSha, treeSha: binding.treeSha, policyDigest };
}

function scalarString(input) {
  let output = '';
  for (const scalar of input) {
    const point = scalar.codePointAt(0);
    output += point >= 0xd800 && point <= 0xdfff ? '\ufffd' : scalar;
  }
  return output;
}

function isScalarString(input) {
  for (const scalar of input) {
    const point = scalar.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

function normalizedMetadata(check, result) {
  const flags = ['stopped', 'timedOut', 'outputExceeded'];
  const flagValues = Object.fromEntries(flags.map(key => [key, result[key]]));
  if (flags.some(key => typeof flagValues[key] !== 'boolean')) return null;
  const exitCode = result.exitCode;
  if (!(exitCode === null || Number.isSafeInteger(exitCode))) return null;
  const launchError = result.launchError;
  if (!(launchError === undefined || launchError === null || typeof launchError === 'boolean' || typeof launchError === 'string')) return null;
  const launchFailed = typeof launchError === 'string' ? launchError.length > 0 : launchError === true;
  return {
    check: check.name,
    exitCode,
    ...flagValues,
    launchError: launchFailed,
    captureIncomplete: flagValues.outputExceeded || flagValues.timedOut || flagValues.stopped || launchFailed
  };
}

function takeHead(text, limit) {
  let value = '', bytes = 0, end = 0;
  for (const scalar of text) {
    const size = byteLength(scalar);
    if (bytes + size > limit) break;
    value += scalar; bytes += size; end += scalar.length;
  }
  return { value, bytes, end };
}

function takeTail(text, limit, after) {
  let value = '', bytes = 0, start = text.length;
  while (start > after) {
    let scalarStart = start - 1;
    const last = text.charCodeAt(scalarStart);
    if (last >= 0xdc00 && last <= 0xdfff && scalarStart > after) {
      const first = text.charCodeAt(scalarStart - 1);
      if (first >= 0xd800 && first <= 0xdbff) scalarStart--;
    }
    const scalar = text.slice(scalarStart, start), size = byteLength(scalar);
    if (bytes + size > limit) break;
    value = scalar + value; bytes += size; start = scalarStart;
  }
  return { value, bytes };
}

function clipHeadTail(text, allowance) {
  const totalBytes = byteLength(text);
  if (totalBytes <= allowance) return { head: text, tail: '', shownBytes: totalBytes, omittedBytes: 0, truncated: false };
  const head = takeHead(text, Math.floor(allowance / 2));
  const tail = takeTail(text, allowance - head.bytes, head.end);
  const shownBytes = head.bytes + tail.bytes;
  return { head: head.value, tail: tail.value, shownBytes, omittedBytes: totalBytes - shownBytes, truncated: totalBytes > shownBytes };
}

function allocate(streams, budget) {
  const allowances = streams.map(() => 0);
  let remaining = budget;
  const active = streams.map((stream, index) => ({ index, bytes: byteLength(stream.text) })).filter(item => item.bytes > 0);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    let used = 0;
    for (const item of active) {
      const grant = Math.min(share, item.bytes - allowances[item.index], remaining - used);
      if (grant <= 0) continue;
      allowances[item.index] += grant; used += grant;
      if (used >= remaining) break;
    }
    if (!used) break;
    remaining -= used;
    for (let index = active.length - 1; index >= 0; index--) {
      const item = active[index];
      if (allowances[item.index] >= item.bytes) active.splice(index, 1);
    }
  }
  return allowances;
}

function outputProjection(records, contentBudget) {
  const streams = records.flatMap(record => record.streams.map(stream => ({ record, ...stream })));
  const allowances = allocate(streams, contentBudget);
  let streamIndex = 0;
  const entries = records.map(record => ({
    ...(record.metadataApproved ? { check: record.checkName, metadata: record.metadata } : {}),
    streams: record.streams.map(stream => {
      const clipped = clipHeadTail(stream.text, allowances[streamIndex++]);
      return {
        name: stream.name, head: clipped.head, tail: clipped.tail,
        ...(record.metadataApproved ? { shownBytes: clipped.shownBytes, omittedBytes: clipped.omittedBytes, truncated: clipped.truncated } : {})
      };
    })
  }));
  return { version: 1, state: 'ready', entries };
}

function sameKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function validSafePayload(payload, sourceRecords) {
  if (!sameKeys(payload, ['version', 'state', 'entries']) || payload.version !== 1 || payload.state !== 'ready' ||
      !Array.isArray(payload.entries) || payload.entries.length < 1 || payload.entries.length > 30 || payload.entries.length !== sourceRecords.length) return false;
  for (let index = 0; index < payload.entries.length; index++) {
    const entry = payload.entries[index], source = sourceRecords[index];
    if (!isObject(entry) || !Array.isArray(entry.streams) || entry.streams.length < 1 || entry.streams.length > 2 ||
        Object.hasOwn(entry, 'check') !== source.metadataApproved || Object.hasOwn(entry, 'metadata') !== source.metadataApproved ||
        (source.metadataApproved && entry.check !== source.checkName)) return false;
    if (source.metadataApproved && (!sameKeys(entry.metadata, ['check', 'exitCode', 'stopped', 'timedOut', 'outputExceeded', 'launchError', 'captureIncomplete']) ||
        entry.metadata.check !== source.checkName || !(entry.metadata.exitCode === null || Number.isSafeInteger(entry.metadata.exitCode)) ||
        ['stopped', 'timedOut', 'outputExceeded', 'launchError', 'captureIncomplete'].some(key => typeof entry.metadata[key] !== 'boolean') ||
        entry.metadata.captureIncomplete !== (entry.metadata.stopped || entry.metadata.timedOut || entry.metadata.outputExceeded || entry.metadata.launchError))) return false;
    if (entry.streams.length !== source.streams.length) return false;
    for (let streamIndex = 0; streamIndex < entry.streams.length; streamIndex++) {
      const stream = entry.streams[streamIndex], sourceStream = source.streams[streamIndex];
      const allowedKeys = source.metadataApproved ? ['name', 'head', 'tail', 'shownBytes', 'omittedBytes', 'truncated'] : ['name', 'head', 'tail'];
      if (!sameKeys(stream, allowedKeys) || stream.name !== sourceStream.name || !streamNames.includes(stream.name) ||
          typeof stream.head !== 'string' || typeof stream.tail !== 'string' || stream.head.length + stream.tail.length > DIAGNOSTIC_FEEDBACK_MAX_BYTES ||
          !isScalarString(stream.head) || !isScalarString(stream.tail)) return false;
      if (source.metadataApproved && (!Number.isSafeInteger(stream.shownBytes) || stream.shownBytes < 0 ||
          !Number.isSafeInteger(stream.omittedBytes) || stream.omittedBytes < 0 || typeof stream.truncated !== 'boolean' ||
          stream.truncated !== (stream.omittedBytes > 0) || stream.shownBytes !== byteLength(stream.head) + byteLength(stream.tail))) return false;
    }
  }
  return true;
}

function storeProjection(payload, records) {
  return {
    version: 1,
    binding: records.binding,
    state: 'ready',
    records: records.map((record, index) => ({
      checkName: record.checkName,
      metadataApproved: record.metadataApproved,
      ...(record.metadataApproved ? { metadata: record.metadata } : {}),
      streams: payload.entries[index].streams.map(stream => ({ ...stream }))
    }))
  };
}

function createDiagnosticFeedbackV1Unsafe(checks, results, binding) {
  if (!Array.isArray(checks) || checks.length > 30) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
  // Withheld streams (including metadata-only declarations) are a constant
  // decision. Do not inspect results, check identifiers, argv, or bindings on
  // that path; those values are outside the approved disclosure projection.
  let anyStreamApproved = false;
  for (const check of checks) {
    const policy = parseDisclosure(check);
    if (policy?.stdout === 'approved' || policy?.stderr === 'approved') anyStreamApproved = true;
  }
  if (!anyStreamApproved) return WITHHELD_DIAGNOSTIC_FEEDBACK;
  if (!Array.isArray(results) || results.length > 30 || results.length > checks.length || !boundedChecks(checks)) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
  const sourceRecords = [];
  let approvedBytes = 0;
  for (let index = 0; index < results.length; index++) {
    const check = checks[index], result = results[index];
    if (!isObject(check) || !checkNamePattern.test(check.name ?? '') || !isObject(result) || result.name !== check.name || typeof result.passed !== 'boolean') return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
    if (result.passed) continue;
    const policy = parseDisclosure(check);
    if (!policy) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
    const streams = [];
    for (const name of streamNames) {
      if (policy[name] !== 'approved') continue;
      const raw = result[name];
      if (raw !== undefined && typeof raw !== 'string') return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
      const value = raw ?? '';
      if (value.length > MAX_CAPTURE_BYTES - approvedBytes) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
      approvedBytes += byteLength(value);
      if (approvedBytes > MAX_CAPTURE_BYTES) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
      streams.push({ name, text: scalarString(value) });
    }
    // Metadata alone never authorizes exporting a record or reveals that one failed.
    if (!streams.length) continue;
    const metadataApproved = policy.metadata === 'approved';
    const metadata = metadataApproved ? normalizedMetadata(check, result) : undefined;
    if (metadataApproved && !metadata) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
    sourceRecords.push({ checkName: check.name, metadataApproved,
      ...(metadataApproved ? { metadata } : {}), streams });
  }
  if (!sourceRecords.length) return WITHHELD_DIAGNOSTIC_FEEDBACK;

  const safeBinding = normalizeBinding(binding, checks);
  if (!safeBinding) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
  sourceRecords.binding = safeBinding;
  const emptyPayload = outputProjection(sourceRecords.map(record => ({ ...record, streams: record.streams.map(stream => ({ ...stream, text: '' })) })), 0);
  const baseBytes = serializedBytes(emptyPayload);
  if (baseBytes > DIAGNOSTIC_FEEDBACK_MAX_BYTES) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
  let budget = DIAGNOSTIC_FEEDBACK_MAX_BYTES - baseBytes;
  for (let attempt = 0; attempt < 48; attempt++) {
    const payload = outputProjection(sourceRecords, budget);
    const bytes = serializedBytes(payload);
    if (bytes <= DIAGNOSTIC_FEEDBACK_MAX_BYTES && validSafePayload(payload, sourceRecords)) return storeProjection(payload, sourceRecords);
    const excess = bytes - DIAGNOSTIC_FEEDBACK_MAX_BYTES;
    const next = Math.max(0, Math.floor(budget * (DIAGNOSTIC_FEEDBACK_MAX_BYTES - baseBytes) / Math.max(1, bytes - baseBytes)) - Math.max(1, excess));
    budget = next >= budget ? Math.floor(budget * 0.75) : next;
  }
  return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
}

/** Build a bounded private projection; failures remain additive and cannot change verification outcome. */
export function createDiagnosticFeedbackV1(checks, results, binding) {
  try { return createDiagnosticFeedbackV1Unsafe(checks, results, binding); }
  catch { return UNAVAILABLE_DIAGNOSTIC_FEEDBACK; }
}

function validMetadata(metadata, checkName) {
  return sameKeys(metadata, ['check', 'exitCode', 'stopped', 'timedOut', 'outputExceeded', 'launchError', 'captureIncomplete']) &&
    metadata.check === checkName && (metadata.exitCode === null || Number.isSafeInteger(metadata.exitCode)) &&
    ['stopped', 'timedOut', 'outputExceeded', 'launchError', 'captureIncomplete'].every(key => typeof metadata[key] === 'boolean') &&
    metadata.captureIncomplete === (metadata.stopped || metadata.timedOut || metadata.outputExceeded || metadata.launchError);
}

/** Revalidate persisted feedback against the current exact candidate and check policy. */
export function diagnosticFeedbackForPrompt(stored, checks, expectedBinding) {
  try {
    if (sameKeys(stored, ['version', 'state', 'message']) && stored.version === 1 && stored.state === 'withheld' &&
        stored.message === WITHHELD_DIAGNOSTIC_FEEDBACK.message) return WITHHELD_DIAGNOSTIC_FEEDBACK;
    if (sameKeys(stored, ['version', 'state', 'message']) && stored.version === 1 && stored.state === 'unavailable' &&
        stored.message === UNAVAILABLE_DIAGNOSTIC_FEEDBACK.message) return UNAVAILABLE_DIAGNOSTIC_FEEDBACK;
    if (!isObject(stored) || !sameKeys(stored, ['version', 'binding', 'state', 'records']) || stored.version !== 1 ||
        stored.state !== 'ready' || !isObject(stored.binding) || !sameKeys(stored.binding, ['headSha', 'treeSha', 'policyDigest']) ||
        !Array.isArray(stored.records) || stored.records.length < 1 || stored.records.length > 30) return WITHHELD_DIAGNOSTIC_FEEDBACK;
    const current = normalizeBinding({ phase: 'candidate-verification', headSha: expectedBinding?.headSha,
      treeSha: expectedBinding?.treeSha, policyDigest: expectedBinding?.policyDigest }, checks);
    if (!current || stored.binding.headSha !== current.headSha || stored.binding.treeSha !== current.treeSha ||
        stored.binding.policyDigest !== current.policyDigest) return WITHHELD_DIAGNOSTIC_FEEDBACK;
    const entries = [];
    let previousCheckIndex = -1;
    for (const record of stored.records) {
      if (!isObject(record) || !(sameKeys(record, ['checkName', 'metadataApproved', 'metadata', 'streams']) ||
          sameKeys(record, ['checkName', 'metadataApproved', 'streams'])) || !checkNamePattern.test(record.checkName ?? '')) return WITHHELD_DIAGNOSTIC_FEEDBACK;
      const checkIndex = checks.findIndex(item => item.name === record.checkName);
      const check = checkIndex >= 0 ? checks[checkIndex] : null, policy = check ? parseDisclosure(check) : null;
      if (checkIndex <= previousCheckIndex) return WITHHELD_DIAGNOSTIC_FEEDBACK;
      previousCheckIndex = checkIndex;
      if (!policy || record.metadataApproved !== (policy.metadata === 'approved') || !Array.isArray(record.streams) ||
          record.streams.length < 1 || record.streams.length > 2) return WITHHELD_DIAGNOSTIC_FEEDBACK;
      if (record.metadataApproved ? !validMetadata(record.metadata, check.name) : Object.hasOwn(record, 'metadata')) return WITHHELD_DIAGNOSTIC_FEEDBACK;
      const seen = new Set(), streams = [];
      let previousStreamIndex = -1;
      for (const stream of record.streams) {
        if (!isObject(stream) || !streamNames.includes(stream.name) || seen.has(stream.name) || policy[stream.name] !== 'approved' ||
            typeof stream.head !== 'string' || typeof stream.tail !== 'string' || stream.head.length + stream.tail.length > DIAGNOSTIC_FEEDBACK_MAX_BYTES ||
            !isScalarString(stream.head) || !isScalarString(stream.tail)) return WITHHELD_DIAGNOSTIC_FEEDBACK;
        const streamIndex = streamNames.indexOf(stream.name);
        if (streamIndex <= previousStreamIndex) return WITHHELD_DIAGNOSTIC_FEEDBACK;
        previousStreamIndex = streamIndex;
        const keys = record.metadataApproved ? ['name', 'head', 'tail', 'shownBytes', 'omittedBytes', 'truncated'] : ['name', 'head', 'tail'];
        if (!sameKeys(stream, keys)) return WITHHELD_DIAGNOSTIC_FEEDBACK;
        if (record.metadataApproved && (!Number.isSafeInteger(stream.shownBytes) || stream.shownBytes < 0 ||
            !Number.isSafeInteger(stream.omittedBytes) || stream.omittedBytes < 0 || typeof stream.truncated !== 'boolean' ||
            stream.truncated !== (stream.omittedBytes > 0) || stream.shownBytes !== byteLength(stream.head) + byteLength(stream.tail))) return WITHHELD_DIAGNOSTIC_FEEDBACK;
        seen.add(stream.name); streams.push({ ...stream });
      }
      entries.push({ ...(record.metadataApproved ? { check: check.name, metadata: record.metadata } : {}), streams });
    }
    const payload = { version: 1, state: 'ready', entries };
    if (serializedBytes(payload) > DIAGNOSTIC_FEEDBACK_MAX_BYTES) return WITHHELD_DIAGNOSTIC_FEEDBACK;
    return payload;
  } catch { return WITHHELD_DIAGNOSTIC_FEEDBACK; }
}

function safeReasonFields(reason, allowed) {
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(reason, key)).map(key => [key, reason[key]]));
}

/** Sanitize known verification members before prompt serialization; never revive raw legacy tails. */
export function repairReasonForPrompt(reason, checks, expectedBinding) {
  if (!isObject(reason)) return reason == null ? reason : { code: 'verification_failed', diagnosticFeedbackV1: WITHHELD_DIAGNOSTIC_FEEDBACK };
  const render = value => diagnosticFeedbackForPrompt(value, checks, expectedBinding);
  const hasLegacyVerification = legacyVerificationKeys.some(key => Object.hasOwn(reason, key));
  const directBranch = reason.code === 'verification_failed' || hasLegacyVerification;
  const failureBranch = reason.code === 'authorized_correction' || Object.hasOwn(reason, 'actualFailure');
  const continuationBranch = reason.code === 'interrupted_continuation' || Object.hasOwn(reason, 'actualPartialVerification');
  if (Number(directBranch) + Number(failureBranch) + Number(continuationBranch) > 1) {
    return { code: 'verification_failed', diagnosticFeedbackV1: WITHHELD_DIAGNOSTIC_FEEDBACK };
  }
  if (reason.code === 'verification_failed') return { code: 'verification_failed', diagnosticFeedbackV1: render(reason.diagnosticFeedbackV1) };
  if (reason.code === 'authorized_correction') {
    const safe = safeReasonFields(reason, ['code', 'message', 'outcome', 'instructions']);
    if (reason.actualFailure?.kind === 'failed_review') {
      return { ...safe, actualFailure: safeReasonFields(reason.actualFailure,
        ['kind', 'reviewDigest', 'headSha', 'summary', 'findings', 'checklist']) };
    }
    if (reason.actualFailure?.kind === 'failed_verification') {
      return { ...safe,
        actualFailure: { kind: 'failed_verification', diagnosticFeedbackV1: render(reason.actualFailure.diagnosticFeedbackV1) } };
    }
    return safe;
  }
  if (reason.code === 'interrupted_continuation' || Object.hasOwn(reason, 'actualPartialVerification')) {
    return { ...safeReasonFields(reason, ['code', 'message', 'actualPartialReview', 'instructions']),
      actualPartialVerification: render(reason.actualPartialVerification?.diagnosticFeedbackV1) };
  }
  if (Object.hasOwn(reason, 'actualFailure')) {
    if (reason.actualFailure?.kind === 'failed_verification') {
      return { ...safeReasonFields(reason, ['code', 'message', 'outcome', 'instructions']),
        actualFailure: { kind: 'failed_verification', diagnosticFeedbackV1: render(reason.actualFailure.diagnosticFeedbackV1) } };
    }
    return safeReasonFields(reason, ['code', 'message', 'outcome', 'instructions']);
  }
  if (hasLegacyVerification) {
    return { code: 'verification_failed', diagnosticFeedbackV1: WITHHELD_DIAGNOSTIC_FEEDBACK };
  }
  return reason;
}
