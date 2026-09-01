import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { V1ArtifactValidator } from "../src/contracts/v1-artifact-validator.js";
import { SafeArtifactReader } from "../src/control/safe-artifact-reader.js";
import { createPhaseSemanticPolicy, PhaseResultAcceptanceService } from "../src/control/phase-result-acceptance.js";
import type { PhaseAttempt } from "../src/control/domain.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { headA, headB, run } from "./support/fixtures.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function put(root: string, relative: string, value: unknown): Promise<{ path: string; sha256: string }> { const bytes = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`); const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return { path: relative, sha256: sha(bytes) }; }
function persistedAttempt(): PhaseAttempt { return { phase: "implement", attempt: 1, handoffId: "handoff_impl", targetSessionId: "impl", inputHead: headA, input: { path: "artifacts/handoffs/input.json", sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback: [], dispatch: { operationKey: "op", handoffId: "handoff_impl", targetSessionId: "impl", marker: "marker", state: "settled", generation: 1, cursor: null, recoveryPrompts: 0 } }; }
async function setup(missingEvidence = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "result-accept-")); await mkdir(path.join(root, "artifacts")); await mkdir(path.join(root, "evidence"));
  const runtime = await put(root, "artifacts/runtime.json", { schemaVersion: 1, runId: "run_example01", pi: { version: "observed", executable: "/usr/local/bin/pi", installationId: "pi" }, llmWiki: { version: "observed", installationId: "wiki" }, resolvedAt: "2026-09-01T12:00:00Z" });
  const evidence = missingEvidence ? { path: "evidence/missing.log", sha256: "0".repeat(64) } : await put(root, "evidence/tests.log", "pass\n");
  const resultDocument = { schemaVersion: 1, handoffId: "handoff_impl", inputArtifact: persistedAttempt().input, runId: "run_example01", phase: "implement", sessionId: "impl", inputHead: headA, outputHead: headB, status: "pass", artifacts: [{ ...runtime, mediaType: "application/json", schemaId: "urn:squire:contracts:v1:runtime-resolution" }], evidence: [{ ...evidence, mediaType: "text/plain", kind: "command", commandId: "tests" }], findings: [], failures: [], requestedTransition: { toState: "reviewing", reason: "phase_pass" }, completedAt: "2026-09-01T12:05:00Z" };
  const resultFile = await put(root, "artifacts/result.json", resultDocument); const reference = { ...resultFile, schemaId: "urn:squire:contracts:v1:phase-result" };
  const store = new InMemoryWorkflowStore(); await store.create(run({ state: "implementing", attempts: [persistedAttempt()] })); const validator = await V1ArtifactValidator.create(new SafeArtifactReader(root)); const git = { observeHead: async () => headB }; const clock = { now: () => Date.parse("2026-09-01T12:06:00Z"), sleep: async () => {} }; const service = new PhaseResultAcceptanceService(store, git, validator, clock, createPhaseSemanticPolicy(["contracts", "tests"]));
  return { store, service, reference };
}

test("production acceptance exact-validates every transitive artifact/evidence before one atomic acceptance", async () => {
  const valid = await setup(); const accepted = await valid.service.accept("run_example01", "handoff_impl", valid.reference); assert.equal(accepted.run.currentHead, headB); assert.equal(accepted.run.implementGeneration, 1); assert.equal(accepted.run.attempts[0]?.dispatch.state, "result_accepted"); assert.deepEqual(accepted.run.acceptedResultPaths, [valid.reference.path]); await assert.rejects(valid.service.accept("run_example01", "handoff_impl", valid.reference), /already accepted/);
});

test("missing transitive evidence fails closed without partial persistence", async () => { const invalid = await setup(true); await assert.rejects(invalid.service.accept("run_example01", "handoff_impl", invalid.reference), /missing|digest/); const current = await invalid.store.read("run_example01"); assert.equal(current?.attempts[0]?.accepted, undefined); assert.deepEqual(current?.acceptedResultPaths, []); assert.equal(current?.currentHead, headA); });

test("references nested inside a schema-identified domain artifact are also exact-read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-result-")); await mkdir(path.join(root, "artifacts")); await mkdir(path.join(root, "evidence"));
  const stderr = await put(root, "evidence/stderr.log", "\n"); const missing = { path: "evidence/stdout-missing.log", sha256: "0".repeat(64), mediaType: "text/plain", kind: "command" };
  const testEvidence = await put(root, "artifacts/test-evidence.json", { schemaVersion: 1, runId: "run_example01", sessionId: "test", testedHead: headB, status: "pass", commands: [{ commandId: "tests", startedAt: "2026-09-01T12:00:00Z", completedAt: "2026-09-01T12:01:00Z", exitCode: 0, timedOut: false, stdout: missing, stderr: { ...stderr, mediaType: "text/plain", kind: "command" } }], failures: [], completedAt: "2026-09-01T12:01:00Z" });
  const input = { path: "artifacts/test/input.json", sha256: "4".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }; const domain = { ...testEvidence, mediaType: "application/json", schemaId: "urn:squire:contracts:v1:test-evidence" };
  const resultFile = await put(root, "artifacts/test-result.json", { schemaVersion: 1, handoffId: "handoff_test", inputArtifact: input, runId: "run_example01", phase: "test", sessionId: "test", inputHead: headB, outputHead: headB, status: "pass", artifacts: [domain], evidence: [{ ...stderr, mediaType: "text/plain", kind: "command", commandId: "tests" }], findings: [], failures: [], requestedTransition: { toState: "publishing", reason: "phase_pass" }, completedAt: "2026-09-01T12:02:00Z" }); const reference = { ...resultFile, schemaId: "urn:squire:contracts:v1:phase-result" };
  const phaseAttempt: PhaseAttempt = { phase: "test", attempt: 1, handoffId: "handoff_test", targetSessionId: "test", inputHead: headB, input, feedback: [], dispatch: { operationKey: "test", handoffId: "handoff_test", targetSessionId: "test", marker: "test", state: "settled", generation: 1, cursor: null, recoveryPrompts: 0 } };
  const store = new InMemoryWorkflowStore(); await store.create(run({ state: "testing", currentHead: headB, implementGeneration: 1, implementCompletedAt: "2026-09-01T11:00:00Z", attempts: [phaseAttempt] })); const validator = await V1ArtifactValidator.create(new SafeArtifactReader(root)); const service = new PhaseResultAcceptanceService(store, { observeHead: async () => headB }, validator, { now: () => Date.parse("2026-09-01T12:03:00Z"), sleep: async () => {} }, createPhaseSemanticPolicy(["tests"]));
  await assert.rejects(service.accept("run_example01", "handoff_test", reference), /missing/); assert.equal((await store.read("run_example01"))?.attempts[0]?.accepted, undefined);
});
