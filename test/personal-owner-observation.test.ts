import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, rm, writeFile, rename, link } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { findRunState } from "../src/personal/status.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import type { PersonalRunState } from "../src/personal/types.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
const exec = promisify(execFile);
function reserved(): PersonalRunState {
  return { schemaVersion: 1, version: 1, runId: "aidev-1-observation123", ticketId: "AIDEV-1", ticketTitle: "Owner observation", status: "running", step: "launching", lifecycle: "launching", executionMode: "background", launchState: "reserved", preparationState: "pending", controllerPid: null, startedAt: "2026-09-20T00:00:00.000Z", endedAt: null, sandbox: "squire-aidev-1-observation123", repository: "example/repo", baseBranch: "main", baseSha: null, branch: deterministicFeatureBranch("example/repo", "AIDEV-1"), head: null, sessions: {}, attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 }, results: {}, remediations: { review: 0, test: 0 }, prUrl: null, lastError: null, updatedAt: "2026-09-20T00:00:00.000Z" };
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(name));
    else result[name] = (await readFile(name)).toString("base64");
  }
  return result;
}

// Runs on Linux too; every native Windows launch matrix version executes this
// same real-process fixture, not a mocked Windows adapter.
for (const stage of ["reserve-published", "claim-before-state", "claim-published", "abandon-published"]) {
  test(`separate CLI readers observe retained production owner handles: ${stage}`, { timeout: 30_000 }, async () => {
    const root = await launchTestRoot("squire-owner-process-");
    const directory = path.join(root, "state");
    const input = path.join(root, "input.json");
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    await writeFile(input, JSON.stringify(reserved()));
    const config = JSON.parse(await readFile("squire.config.example.json", "utf8"));
    config.repository.path = process.cwd(); config.dataDirectory = root; delete config.paths;
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const child = spawn(process.execPath, [path.resolve("fixtures/status-owner.mjs"), directory, input, stage], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "test", SQUIRE_TEST_ONLY_TICKET_OPERATION_STAGE: stage, SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH: ready, SQUIRE_TEST_ONLY_TICKET_OPERATION_RELEASE_PATH: release },
    });
    let errors = ""; child.stderr!.on("data", bytes => { errors += String(bytes); });
    const exited = new Promise<number | null>(resolve => child.once("close", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`owner readiness timed out: ${errors}`)), 10_000);
        child.once("message", () => { clearTimeout(timeout); resolve(); });
        child.once("exit", code => { clearTimeout(timeout); reject(new Error(`owner exited ${code}: ${errors}`)); });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
      });
      const before = await snapshot(directory);
      for (const selector of [reserved().runId, "AIDEV-1"]) {
        const result = await exec(process.execPath, [path.resolve("dist/src/personal/cli.js"), "status", selector, "--config", configPath], { timeout: 10_000, env: { ...process.env, SQUIRE_DATA_DIR: root } });
        assert.match(result.stdout, /Run ID: aidev-1-observation123/);
        assert.match(result.stdout, stage === "abandon-published" ? /Status: failed/ : /Status: running/);
        if (stage === "claim-published") assert.match(result.stdout, new RegExp(`Controller PID: ${child.pid}`));
      }
      assert.deepEqual(await snapshot(directory), before);
      // The production mutation operation is still held after both readers.
      await access(path.join(directory, "ticket-operations", "aidev-1.lock"));
      await writeFile(release, "go");
      assert.equal(await exited, 0, errors);
      if (stage !== "abandon-published") {
        const states = new JsonRunStateStore(directory);
        const stranded = await snapshot(directory);
        for (const selector of [reserved().runId, "AIDEV-1"]) await assert.rejects(findRunState(states, selector), /owner evidence unreadable or inconsistent/);
        assert.deepEqual(await snapshot(directory), stranded);
      }
    } finally {
      await writeFile(release, "go").catch(() => undefined);
      if (child.exitCode === null) child.kill();
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("read-only status does not create missing state or event directories", async () => {
  const root = await launchTestRoot("squire-owner-missing-");
  try {
    const directory = path.join(root, "absent");
    await assert.rejects(findRunState(new JsonRunStateStore(directory), "AIDEV-1"), /no persisted run/);
    await assert.rejects(access(directory), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const damage of ["empty", "malformed", "wrong-run", "replaced", "missing-proof", "reused-pid", "dead-pid", "duplicate", "unreadable", "bad-operation", "wrong-fence", "hardlink", "oversized", "wrong-operation-ticket", "wrong-operation-reservation", "uncommitted-claim"]) {
  test(`observation rejects ${damage} for both selectors without writes`, async () => {
    const root = await launchTestRoot("squire-owner-negative-");
    try {
      const states = new JsonRunStateStore(root);
      const state = reserved(); await states.reserve(state);
      const lock = path.join(root, "locks", "aidev-1.lock");
      const proof = `${lock}.owner`;
      if (damage === "hardlink") await link(lock, `${lock}.linked`);
      if (damage === "oversized") await writeFile(lock, "x".repeat(8193));
      if (damage === "wrong-operation-ticket" || damage === "wrong-operation-reservation") {
        const value = JSON.parse(await readFile(proof, "utf8"));
        const { runId: _runId, reservationIdentity: _reservationIdentity, stage: _stage, ...operation } = value;
        if (damage === "wrong-operation-ticket") operation.ticketId = "AIDEV-2";
        else operation.operationReservationIdentity = "0:0";
        await writeFile(path.join(root, "ticket-operations", "aidev-1.lock"), JSON.stringify(operation));
      }
      if (damage === "empty") await writeFile(lock, "");
      if (damage === "malformed") await writeFile(lock, "bad\nrecord\n");
      if (damage === "wrong-run") await writeFile(lock, "aidev-1-other12345\n");
      if (damage === "replaced") { await rename(lock, `${lock}.old`); await writeFile(lock, `${state.runId}\n`); }
      if (damage === "uncommitted-claim") { const value = JSON.parse(await readFile(proof, "utf8")); value.stage = "claim"; await writeFile(proof, JSON.stringify(value)); }
      if (damage === "missing-proof") await rm(proof);
      if (damage === "reused-pid" || damage === "dead-pid" || damage === "wrong-fence") {
        const value = JSON.parse(await readFile(proof, "utf8"));
        if (damage === "reused-pid") value.processIdentity = "0:0";
        if (damage === "dead-pid") value.pid = 0xffffffff;
        if (damage === "wrong-fence") value.reservationIdentity = "0:0";
        await writeFile(proof, JSON.stringify(value));
      }
      if (damage === "duplicate") await states.create({ ...state, runId: "aidev-1-second12345", sandbox: "squire-aidev-1-second12345" });
      if (damage === "unreadable") { await rm(proof); await mkdir(proof); }
      if (damage === "bad-operation") await writeFile(path.join(root, "ticket-operations", "aidev-1.lock"), "unknown");
      const before = await snapshot(root);
      states.reservationOwner = async () => { throw new Error("mutation inspection forbidden"); };
      for (const selector of [state.runId, state.ticketId]) await assert.rejects(findRunState(states, selector), /unreadable|multiple active/);
      assert.deepEqual(await snapshot(root), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
