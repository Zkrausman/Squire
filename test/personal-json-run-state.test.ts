import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import type { ImplementPhaseResult, PersonalRunState, PlanPhaseResult, RetroPhaseResult, ReviewPhaseResult, TestPhaseResult } from "../src/personal/types.js";

const BASE = "a".repeat(40);
const BRANCH = deterministicFeatureBranch("example/repo", "AIDEV-1");

function state(version = 1): PersonalRunState {
  return {
    schemaVersion: 1,
    version,
    runId: "aidev-1-0123456789",
    ticketId: "AIDEV-1",
    ticketTitle: "Small change",
    status: "running",
    step: "preparing",
    sandbox: "squire-aidev-1-0123456789",
    repository: "example/repo",
    baseBranch: "main",
    baseSha: null,
    branch: BRANCH,
    head: null,
    sessions: {},
    attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 },
    results: {},
    remediations: { review: 0, test: 0 },
    prUrl: null,
    lastError: null,
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function planResult(runId: string): PlanPhaseResult {
  return {
    runId,
    phase: "plan",
    attempt: 1,
    sessionId: "plan-session",
    sessionFile: "/ticket/sessions/plan/1.jsonl",
    inputHead: BASE,
    outputHead: BASE,
    status: "passed",
    summary: "plan passed",
    details: { steps: ["make the focused change"] },
  };
}

function completedState(): PersonalRunState {
  const run = state();
  const implementation: ImplementPhaseResult = { runId: run.runId, phase: "implement", attempt: 1, sessionId: "implement-session", sessionFile: "/ticket/sessions/implement/1.jsonl", inputHead: BASE, outputHead: BASE, status: "passed", summary: "implemented", details: { changes: ["changed one file"] } };
  const review: ReviewPhaseResult = { runId: run.runId, phase: "review", attempt: 1, sessionId: "review-session", sessionFile: "/ticket/sessions/review/1.jsonl", inputHead: BASE, outputHead: BASE, status: "passed", summary: "reviewed", details: { findings: [] } };
  const validation: TestPhaseResult = { runId: run.runId, phase: "test", attempt: 1, sessionId: "test-session", sessionFile: "/ticket/sessions/test/1.jsonl", inputHead: BASE, outputHead: BASE, status: "passed", summary: "tested", details: { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] } };
  const retro: RetroPhaseResult = { runId: run.runId, phase: "retro", attempt: 1, sessionId: "retro-session", sessionFile: "/ticket/sessions/retro/1.jsonl", inputHead: BASE, outputHead: BASE, status: "passed", summary: "retrospected", details: { lessons: ["keep gates explicit"], followUps: [] } };
  return {
    ...run,
    status: "completed",
    step: "complete",
    baseSha: BASE,
    head: BASE,
    sessions: { plan: "plan-session", implement: "implement-session", review: "review-session", test: "test-session", retro: "retro-session" },
    attempts: { plan: 1, implement: 1, review: 1, test: 1, retro: 1 },
    results: { plan: planResult(run.runId), implement: implementation, review, test: validation, retro },
    prUrl: "https://github.example/example/repo/pull/1",
  };
}

test("JSON run state is created exclusively and replaced by sequential versions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-state-"));
  try {
    const store = new JsonRunStateStore(directory);
    await store.create(state());
    await assert.rejects(store.create(state()), /EEXIST/);
    await store.save({ ...state(2), step: "plan", baseSha: BASE, head: BASE, attempts: { plan: 1, implement: 0, review: 0, test: 0, retro: 0 } });
    assert.equal((await store.read("aidev-1-0123456789"))?.step, "plan");
    assert.equal((await store.findActive("AIDEV-1"))?.version, 2);
    await assert.rejects(store.save({ ...state(4), step: "implement", baseSha: BASE, head: BASE, attempts: { plan: 1, implement: 1, review: 0, test: 0, retro: 0 } }), /advance by one/);
    const raw = await readFile(path.join(directory, "aidev-1-0123456789.json"), "utf8");
    assert.equal(JSON.parse(raw).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state validation rejects every mutable record boundary and identity mismatch", () => {
  const valid = { ...state(), step: "plan" as const, baseSha: BASE, head: BASE, attempts: { plan: 1, implement: 0, review: 0, test: 0, retro: 0 }, sessions: { plan: "plan-session" }, results: { plan: planResult(state().runId) } };
  validateState(valid);
  const invalid: unknown[] = [
    { ...valid, status: "RUNNING" },
    { ...valid, step: "unknown" },
    { ...valid, branch: "squire/random" },
    { ...valid, sandbox: "squire-other" },
    { ...valid, attempts: { ...valid.attempts, plan: -1 } },
    { ...valid, attempts: { ...valid.attempts, extra: 1 } },
    { ...valid, remediations: { review: 2, test: 0 } },
    { ...valid, sessions: { plan: "" } },
    { ...valid, results: { plan: { ...planResult(valid.runId), runId: "other-run" } } },
    { ...valid, results: { plan: { ...planResult(valid.runId), details: { steps: [] } } } },
    { ...valid, prUrl: "not-a-url" },
    { ...valid, updatedAt: "yesterday" },
    { ...valid, unexpected: true },
  ];
  for (const value of invalid) assert.throws(() => validateState(value));
});

test("completed state requires every latest phase and exact Review/Test/Retro input heads", () => {
  const valid = completedState();
  validateState(valid);
  assert.throws(() => validateState({ ...valid, results: { implement: valid.results.implement, review: valid.results.review, test: valid.results.test } }), /latest passing phase/);
  assert.throws(() => validateState({ ...valid, results: { plan: valid.results.plan, review: valid.results.review, test: valid.results.test } }), /latest passing phase/);
  assert.throws(() => validateState({ ...valid, results: { ...valid.results, review: { ...valid.results.review!, inputHead: "b".repeat(40) } } }), /stale gates/);
  assert.throws(() => validateState({ ...valid, results: { ...valid.results, test: { ...valid.results.test!, inputHead: "b".repeat(40) } } }), /stale gates/);
  assert.throws(() => validateState({ ...valid, results: { ...valid.results, retro: { ...valid.results.retro!, outputHead: "b".repeat(40) } } }), /stale gates/);
  assert.throws(() => validateState({ ...valid, results: { ...valid.results, retro: undefined } }), /phase result|latest passing phase/);
  assert.throws(() => validateState({ ...valid, attempts: { ...valid.attempts, implement: 2 } }), /latest passing phase/);
});

test("a corrupted state file fails closed instead of hiding an active run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-state-"));
  try {
    const corrupted = { ...state(), status: "RUNNING" };
    await writeFile(path.join(directory, `${corrupted.runId}.json`), JSON.stringify(corrupted));
    const store = new JsonRunStateStore(directory);
    await assert.rejects(store.findActive("AIDEV-1"), /invalid run state status/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
