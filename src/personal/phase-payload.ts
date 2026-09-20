import { validatePhaseResultPayloadShape, validatePhaseResultShape } from "./phase-result.js";
import type { PhaseProfile } from "./model-policy.js";
import type { PhaseInput, PhaseResult } from "./types.js";

export function parsePhaseResult(raw: string, input: PhaseInput, sessionId: string, sessionFile: string, profile: PhaseProfile): PhaseResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${input.phase} wrote malformed result JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${input.phase} result is not an object`);
  validatePhaseResultPayloadShape(value, input.phase);
  const payload = value;

  if (
    (hasOwn(payload, "runId") && payload.runId !== input.runId)
    || (hasOwn(payload, "phase") && payload.phase !== input.phase)
    || (hasOwn(payload, "attempt") && payload.attempt !== input.attempt)
    || (hasOwn(payload, "sessionId") && payload.sessionId !== sessionId)
    || (hasOwn(payload, "sessionFile") && payload.sessionFile !== sessionFile)
  ) throw new Error(`${input.phase} result identity mismatch`);
  if (hasOwn(payload, "inputHead") && payload.inputHead !== input.expectedHead) throw new Error(`${input.phase} result Git identity mismatch`);
  const echoedProfile = payload.profile;
  if (hasOwn(payload, "profile") && (
    echoedProfile === undefined
    || echoedProfile.provider !== profile.provider
    || echoedProfile.model !== profile.model
    || echoedProfile.thinking !== profile.thinking
  )) throw new Error(`${input.phase} result profile identity mismatch`);

  const result: unknown = {
    runId: input.runId,
    phase: input.phase,
    attempt: input.attempt,
    sessionId,
    sessionFile,
    inputHead: input.expectedHead,
    outputHead: payload.outputHead,
    status: payload.status,
    summary: payload.summary,
    details: payload.details,
    profile: { ...profile },
  };
  validatePhaseResultShape(result, input.phase);
  return result;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

