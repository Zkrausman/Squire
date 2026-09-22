import { PhaseExecutionError, classifyExecutionFailure } from "./execution-failure.js";
import type { ReportEvidence } from "./report-evidence.js";
export interface ReportCapture {
  /** Compatibility rendering only. Evidence bytes must verify and strictly
   * decode before this text can supply any report facts. */
  readonly raw: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly timestamp: string;
  readonly evidence: ReportEvidence;
}
export class InvalidPhaseHandoff extends PhaseExecutionError {
  constructor(readonly capture: ReportCapture, diagnostic: string) { super("protocol", diagnostic); }
}
export class ReportExecutionFailure extends PhaseExecutionError {
  constructor(readonly capture: ReportCapture, cause: unknown) {
    super(classifyExecutionFailure(cause), cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
export function rejectAmbiguousJson(raw: string): void {
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (const token of raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/gu) ?? []) {
    if (token === "{") stack.push({ keys: new Set(), expectingKey: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else {
      const top = stack.at(-1);
      if (top && token === ",") top.expectingKey = true;
      else if (top?.expectingKey && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (top.keys.has(key)) throw new Error("duplicate JSON member makes report provenance ambiguous");
        top.keys.add(key); top.expectingKey = false;
      }
    }
    if (stack.length > 100) throw new Error("report nesting exceeds bound");
  }
}
