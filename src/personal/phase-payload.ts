import { validatePhaseResultPayloadShape, validatePhaseResultShape } from "./phase-result.js";
import { rejectAmbiguousJson } from "./report-capture.js";
import type { PhaseProfile } from "./model-policy.js";
import type { PhaseInput, PhaseResult } from "./types.js";
export function parsePhaseResult(raw: string, input: PhaseInput, sessionId: string, sessionFile: string, profile: PhaseProfile): PhaseResult {
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("phase report exceeds bound");
  rejectAmbiguousJson(raw);
  const payload: unknown = JSON.parse(raw);
  validatePhaseResultPayloadShape(payload, input.phase);
  const { version: _version, ...fields } = payload;
  const result = { ...fields, runId: input.runId, phase: input.phase, attempt: input.attempt, sessionId, sessionFile, inputHead: input.expectedHead, profile };
  validatePhaseResultShape(result, input.phase);
  return result;
}
