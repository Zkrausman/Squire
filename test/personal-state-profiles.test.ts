import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePhaseProfiles } from "../src/personal/model-policy.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import type { PersonalRunState } from "../src/personal/types.js";

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
