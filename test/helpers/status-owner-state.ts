import { deterministicFeatureBranch } from "../../src/personal/identity.js";
import type { PersonalRunState } from "../../src/personal/types.js";
export function statusOwnerState(pid = process.pid): PersonalRunState {
  const runId = "aidev-305-owner12345";
  return {
    schemaVersion: 1, version: 1, runId, ticketId: "AIDEV-305", ticketTitle: "Concurrent owner status",
    status: "running", step: "preparing", controllerPid: pid, endedAt: null,
    sandbox: `squire-${runId}`, repository: "example/repo", baseBranch: "main", baseSha: null,
    branch: deterministicFeatureBranch("example/repo", "AIDEV-305"), head: null,
    sessions: {}, attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 }, results: {},
    remediations: { review: 0, test: 0 }, prUrl: null, lastError: null, updatedAt: "2026-09-20T00:00:00.000Z",
  };
}
