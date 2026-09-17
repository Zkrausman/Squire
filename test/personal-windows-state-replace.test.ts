import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, link, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { windowsLaunch } from "../src/personal/windows-launch.js";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import type { PersonalRunState, RunRequest } from "../src/personal/types.js";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const request: RunRequest = { ticketId: "AIDEV-1", repository: "example/repo", repositoryPath: "/tmp/example-repo", sourceRef: "HEAD", baseBranch: "main" };

async function denyDelete(file: string): Promise<() => Promise<void>> {
  const ps = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-File", path.resolve("fixtures/hold-state-reader.ps1"), file], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        let text = "";
        child.stdout.on("data", chunk => { text += String(chunk); if (text.includes("ready\n") || text.includes("ready\r\n")) resolve(); });
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`reader exited ${code}: ${stderr}`)));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reader readiness deadline")), 10_000); }),
    ]);
  } catch (error) { child.kill(); await closed; throw error; }
  finally { clearTimeout(timer); }
  return async () => { child.stdin.end("release\n"); const [code] = await closed; assert.equal(code, 0, stderr); };
}

for (const cancellation of [false, true]) {
  for (const mode of ["legacy", "native", "deny-delete"] as const) {
    test(`${mode}: terminal ${cancellation ? "interrupted" : "failed"} with synchronized held reader`, windows, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "squire-state-reader-"));
      const original = new Error(cancellation ? "operator cancelled" : "credential lookup failed");
      const abort = new AbortController();
      const secondary: unknown[] = [];
      let reader: Awaited<ReturnType<typeof open>> | undefined;
      let release: (() => Promise<void>) | undefined;
      let before: PersonalRunState | undefined;
      let oldBytes = "", target = "";
      let legacyCalls = 0;
      const states = new JsonRunStateStore(root, mode === "legacy" ? { renameRetry: { rename: async (source, destination) => {
        if (destination === target) legacyCalls++;
        await rename(source, destination); // real OS call, not an injected exception
      } } } : {});
      const controller = new PersonalMvpController({
        launchMaterial: TEST_MATERIAL, states,
        onPersistenceError: error => secondary.push(error),
        tickets: { async get() {
          before = (await states.findByTicket(request.ticketId))[0]!;
          target = path.join(root, `${before.runId}.json`);
          oldBytes = await readFile(target, "utf8");
          if (mode === "deny-delete") release = await denyDelete(target);
          else reader = await open(target, "r");
          if (cancellation) abort.abort(original);
          throw original;
        } },
        workspaces: {} as never, phases: {} as never, publication: {} as never,
      });
      try {
        await assert.rejects(controller.run(request, abort.signal), error => error === original);
        assert.ok(before);
        assert.equal(before.version, 1);
        const after = (await states.read(before.runId))!;
        if (mode === "native") {
          assert.equal(secondary.length, 0);
          assert.equal(after.version, 2);
          assert.equal(after.status, cancellation ? "interrupted" : "failed");
          assert.equal(after.lifecycle, after.status);
          assert.ok(after.endedAt);
          assert.equal(after.lastError, original.message);
          assert.equal(await states.reservationOwner(request.ticketId), undefined);
          assert.equal(await reader!.readFile("utf8"), oldBytes);
          assert.notEqual(await readFile(target, "utf8"), oldBytes);
          assert.equal(JSON.parse(await readFile(target, "utf8")).version, 2);
        } else {
          assert.deepEqual(after, before);
          assert.equal(after.endedAt, null);
          assert.equal(await readFile(target, "utf8"), oldBytes);
          assert.equal(await states.reservationOwner(request.ticketId), before.runId);
          assert.equal(secondary.length, 1);
          assert.equal((secondary[0] as NodeJS.ErrnoException).code, mode === "legacy" ? "EPERM" : "EBUSY");
          if (mode === "legacy") assert.equal(legacyCalls, 4);
          else assert.equal((secondary[0] as { win32Code: number }).win32Code, 32);
        }
      } finally {
        await reader?.close(); await release?.();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("native state replacement rejects aliases, hardlinks, read-only targets and cross-directory moves", windows, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-state-boundary-"));
  const source = path.join(root, "source.json"), target = path.join(root, "target.json"), alias = path.join(root, "alias.json");
  try {
    await writeFile(source, "new"); await writeFile(target, "old");
    const release = await denyDelete(target);
    try {
      assert.throws(() => windowsLaunch().replaceState(source, target), { code: "EBUSY", win32Code: 32 });
      assert.equal(await readFile(source, "utf8"), "new");
      assert.equal(await readFile(target, "utf8"), "old");
    } finally { await release(); }
    const writer = await open(source, "r+");
    try { assert.throws(() => windowsLaunch().replaceState(source, target), { code: "EBUSY" }); }
    finally { await writer.close(); }
    assert.throws(() => windowsLaunch().replaceState(source, source));
    assert.throws(() => windowsLaunch().replaceState("\\\\server\\share\\source.json", target));
    assert.throws(() => windowsLaunch().replaceState(path.join(root, "missing.json"), target), { code: "ENOENT" });
    const junction = path.join(root, "junction");
    await symlink(root, junction, "junction");
    assert.throws(() => windowsLaunch().replaceState(path.join(junction, "source.json"), path.join(junction, "target.json")));
    await rm(junction);
    assert.throws(() => windowsLaunch().replaceState(source, path.join(root, "..", "other", "target.json")));
    await link(target, alias);
    assert.throws(() => windowsLaunch().replaceState(source, target), { code: "EPERM" });
    await rm(alias);
    await chmod(target, 0o444);
    assert.throws(() => windowsLaunch().replaceState(source, target), { code: "EPERM" });
    assert.equal(await readFile(source, "utf8"), "new"); assert.equal(await readFile(target, "utf8"), "old");
  } finally {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
