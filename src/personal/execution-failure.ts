/** Trusted adapter signals only. Never infer authentication or retry safety from text. */
export const EXECUTION_FAILURES = ["cancelled", "timeout", "authentication", "infrastructure", "protocol", "unknown"] as const;
export type ExecutionFailure = typeof EXECUTION_FAILURES[number];
export class PhaseExecutionError extends Error {
  constructor(readonly classification: ExecutionFailure, message: string, options?: ErrorOptions) { super(message, options); }
}
export function classifyExecutionFailure(error: unknown, signal?: AbortSignal): ExecutionFailure {
  if (signal?.aborted) return "cancelled";
  return error instanceof PhaseExecutionError ? error.classification : "unknown";
}
