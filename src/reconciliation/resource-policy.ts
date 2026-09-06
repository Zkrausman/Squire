import type { ExternalResourceBinding } from "../control/domain.js";

export interface ObservedResource {
  readonly kind: ExternalResourceBinding["kind"];
  readonly scope: string;
  readonly externalId: string;
  readonly deterministicKey?: string;
  readonly deterministicName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export type ResourceDecision = { readonly action: "adopt" | "create" | "ignore" | "block"; readonly reason: string };
export class ResourceConflictError extends Error { constructor(message: string) { super(message); this.name = "ResourceConflictError"; } }

/** Provider-neutral exact matching. Display names alone never produce adopt. */
export function decideResource(planned: ExternalResourceBinding | undefined, observed: readonly ObservedResource[], expected: { readonly kind: ExternalResourceBinding["kind"]; readonly scope: string; readonly deterministicKey: string; readonly deterministicName: string; readonly metadata?: Readonly<Record<string, unknown>> }): ResourceDecision {
  const candidates = observed.filter(resource => resource.kind === expected.kind && resource.scope === expected.scope && (resource.deterministicKey === expected.deterministicKey || resource.deterministicName === expected.deterministicName));
  if (candidates.length > 1) return { action: "block", reason: "multiple resources share a deterministic identity" };
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    if (candidate.deterministicKey !== expected.deterministicKey || candidate.deterministicName !== expected.deterministicName || !metadataEqual(candidate.metadata, expected.metadata)) return { action: "block", reason: "resource immutable metadata does not match" };
    if (planned?.externalId && planned.externalId !== candidate.externalId) return { action: "block", reason: "planned and observed external IDs disagree" };
    return { action: "adopt", reason: "exact deterministic identity and immutable metadata match" };
  }
  if (planned?.externalId || (planned && planned.state !== "planned")) return { action: "block", reason: "resource disappeared after a persisted side-effect intent" };
  return { action: "create", reason: "no prior completed side-effect intent proves a resource exists" };
}
export function assertNoCrossRunReuse(bindings: readonly ExternalResourceBinding[], candidate: ExternalResourceBinding): void {
  const reused = bindings.find(binding => binding.kind === candidate.kind && binding.scope === candidate.scope && binding.externalId !== undefined && binding.externalId === candidate.externalId && binding.deterministicKey !== candidate.deterministicKey);
  if (reused) throw new ResourceConflictError("external resource identity is already bound to another run");
}
function metadataEqual(a: Readonly<Record<string, unknown>> | undefined, b: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!a || !b) return a === b;
  const keysA = Object.keys(a).sort(); const keysB = Object.keys(b).sort();
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && JSON.stringify(a[key]) === JSON.stringify(b[key]));
}
