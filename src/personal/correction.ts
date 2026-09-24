import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validatePhaseResultShape } from "./phase-result.js";
import { decimalText, decimalUnits } from "./telemetry-stream.js";
import { validateEvidenceRef, type ReportEvidence } from "./report-evidence.js";
import type { ImplementPhaseResult, VerifyPhaseResult, HostCommandEvidence } from "./types.js";

/** Feedback authorizes only another unprivileged Implement, never acceptance. */
export interface CorrectionPolicy { readonly version: 1; readonly maxCorrections: 0 | 1; readonly maxRecordedCostUsd: string }
export function correctionPolicy(maxCorrections: unknown = 1, maxRecordedCostUsd: unknown = "10"): CorrectionPolicy {
  if (maxCorrections !== 0 && maxCorrections !== 1) throw new Error("maxCorrections must be 0 or 1");
  if (typeof maxRecordedCostUsd !== "string") throw new Error("maxRecordedCostUsd must be a decimal string");
  const cost = decimalUnits(maxRecordedCostUsd);
  if (cost <= 0n || cost > decimalUnits("1000") || decimalText(cost) !== maxRecordedCostUsd) throw new Error("invalid correction cost ceiling");
  return Object.freeze({ version: 1, maxCorrections, maxRecordedCostUsd });
}
export function validateCorrectionPolicy(value: unknown): CorrectionPolicy {
  if (value === undefined) return correctionPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid correction policy");
  const keys = Object.keys(value).sort().join();
  if (!["maxCorrections","maxCorrections,maxRecordedCostUsd","maxCorrections,maxRecordedCostUsd,version","maxCorrections,version"].includes(keys)) throw new Error("invalid correction policy fields");
  const v = value as Record<string, unknown>;
  if (v["version"] !== undefined && v["version"] !== 1) throw new Error("invalid correction policy version");
  return correctionPolicy(v["maxCorrections"],v["maxRecordedCostUsd"] ?? "10");
}
export interface SessionCustody { readonly chunks: readonly ReportEvidence[]; readonly sha256: string; readonly byteLength: number }
export interface CorrectionCycle {
  readonly candidate: string;
  readonly implement: ImplementPhaseResult;
  readonly verify: VerifyPhaseResult;
  readonly reports: { readonly implement: ReportEvidence; readonly verify: ReportEvidence };
  readonly commands: readonly HostCommandEvidence[];
  readonly sessions: { readonly implement: SessionCustody; readonly verify: SessionCustody };
  readonly feedbackDigest: string;
}
export interface CorrectionLedger {
  readonly policy: CorrectionPolicy;
  /** Only failed, accepted, privately archived cycles; the current result lives in run state. */
  readonly prior: readonly CorrectionCycle[];
  /** Set before the privileged workspace reset; crash never resumes this step. */
  readonly transition: "none" | "archived" | "prepared";
}
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
/** Only a sandbox-code retry is authorized. Text cannot prove safety; explicit
 * owner/host authority requests are conservatively ineligible. */
