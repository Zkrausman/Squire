import { digest, isSha, VERSION } from './contracts.mjs';

const roles = new Set(['plan', 'implement', 'review']);
const capabilityResults = new Set(['passed', 'failed', 'denied', 'unsupported', 'unknown', 'not_required']);
const routeFields = ['kind', 'authentication'];
const requirementFields = ['version', 'route', 'role', 'baseSha', 'tool', 'fingerprint', 'requiredCapabilities', 'cleanupDeadlineMs'];
const toolRequirementFields = ['name', 'version', 'fingerprint'];
const toolObservationFields = ['available', 'name', 'version', 'fingerprint'];
const observationFields = ['version', 'receiptId', 'requirementsDigest', 'route', 'role', 'baseSha', 'tool', 'fingerprint', 'capabilities', 'cleanup'];
const capabilityFields = ['name', 'status', 'evidenceKind', 'operation', 'operationId', 'receiptDigest', 'fingerprint'];
const cleanupFields = ['status', 'evidenceKind', 'operationId', 'receiptDigest', 'fingerprint', 'durationMs', 'deadlineMs'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !value.includes('\0');
const token = value => text(value) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const onlyKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!record(value) && !Array.isArray(value)) throw new TypeError('Route requirements must contain JSON values');
  if (seen.has(value)) throw new TypeError('Route requirements cannot be cyclic');
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map(item => canonical(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], seen)]));
  seen.delete(value);
  return result;
}

/** Stable reference used by a future trusted probe producer; this is not proof of receipt origin. */
export function routeRequirementsDigest(requirements) {
  try { return digest(JSON.stringify(canonical(requirements))); }
  catch { return null; }
}

/**
 * Evaluate route evidence without performing I/O or authorizing a launch.
 * Callers must verify evidence provenance and the live boundary separately.
 */
export function evaluateRouteAdmission(requirements, observation) {
  const blockers = [];
  const add = (code, capability) => {
    const item = capability ? { code, capability } : { code };
    if (!blockers.some(existing => existing.code === item.code && existing.capability === item.capability)) blockers.push(item);
  };

  if (!record(requirements) || !record(observation)) return { eligible: false, blockers: [{ code: 'route_evidence_missing' }] };
  if (!onlyKeys(requirements, requirementFields) || !onlyKeys(observation, observationFields)) add('route_evidence_unsupported');
  if (requirements.version !== VERSION || observation.version !== VERSION) add('route_evidence_unsupported');
  if (!token(observation.receiptId)) add('route_receipt_missing');

  if (!onlyKeys(requirements.route, routeFields) || requirements.route.kind !== 'codex' || requirements.route.authentication !== 'subscription') {
    add('route_runtime_unsupported');
  }
  if (!onlyKeys(observation.route, routeFields) || observation.route.kind !== requirements.route?.kind || observation.route.authentication !== requirements.route?.authentication) {
    add('route_runtime_mismatch');
  }

  if (!roles.has(requirements.role) || !roles.has(observation.role)) add('route_role_unknown');
  else if (requirements.role !== observation.role) add('route_role_mismatch');

  if (!isSha(requirements.baseSha) || !isSha(observation.baseSha)) add('route_base_unknown');
  else if (requirements.baseSha !== observation.baseSha) add('route_base_mismatch');

  const expectedTool = requirements.tool;
  const observedTool = observation.tool;
  if (!onlyKeys(expectedTool, toolRequirementFields) || !token(expectedTool.name) || !text(expectedTool.version) || !sha256(expectedTool.fingerprint)) {
    add('route_tool_requirement_missing');
  }
  if (!onlyKeys(observedTool, toolObservationFields) || observedTool.available !== true) {
    add('route_tool_missing');
  } else if (expectedTool?.name !== observedTool.name || expectedTool?.version !== observedTool.version || expectedTool?.fingerprint !== observedTool.fingerprint) {
    add('route_tool_mismatch');
  }

  if (!sha256(requirements.fingerprint) || !sha256(observation.fingerprint)) add('route_fingerprint_missing');
  else if (requirements.fingerprint !== observation.fingerprint) add('route_fingerprint_changed');

  if (!isSha(observation.baseSha) || !sha256(observation.requirementsDigest)) add('route_requirements_reference_missing');
  else if (observation.requirementsDigest !== routeRequirementsDigest(requirements)) add('route_requirements_changed');

  const required = requirements.requiredCapabilities;
  if (!Array.isArray(required) || required.length === 0 || required.length > 50 || required.some(name => !token(name)) || new Set(required).size !== required.length) {
    add('route_capability_requirements_missing');
  }
  const capabilities = observation.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > 100) {
    add('route_capability_evidence_missing');
  } else {
    const byName = new Map();
    for (const item of capabilities) {
      if (!onlyKeys(item, capabilityFields) || !token(item.name) || !capabilityResults.has(item.status)) {
        add('route_capability_evidence_unsupported');
        continue;
      }
      if (byName.has(item.name)) add('route_capability_ambiguous', item.name);
      else byName.set(item.name, item);
    }
    if (Array.isArray(required)) for (const name of required) {
      const item = byName.get(name);
      if (!item) { add('route_capability_missing', name); continue; }
      if (item.status === 'denied') add('route_capability_denied', name);
      else if (item.status === 'failed') add('route_capability_failed', name);
      else if (item.status !== 'passed') add('route_capability_unavailable', name);
      if (item.evidenceKind !== 'observed' || !token(item.operation) || !token(item.operationId) || !sha256(item.receiptDigest)) {
        add('route_capability_not_observed', name);
      }
      if (!sha256(observation.fingerprint) || item.fingerprint !== observation.fingerprint) add('route_fingerprint_changed', name);
    }
  }

  if (!record(observation.cleanup) || !onlyKeys(observation.cleanup, cleanupFields)) {
    add('route_cleanup_missing');
  } else {
    const cleanup = observation.cleanup;
    if (cleanup.status === 'denied' || cleanup.status === 'failed') add('route_cleanup_failed');
    else if (cleanup.status !== 'passed') add('route_cleanup_unavailable');
    if (cleanup.evidenceKind !== 'observed' || !token(cleanup.operationId) || !sha256(cleanup.receiptDigest)) add('route_cleanup_not_observed');
    if (!sha256(observation.fingerprint) || cleanup.fingerprint !== observation.fingerprint) add('route_fingerprint_changed');
    if (!Number.isSafeInteger(requirements.cleanupDeadlineMs) || requirements.cleanupDeadlineMs <= 0 ||
        !Number.isSafeInteger(cleanup.durationMs) || cleanup.durationMs < 0 || cleanup.deadlineMs !== requirements.cleanupDeadlineMs ||
        cleanup.durationMs > cleanup.deadlineMs) add('route_cleanup_unbounded');
  }

  return { eligible: blockers.length === 0, blockers };
}
