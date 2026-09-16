import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { link, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { capturePromptSet } from "../src/personal/prompt-policy.js";
import { persistLaunchMaterial, readLaunchMaterial, materialPath } from "../src/personal/launch-material.js";
import { windowsLaunch } from "../src/personal/windows-launch.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { NodeBackgroundLauncher } from "../src/personal/background-launcher.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import type { PersonalRunState } from "../src/personal/types.js";
import { TEST_CONFIG_DIGEST, TEST_MATERIAL } from "./helpers/personal-launch.js";
import { acl, assertProtectedAcl, grant, launchTestRoot, powershell } from "./helpers/windows-launch.js";

const windows = { skip: process.platform !== "win32", timeout: 60_000 };
// Exercise the actual local sandbox group when present; CI without that group
// uses an unresolvable outsider SID, never creates or modifies host accounts.
const sandboxSid = process.platform === "win32" ? powershell(`try { ([System.Security.Principal.NTAccount]::new($env:COMPUTERNAME,'CodexSandboxUsers')).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch [System.Security.Principal.IdentityNotMappedException] { 'S-1-5-21-0-0-0-1004' }`) : "";
const installerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
async function fixture() {
  const root = await launchTestRoot("squire-windows-launch-");
  const states = new JsonRunStateStore(root);
  let calls = 0;
  const controller = new PersonalMvpController({ states, launchMaterial: TEST_MATERIAL, tickets: { async get() { calls++; throw new Error("adapter invoked"); } }, phases: {} as never, workspaces: {} as never, publication: {} as never });
  const c = TEST_MATERIAL.config;
  const request = { ticketId: "AIDEV-1", repository: c.repository.slug, repositoryPath: c.repository.path, sourceRef: c.repository.sourceRef, baseBranch: c.repository.baseBranch };
  const state = await controller.reserve(request, { executionMode: "background", launchConfigDigest: TEST_CONFIG_DIGEST });
  await persistLaunchMaterial(TEST_MATERIAL, state, root);
  return { root, state, file: materialPath(root, state.runId), async rejected() {
    await assert.rejects(controller.runReserved(request, state.runId, TEST_CONFIG_DIGEST));
    assert.equal(calls, 0);
    assert.equal((await states.read(state.runId))?.version, 1, "no reservation claim");
  } };
}

test("Windows builtin material has exact protected native DACLs and is immutable on repersist", windows, async () => {
  const f = await fixture();
  try {
    assertProtectedAcl(path.dirname(f.file)); assertProtectedAcl(f.file);
    assert.deepEqual(await readLaunchMaterial(f.state, f.root), TEST_MATERIAL);
    const original = await readFile(f.file);
    await assert.rejects(persistLaunchMaterial(TEST_MATERIAL, f.state, f.root), /publish immutable bytes/);
    assert.deepEqual(await readFile(f.file), original);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Windows unexpected read/write/delete/DACL/owner ACEs fail before detached claim", windows, async () => {
  for (const rights of ["ReadAndExecute", "Write", "Delete", "ChangePermissions", "TakeOwnership"]) {
    const f = await fixture();
    try {
      grant(f.file, "S-1-1-0", rights);
      await f.rejected();
      assert.ok(acl(f.file).rules.some(r => r.sid === "S-1-1-0")); // no silent ACL repair
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("Windows inherited CodexSandboxUsers read ACE is not implicitly trusted", windows, async () => {
  const f = await fixture();
  try {
    // Make an inherited ACE on a real file. Changing test ACLs is adversarial
    // fixture setup, never a production migration or account/group mutation.
    powershell(`$a=Get-Acl -LiteralPath $p[0]; $s=[System.Security.Principal.SecurityIdentifier]::new($p[1]); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::InheritOnly,[System.Security.AccessControl.AccessControlType]::Allow)); Set-Acl -LiteralPath $p[0] -AclObject $a`, path.dirname(f.file), sandboxSid);
    powershell(`$a=Get-Acl -LiteralPath $p[0]; $a.SetAccessRuleProtection($false,$true); Set-Acl -LiteralPath $p[0] -AclObject $a`, f.file);
    assert.ok(acl(f.file).rules.some(r => r.sid === sandboxSid && r.inherited));
    await f.rejected();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Windows ancestor read/traverse is distinct from protected-child confidentiality; mutation is rejected", windows, async () => {
  const f = await fixture();
  try {
    grant(f.root, sandboxSid, "ReadAndExecute", true);
    grant(f.root, installerSid, "FullControl", true);
    assert.deepEqual(await readLaunchMaterial(f.state, f.root), TEST_MATERIAL);
    grant(f.file, installerSid, "Read");
    await f.rejected();
  } finally { await rm(f.root, { recursive: true, force: true }); }
  for (const rights of ["DeleteSubdirectoriesAndFiles", "Delete", "WriteAttributes", "WriteExtendedAttributes", "ChangePermissions", "TakeOwnership"]) {
    const root = await launchTestRoot("squire-unsafe-ancestor-");
    try {
      grant(root, "S-1-1-0", rights);
      assert.throws(() => windowsLaunch().persist(path.join(root, "material", "capture.json"), "", "bytes"), /unsafe ancestor mutation principal/);
      await assert.rejects(readFile(path.join(root, "material", "capture.json")), /ENOENT/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("Windows hardlinks and final/ancestor junctions reject before detached claim", windows, async () => {
  for (const kind of ["hardlink", "file-junction", "directory-junction", "ancestor-junction"]) {
    const f = await fixture();
    const target = await launchTestRoot("squire-reparse-target-");
    try {
      if (kind === "hardlink") await link(f.file, path.join(f.root, "linked.json"));
      if (kind === "file-junction") { await rm(f.file); await symlink(target, f.file, "junction"); }
      if (kind === "directory-junction") {
        await rename(path.dirname(f.file), path.join(target, "material"));
        await symlink(path.join(target, "material"), path.dirname(f.file), "junction");
      }
      if (kind === "ancestor-junction") {
        const nested = path.join(f.root, "alias");
        await symlink(f.root, nested, "junction");
        await assert.rejects(readLaunchMaterial(f.state, nested), /reparse|open rejected/);
      } else await f.rejected();
    } finally { await rm(f.root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
  }
});

test("Windows retained native handles reject file and directory replacement at the read boundary", windows, async () => {
  const f = await fixture();
  try {
    const native = createRequire(import.meta.url)("../../build/Release/windows_launch.node") as { read(file: string, repository: string, hook: () => void): string };
    const original = await readFile(f.file, "utf8");
    const bytes = native.read(f.file, "", () => {
      for (const source of [f.file, path.dirname(f.file), f.root]) assert.throws(() => renameSync(source, `${source}-replaced`), /EPERM|EBUSY|EACCES/);
    });
    assert.equal(bytes, original);
    // A replacement made before open cannot substitute another run's bytes:
    // envelope binding/digest validation is still authoritative.
    await rename(f.file, `${f.file}.old`);
    windowsLaunch().persist(f.file, "", original.replace(f.state.runId, "aidev-1-substituted123"));
    await f.rejected();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Windows corrupt/missing/wrong-binding/digest material rejects without claim or adapters", windows, async () => {
  for (const kind of ["missing", "corrupt", "binding", "digest"]) {
    const f = await fixture();
    try {
      const original = await readFile(f.file, "utf8");
      if (kind === "missing") await rm(f.file);
      else if (kind === "corrupt") await writeFile(f.file, "{");
      else if (kind === "binding") await writeFile(f.file, original.replace(f.state.runId, "aidev-1-wrongbinding123"));
      else { const value = JSON.parse(original); value.material.digest = "f".repeat(64); await writeFile(f.file, JSON.stringify(value)); }
      await f.rejected();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("Windows rejects unsafe pre-existing log/directory ACLs without spawning or repairing", windows, async () => {
  const root = await launchTestRoot("squire-windows-logs-");
  try {
    const file = path.join(root, "logs", "out.log");
    windowsLaunch().persist(file, "", "sentinel"); grant(file, sandboxSid, "Read");
    let calls = 0;
    const launcher = new NodeBackgroundLauncher({ spawn: (() => { calls++; throw new Error("must not spawn"); }) as never });
    await assert.rejects(launcher.launch({ executable: process.execPath, args: [], stdoutPath: file, stderrPath: path.join(root, "logs", "err.log") }), /unexpected protected-object principal/);
    assert.equal(calls, 0); assert.equal(await readFile(file, "utf8"), "sentinel");
    grant(path.dirname(file), sandboxSid, "Read");
    assert.throws(() => windowsLaunch().persist(path.join(root, "logs", "new.json"), "", "data"), /unexpected protected-object principal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows rejects repository-contained material and explicit custom roots", windows, async () => {
  const root = await launchTestRoot("squire-windows-policy-");
  try {
    assert.throws(() => windowsLaunch().persist(path.join(root, "material", "capture.json"), root, "bytes"), /outside repository/);
    await assert.rejects(capturePromptSet({ version: 1, id: "custom", root: path.join(root, "missing"), plan: [] }, root), /custom prompt roots are unsupported on Windows/);
    assert.ok((await capturePromptSet({ version: 1, id: "default", plan: [] }, root)).phases.plan);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows native log descriptors write through Node and preserve append semantics", windows, async () => {
  const root = await launchTestRoot("squire-native-fd-");
  try {
    const file = path.join(root, "logs", "out.log");
    for (let i = 0; i < 2; i++) {
      const fd = windowsLaunch().openLog(file);
      try { execFileSync(process.execPath, ["-e", "console.log('append')"], { stdio: ["ignore", fd, "pipe"], timeout: 10_000 }); }
      finally { windowsLaunch().closeLog(fd); }
    }
    assert.equal(await readFile(file, "utf8"), "append\nappend\n");
    assertProtectedAcl(file);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows failed phase copy cleans protected captured input, but never deletes a rejected preexisting file", windows, async () => {
  const root = await launchTestRoot("squire-native-phase-");
  try {
    const input = {
      runId: "aidev-1-0123456789", ticket: { id: "AIDEV-1", title: "fixture", description: "data" },
      repository: "example/repo", baseBranch: "main", branch: "squire/fixture", sandbox: "fixture",
      phase: "plan" as const, attempt: 1, expectedHead: "a".repeat(40),
      profile: { provider: "provider", model: "model", thinking: "medium" as const }, previous: {}, feedback: [],
    };
    const file = path.join(root, input.runId, "phase-inputs", "plan-1.json");
    let copies = 0;
    const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: [], launchMaterial: TEST_MATERIAL, commands: { async run(request) {
      copies++;
      assert.equal(request.args[1], file); assertProtectedAcl(file);
      assert.equal(JSON.parse(await readFile(file, "utf8")).launchDigest, TEST_MATERIAL.digest);
      throw new Error("controlled copy failure");
    } } });
    await assert.rejects(runner.run(input), /controlled copy failure/);
    await assert.rejects(readFile(file), /ENOENT/);
    windowsLaunch().persist(file, "", "preexisting"); grant(file, sandboxSid, "Read");
    await assert.rejects(runner.run(input));
    assert.equal(await readFile(file, "utf8"), "preexisting");
    assert.equal(copies, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows cancellation at material realpath and launcher boundaries cannot spawn or claim", windows, async () => {
  for (const boundary of ["material-realpath", "launcher"]) {
    const root = await launchTestRoot("squire-native-cancel-");
    const originalRealpath = fsPromises.realpath;
    try {
      let reserved = false, entered = false;
      const abort = new AbortController();
      const states = new class extends JsonRunStateStore {
        override async reserve(state: PersonalRunState): Promise<void> { await super.reserve(state); reserved = true; }
      }(root);
      const c = TEST_MATERIAL.config;
      const errors: unknown[] = [];
      if (boundary === "material-realpath") {
        fsPromises.realpath = new Proxy(originalRealpath, { apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args) as Promise<unknown>;
          if (reserved && args[0] === c.repository.path) return result.finally(() => {
            entered = true; abort.abort(new Error("cancel at material realpath"));
          });
          return result;
        } });
        syncBuiltinESMExports();
      }
      const controller = new PersonalMvpController({ states, launchMaterial: TEST_MATERIAL,
        onPersistenceError: error => { errors.push(error); }, tickets: { async get() { throw new Error("must not call adapters"); } },
        workspaces: {} as never, phases: {} as never, publication: {} as never });
      await assert.rejects(controller.startBackground({ ticketId: "AIDEV-1", repository: c.repository.slug, repositoryPath: c.repository.path, sourceRef: c.repository.sourceRef, baseBranch: c.repository.baseBranch }, {
        launcher: { async launch() {
          assert.equal(boundary, "launcher", "material-await cancellation must prevent launcher invocation");
          entered = true; abort.abort(new Error("cancel at launcher")); throw abort.signal.reason;
        } },
        cliPath: path.resolve("dist/src/personal/cli.js"), configPath: path.resolve("squire.config.example.json"),
        stateDirectory: root, logsDirectory: path.join(root, "logs"), launchConfigDigest: TEST_CONFIG_DIGEST, signal: abort.signal,
      }), /cancel at/);
      assert.equal(entered, true); assert.deepEqual(errors, []);
      const state = (await states.findByTicket("AIDEV-1"))[0]!;
      assert.equal(state.status, "interrupted"); assert.equal(state.launchState, "failed");
      assert.equal(await states.reservationOwner("AIDEV-1"), undefined);
      assertProtectedAcl(materialPath(root, state.runId));
    } finally {
      fsPromises.realpath = originalRealpath; syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Windows missing native support fails with actionable error, never a path-only fallback", windows, async () => {
  const root = await launchTestRoot("squire-native-unavailable-");
  try {
    const directory = path.join(root, "src", "a", "b");
    await fsPromises.mkdir(directory, { recursive: true });
    const module = path.join(directory, "windows-launch.mjs");
    await writeFile(module, await readFile(new URL("../src/personal/windows-launch.js", import.meta.url)));
    const { pathToFileURL } = await import("node:url");
    const isolated = await import(pathToFileURL(module).href) as { windowsLaunch(): unknown };
    assert.throws(() => isolated.windowsLaunch(), /requires native security support.*npm ci.*no unsafe fallback/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
