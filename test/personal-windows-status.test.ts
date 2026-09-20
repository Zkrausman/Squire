import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { evidencePath } from "../src/personal/reservation-observation.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { statusOwnerState } from "./helpers/status-owner-state.js";

const execute = promisify(execFile);
import { readOnlyTree } from "./helpers/status-read-only-tree.js";

// Intentionally also runs on Linux: it exercises the same multiprocess
// protocol locally. The Windows CI matrix executes it without a skip.
for (const mode of ["reserve", "abandon", "claim"] as const) {
  const abandon = mode === "abandon";
  test(`real owner retains ticket-operation and reservation handles during both CLI status selectors (${mode})`, { timeout: 40_000 }, async () => {
    const root = await launchTestRoot("squire-live-status-");
    const directory = path.join(root, "state");
    let parentFence: string | undefined;
    if (mode === "claim") {
      const initial = statusOwnerState();
      await new JsonRunStateStore(directory).reserve({ ...initial, controllerPid: null, executionMode: "background",
        launchState: "reserved", lifecycle: "launching", step: "launching", preparationState: "pending", startedAt: initial.updatedAt });
      parentFence = JSON.parse(await readFile(evidencePath(directory, "AIDEV-305"), "utf8")).fence;
    }
    const fixture = path.resolve("dist/test/helpers/status-owner-process.js");
    const child = spawn(process.execPath, [fixture, directory, mode], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "test", SQUIRE_TEST_ONLY_TICKET_OPERATION_STAGE: mode === "claim" ? "claim-after-publication" : "reserve-after-publication",
        SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH: path.join(root, "ready"), SQUIRE_TEST_ONLY_TICKET_OPERATION_RELEASE_PATH: path.join(root, "release") },
    });
    const closed = once(child, "close");
    let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); });
    let exited = false; child.once("exit", () => { exited = true; });
    const waitMessage = async (predicate: (m: Record<string, unknown>) => boolean) => {
      let timer: NodeJS.Timeout | undefined;
      let handler: (m: Record<string, unknown>) => void;
      try {
        return await Promise.race([
          new Promise<Record<string, unknown>>(resolve => { handler = m => { if (predicate(m)) resolve(m); }; child.on("message", handler); }),
          closed.then(() => { throw new Error(`owner exited before coordination: ${stderr}`); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owner coordination deadline")), 15_000); }),
        ]);
      } finally { clearTimeout(timer); child.removeListener("message", handler!); }
    };
    try {
      const ready = await waitMessage(m => m["ready"] === true);
      assert.equal(ready["pid"], child.pid);
      const states = new JsonRunStateStore(directory);
      const evidence = JSON.parse(await readFile(evidencePath(directory, "AIDEV-305"), "utf8"));
      assert.equal(ready["identity"], evidence.reservation);
      assert.equal(evidence.pid, child.pid);
      if (parentFence) assert.notEqual(evidence.fence, parentFence);
      const config = JSON.parse(await readFile("squire.config.example.json", "utf8"));
      config.repository.path = path.join(root, "nonexistent-repository");
      config.dataDirectory = path.join(root, "data");
      config.paths = { state: directory };
      const configPath = path.join(root, "config.json");
      await writeFile(configPath, JSON.stringify(config));
      const before = await readOnlyTree(directory);
      for (const selector of [statusOwnerState().runId, "AIDEV-305"]) {
        const { stdout, stderr } = await execute(process.execPath, [path.resolve("dist/src/personal/cli.js"), "status", selector, "--config", configPath], {
          timeout: 10_000, env: { ...process.env, SQUIRE_DATA_DIR: config.dataDirectory, LINEAR_API_KEY: "" },
        });
        assert.equal(stderr, "");
        assert.match(stdout, /Status: running/);
        assert.match(stdout, /Run ID: aidev-305-owner12345/);
        assert.match(stdout, /Reservation: verified live owner/);
        assert.equal(exited, false);
        const nonce = randomUUID();
        const response = waitMessage(m => m["nonce"] === nonce);
        child.send({ command: "challenge", nonce });
        assert.equal((await response)["identity"], evidence.reservation);
        assert.deepEqual(await readOnlyTree(directory), before);
      }
      // Observation never releases or steals the mutation mutex.
      await assert.rejects(states.reserve(statusOwnerState()), /ticket operation is locked or ambiguous/);
      assert.deepEqual(await readOnlyTree(directory), before);
      child.send({ command: abandon ? "abandon" : "stop" });
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      if (abandon) {
        const stranded = await readOnlyTree(directory);
        assert.deepEqual(await states.observeReservation("AIDEV-305"), { kind: "ambiguous", reason: "owner-not-live" });
        const { findRunState, StatusLookupError } = await import("../src/personal/status.js");
        for (const selector of [statusOwnerState().runId, "AIDEV-305"]) {
          await assert.rejects(findRunState(states, selector), e => e instanceof StatusLookupError && e.code === "ambiguous" && /owner-not-live/u.test(e.message));
        }
        assert.deepEqual(await readOnlyTree(directory), stranded);
      } else {
        assert.deepEqual(await states.observeReservation("AIDEV-305"), { kind: "absent" });
      }
    } finally {
      if (!exited && child.connected) child.send({ command: "stop" });
      // Only fixture-owned children, normal lifecycle shutdown, and OS close
      // evidence authorize root removal. Never touch an unrelated PID/root.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fixture did not exit; retained ${root}`)), 15_000); })]);
        await rm(root, { recursive: true, force: true });
      } finally { clearTimeout(timer); }
    }
  });
}

test("Windows incompatible evidence reader is unreadable, never bypassed or repaired", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const root = await launchTestRoot("squire-unreadable-status-");
  const store = new JsonRunStateStore(root);
  await store.reserve(statusOwnerState());
  const before = await readOnlyTree(root);
  const system = process.env["SystemRoot"];
  assert.ok(system && path.isAbsolute(system));
  const reader = spawn(path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-File", path.resolve("fixtures/hold-exclusive-evidence-reader.ps1"), evidencePath(root, "AIDEV-305")], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(reader, "close");
  let stderr = ""; reader.stderr.on("data", data => { stderr += String(data); });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>(resolve => { let text = ""; reader.stdout.on("data", data => { text += String(data); if (/ready\r?\n/u.test(text)) resolve(); }); }),
      closed.then(() => { throw new Error(`exclusive reader exited early: ${stderr}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("exclusive reader readiness deadline")), 15_000); }),
    ]);
    assert.deepEqual(await store.observeReservation("AIDEV-305"), { kind: "ambiguous", reason: "unreadable" });
    const { findRunState, StatusLookupError } = await import("../src/personal/status.js");
    for (const selector of [statusOwnerState().runId, "AIDEV-305"]) {
      await assert.rejects(findRunState(store, selector), e => e instanceof StatusLookupError && e.code === "ambiguous" && /unreadable/u.test(e.message));
    }
  } finally {
    clearTimeout(timer);
    reader.stdin.end("release\n");
    let shutdown: NodeJS.Timeout | undefined;
    try {
      const [code] = await Promise.race([closed, new Promise<never>((_, reject) => { shutdown = setTimeout(() => reject(new Error(`reader did not exit; retained ${root}`)), 10_000); })]);
      assert.equal(code, 0, stderr);
      assert.deepEqual(await readOnlyTree(root), before);
      assert.equal((await store.observeReservation("AIDEV-305")).kind, "owner");
      await rm(root, { recursive: true, force: true });
    } finally { clearTimeout(shutdown); }
  }
});
