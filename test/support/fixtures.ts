import type { RunSnapshot, RuntimeResolution } from "../../src/control/domain.js";
export const headA = "a".repeat(40); export const headB = "b".repeat(40);
export function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return { runId: "run_example01", version: 0, state: "accepted", currentHead: headA, implementGeneration: 0, sessions: {}, attempts: [], acceptedResultPaths: [], committedRequestIds: [], gates: {}, remediation: { review: 0, test: 0, total: 0 }, processLaunches: 0, ...overrides };
}
export const runtime: RuntimeResolution = { schemaVersion: 1, runId: "run_example01", pi: { version: "0.84.4", executable: "/ticket/runtime/pi", installationId: "pi-install-A" }, llmWiki: { version: "0.11.8", installationId: "wiki-install-A", root: "/ticket/runtime/node_modules/@zosmaai/pi-llm-wiki" }, resolvedAt: "2026-09-01T12:00:00Z" };
export const ref = (name: string) => ({ path: `artifacts/${name}.json`, sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:phase-result" });
