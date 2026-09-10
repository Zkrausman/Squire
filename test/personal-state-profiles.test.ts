import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePhaseProfiles, type PhaseProfile } from "../src/personal/model-policy.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import type { PersonalPhase, PersonalRunState, PhaseResult } from "../src/personal/types.js";

const BASE = "a".repeat(40);

function initialState(): PersonalRunState {
  const resolved = resolvePhaseProfiles("example/repo", "AIDEV-1");
  return {
    schemaVersion: 1,
    version: 1,
    runId: "aidev-1-0123456789",
    ticketId: "AIDEV-1",
    ticketTitle: "Small change",
    status: "running",
    step: "preparing",
    sandbox: "squire-aidev-1-0123456789",
    repository: "example/repo",
    baseBranch: "main",
    baseSha: null,
    branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
    profiles: resolved.profiles,
    planSelection: resolved.planSelection,
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

function phaseResult(run: PersonalRunState, phase: PersonalPhase, profile: PhaseProfile): PhaseResult {
  const common = {
    runId: run.runId,
    attempt: 1,
    sessionId: `${phase}-session`,
    sessionFile: `/ticket/sessions/${phase}/1.jsonl`,
    inputHead: BASE,
    outputHead: BASE,
    status: "passed" as const,
    summary: `${phase} passed`,
    profile,
  };
  if (phase === "plan") return { ...common, phase, details: { steps: ["make the change"] } };
  if (phase === "implement") return { ...common, phase, details: { changes: ["made the change"] } };
  if (phase === "review") return { ...common, phase, details: { findings: [] } };
  if (phase === "test") return { ...common, phase, details: { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] } };
  return { ...common, phase, details: { lessons: ["keep evidence explicit"], followUps: [] } };
}

test("new run state persists resolved profiles and rejects profile mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-state-profiles-"));
  try {
    const store = new JsonRunStateStore(root);
    const state = initialState();
    validateState(state);
    await store.create(state);
    const saved = await store.read(state.runId);
    assert.deepEqual(saved?.profiles, state.profiles);
    assert.equal(saved?.planSelection?.bucket, state.planSelection?.bucket);
    await assert.rejects(
      store.save({ ...state, version: 2, profiles: { ...state.profiles!, implement: { ...state.profiles!.implement, model: "other-model" } } }),
      /immutable/,
    );
    await assert.rejects(
      store.save({ ...state, version: 2, planSelection: { ...state.planSelection!, bucket: state.planSelection!.bucket === "a" ? "b" : "a" } }),
      /profile mismatch|digest|identity/,
    );

    const advanced = initialState();
    const profiles = advanced.profiles!;
    const results = {
      plan: phaseResult(advanced, "plan", profiles.plan),
      implement: phaseResult(advanced, "implement", profiles.implement),
      review: phaseResult(advanced, "review", profiles.review),
      test: phaseResult(advanced, "test", profiles.test),
      retro: phaseResult(advanced, "retro", profiles.retro),
    };
    const roundTrippedState: PersonalRunState = {
      ...advanced,
      version: 2,
      step: "retro",
      baseSha: BASE,
      head: BASE,
      sessions: { plan: "plan-session", implement: "implement-session", review: "review-session", test: "test-session", retro: "retro-session" },
      attempts: { plan: 1, implement: 1, review: 1, test: 1, retro: 1 },
      results,
    };
    validateState(roundTrippedState);
    await store.save(roundTrippedState);
    const savedWithResults = await store.read(state.runId);
    assert.deepEqual(savedWithResults?.profiles, roundTrippedState.profiles);
    assert.deepEqual(savedWithResults?.planSelection, roundTrippedState.planSelection);
    for (const phase of ["plan", "implement", "review", "test", "retro"] as const) {
      assert.deepEqual(savedWithResults?.results[phase]?.profile, roundTrippedState.profiles?.[phase]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