export function eligibleCorrection(result: VerifyPhaseResult): boolean {
  if (result.status !== "failed" || result.details.correction?.kind !== "code_only" || !result.details.findings.length || result.details.findings.length > 10) return false;
  const feedback = [result.summary, result.details.correction.reason, ...result.details.findings].join("\n");
  if (feedback.length > 16_000) return false;
  // A positive model label is never proof of safety. Reject explicit requests
  // for another authority even if the model mislabeled them as code-only.
  return !/\b(?:approv\w*|authoriz\w*|consent|signoff|amend\w*|authority ambiguity|security ambiguity|(?:contract|policy|scope) (?:change|amendment|expansion)|(?:outside|beyond) (?:the )?(?:ticket|contract|scope)|requires? (?:owner|human|host) (?:approval|decision|authorization)|(?:ask|request|need|require|obtain|seek|await|wait for|get)\b[^.!?\n]{0,100}\b(?:owner|human|host)\b[^.!?\n]{0,100}\b(?:approv\w*|authoriz\w*|decision|consent|permission|signoff|contract|policy|scope)|(?:change|expand|weaken) (?:the )?(?:ticket|contract|policy|scope)|(?:grant|expose|retrieve) (?:host )?(?:credentials?|secrets?|permissions?))\b/iu.test(feedback);
}
export function feedbackDigest(result: VerifyPhaseResult): string {
  return createHash("sha256").update(JSON.stringify({ candidate: result.inputHead, findings: result.details.findings, commands: result.details.commands, correction: result.details.correction })).digest("hex");
}
export function validateCorrectionLedger(value: unknown, runId: string, baseSha: string | null): asserts value is CorrectionLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid correction ledger");
  const v = value as CorrectionLedger;
  if (Object.keys(v).sort().join() !== "policy,prior,transition" || !v.policy || Object.keys(v.policy).sort().join() !== "maxCorrections,maxRecordedCostUsd,version" || !isDeepStrictEqual(validateCorrectionPolicy(v.policy),v.policy)) throw new Error("invalid correction policy");
  if (!Array.isArray(v.prior) || v.prior.length > v.policy.maxCorrections || !["none", "archived", "prepared"].includes(v.transition)) throw new Error("invalid correction transition");
  let parent = baseSha;
  for (const c of v.prior) {
    if (!c || Object.keys(c).sort().join() !== "candidate,commands,feedbackDigest,implement,reports,sessions,verify" || !SHA.test(c.candidate) || !DIGEST.test(c.feedbackDigest)) throw new Error("invalid correction cycle");
    validatePhaseResultShape(c.implement,"implement"); validatePhaseResultShape(c.verify,"verify");
    if (c.implement.runId !== runId || c.verify.runId !== runId || c.implement.status !== "passed" || c.verify.status !== "failed" || c.implement.inputHead !== parent || c.implement.outputHead !== c.candidate || c.verify.inputHead !== c.candidate || c.verify.outputHead !== c.candidate || c.implement.attempt !== c.verify.attempt || c.feedbackDigest !== feedbackDigest(c.verify) || !eligibleCorrection(c.verify)) throw new Error("invalid correction cycle identity");
    validateHostCommands(c.commands, c.verify);
    if (!c.reports || Object.keys(c.reports).sort().join() !== "implement,verify" || !c.sessions || Object.keys(c.sessions).sort().join() !== "implement,verify") throw new Error("incomplete correction custody");
    for (const phase of ["implement", "verify"] as const) {
      validateEvidenceRef(c.reports[phase]);
      const s = c.sessions[phase];
      if (!s || Object.keys(s).sort().join() !== "byteLength,chunks,sha256" || !DIGEST.test(s.sha256) || !Number.isSafeInteger(s.byteLength) || s.byteLength < 1 || s.byteLength > 64 * 1024 * 1024 || !Array.isArray(s.chunks) || !s.chunks.length || s.chunks.length > 32) throw new Error("invalid session custody");
      let size = 0;
      for (const ref of s.chunks as readonly ReportEvidence[]) { validateEvidenceRef(ref); size += ref.byteLength; }
      if (size !== s.byteLength) throw new Error("invalid session custody length");
    }
    parent = c.candidate;
  }
}
export function validateHostCommands(value: unknown, result: VerifyPhaseResult): asserts value is readonly HostCommandEvidence[] {
  if (!Array.isArray(value) || value.length !== result.details.commands.length || !value.length || value.length > 100) throw new Error("missing host Verify command evidence");
  for (const [index, entry] of value.entries()) {
    if (!entry || Object.keys(entry).sort().join() !== "command,exitCode,output" || entry.command !== result.details.commands[index]!.command || entry.exitCode !== result.details.commands[index]!.exitCode) throw new Error("host Verify command identity disagrees with report");
    validateEvidenceRef(entry.output);
  }
}
export function assertCorrectionTransition(current: CorrectionLedger | undefined, next: CorrectionLedger | undefined): void {
  if (!current || !next) { if (current !== next) throw new Error("correction policy is immutable"); return; }
  if (!isDeepStrictEqual(current.policy,next.policy) || next.prior.length < current.prior.length || next.prior.length > current.prior.length + 1 || !isDeepStrictEqual(current.prior, next.prior.slice(0,current.prior.length))) throw new Error("correction history is immutable");
  const allowed: Record<CorrectionLedger["transition"], readonly CorrectionLedger["transition"][]> = {none:["none","archived"],archived:["archived","prepared"],prepared:["prepared","none"]};
  if (!allowed[current.transition].includes(next.transition) || (next.prior.length !== current.prior.length && (current.transition !== "none" || next.transition !== "archived"))) throw new Error("invalid correction transition");
}
