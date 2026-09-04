import type { Clock } from "../../src/control/domain.js";

export interface ControllableClock extends Clock {
  advance(milliseconds: number): void;
}

/** A deterministic test clock. Advancing time is explicit; no wall-clock
 * deadline or sleep is needed to cross a retention boundary. */
export function createControllableClock(start = Date.parse("2026-09-01T12:00:00Z")): ControllableClock {
  if (!Number.isSafeInteger(start)) throw new Error("controllable clock start must be a safe integer");
  let current = start;
  const advance = (milliseconds: number): void => {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(current + milliseconds)) throw new Error("controllable clock advance must be a non-negative safe integer");
    current += milliseconds;
  };
  return {
    now: () => current,
    advance,
    sleep: async (milliseconds, signal) => {
      if (signal?.aborted) throw new Error("controllable clock sleep was aborted");
      advance(milliseconds);
    },
  };
}
