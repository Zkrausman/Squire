import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rename as fsRename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameOverExistingWithRetry } from "../src/personal/atomic-rename.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import type { PersonalRunState } from "../src/personal/types.js";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function stateAt(version: number): PersonalRunState {
  return {
    schemaVersion: 1, version, runId: "aidev-1-0123456789", ticketId: "AIDEV-1", ticketTitle: "test",
    status: "running", step: "preparing", sandbox: "squire-aidev-1-0123456789", repository: "example/repo", baseBranch: "main", baseSha: null,
    branch: deterministicFeatureBranch("example/repo", "AIDEV-1"), head: null, sessions: {}, attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 },
    results: {}, remediations: { review: 0, test: 0 }, prUrl: null, lastError: null, updatedAt: `2026-09-10T00:00:0${version}.000Z`,
  };
}

async function assertNoTemporaryFiles(directory: string): Promise<void> {
  assert.deepEqual((await readdir(directory)).filter(file => file.endsWith(".tmp")), []);
}

test("Windows rename retries transient EPERM and succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  await renameOverExistingWithRetry("source", "target", {
    platform: "win32",
    rename: async () => { calls += 1; if (calls < 3) throw failure("EPERM"); },
    sleep: async milliseconds => { delays.push(milliseconds); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 100]);
});

test("Windows rename retries EBUSY with bounded exact attempts", async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(renameOverExistingWithRetry("source", "target", {
    platform: "win32",
    rename: async () => { calls += 1; throw failure("EBUSY"); },
    sleep: async milliseconds => { delays.push(milliseconds); },
  }), error => (error as NodeJS.ErrnoException).code === "EBUSY");
  assert.equal(calls, 4);
  assert.deepEqual(delays, [50, 100, 200]);
});

test("nonretryable Windows rename errors are immediate", async () => {
  let calls = 0;
  await assert.rejects(renameOverExistingWithRetry("source", "target", {
    platform: "win32",
    rename: async () => { calls += 1; throw failure("EACCES"); },
    sleep: async () => { throw new Error("unexpected retry"); },
  }), error => (error as NodeJS.ErrnoException).code === "EACCES");
  assert.equal(calls, 1);
});

test("non-Windows rename does not retry or delete the destination", async () => {
  let calls = 0;
  await assert.rejects(renameOverExistingWithRetry("source", "target", {
    platform: "linux",
    rename: async () => { calls += 1; throw failure("EPERM"); },
    sleep: async () => { throw new Error("unexpected retry"); },
  }), error => (error as NodeJS.ErrnoException).code === "EPERM");
  assert.equal(calls, 1);
});

test("state replacement and outbox replacement share the rename seam", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-rename-"));
  try {
    const calls: string[] = [];
    const state = stateAt(1);
    const store = new JsonRunStateStore(directory, { renameRetry: {
      platform: "win32", rename: async (source, target) => { calls.push(`${source}->${target}`); }, sleep: async () => undefined,
    } });
    await store.create(state);
    await store.save({ ...state, version: 2, updatedAt: "2026-09-10T00:00:01.000Z" });
    assert.equal(calls.length, 2);
    assert.ok(calls.some(call => call.includes(`${path.sep}events${path.sep}`)));
    assert.ok(calls.some(call => !call.includes(`${path.sep}events${path.sep}`)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real state replacement retains old bytes and removes its temp after retry exhaustion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-rename-real-"));
  try {
    const initial = stateAt(1);
    const initialStore = new JsonRunStateStore(directory);
    await initialStore.create(initial);
    const destination = path.join(directory, `${initial.runId}.json`);
    const oldBytes = await readFile(destination);
    let calls = 0;
    const failingStore = new JsonRunStateStore(directory, { renameRetry: {
      platform: "win32",
      rename: async () => { calls += 1; throw failure("EPERM"); },
      sleep: async () => undefined,
    } });
    await assert.rejects(failingStore.save(stateAt(2)), error => (error as NodeJS.ErrnoException).code === "EPERM");
    assert.equal(calls, 4);
    assert.deepEqual(await readFile(destination), oldBytes);
    await assertNoTemporaryFiles(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real state replacement retries transient failures, publishes new bytes, and removes its temp", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-rename-real-"));
  try {
    const initial = stateAt(1);
    const initialStore = new JsonRunStateStore(directory);
    await initialStore.create(initial);
    let calls = 0;
    const retryingRename = async (source: string, destination: string): Promise<void> => {
      calls += 1;
      if (calls <= 2) throw failure("EBUSY");
      await fsRename(source, destination);
    };
    const store = new JsonRunStateStore(directory, { renameRetry: {
      platform: "win32", rename: retryingRename, sleep: async () => undefined,
    } });
    await store.save(stateAt(2));
    assert.equal(calls, 3, "two transient failures followed by the successful state publish");
    const published = JSON.parse(await readFile(path.join(directory, `${initial.runId}.json`), "utf8")) as PersonalRunState;
    assert.equal(published.version, 2);
    assert.equal(published.updatedAt, stateAt(2).updatedAt);
    await assertNoTemporaryFiles(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("abort is passed to the bounded retry delay", async () => {
  const controller = new AbortController();
  let calls = 0;
  const reason = new Error("cancelled");
  await assert.rejects(renameOverExistingWithRetry("source", "target", {
    platform: "win32",
    signal: controller.signal,
    rename: async () => { calls += 1; throw failure("EPERM"); },
    sleep: async (_milliseconds, signal) => { controller.abort(reason); if (signal?.aborted) throw reason; },
  }), reason);
  assert.equal(calls, 1);
});
