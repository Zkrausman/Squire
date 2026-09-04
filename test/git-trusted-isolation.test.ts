import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { GitWorkspaceService } from "../src/git/workspace-service.js";
import * as isolationModule from "../src/git/trusted-isolation.js";
import { assertTrustedFilesystemOperation, closeTrustedFilesystemIsolationAuthority, composeTrustedFilesystemIsolationAuthority, TrustedFilesystemIsolationError } from "../src/git/trusted-isolation.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";

const execute = promisify(execFile);

test("runtime authentication rejects lookalikes, cross-root tokens, and unavailable evidence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-isolation-auth-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "squire-git-isolation-other-"));
  let authority: Awaited<ReturnType<typeof composeTrustedFilesystemIsolationAuthority>> | undefined;
  t.after(async () => {
    if (authority) await closeTrustedFilesystemIsolationAuthority(authority).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });
  assert.equal("TrustedFilesystemIsolationAuthority" in isolationModule, false, "the authority token has no public runtime constructor");
  authority = await composeTrustedFilesystemIsolationAuthority(root);
  assert.equal(Object.getPrototypeOf(authority), null, "issued tokens must not expose an issuer through their prototype");
  const forged = { assertTicketRoot: async (): Promise<void> => undefined };

  // This is an adversarial JavaScript-shaped value, not a test adapter. It
  // must fail at the production constructor before any service operation.
  assert.throws(() => new GitWorkspaceService({
    store: new InMemoryWorkflowStore(),
    ticketRoot: root,
    // @ts-expect-error Deliberately pass a runtime-forged lookalike.
    filesystemAuthority: forged,
    requirePublishingGates: false,
  }), TrustedFilesystemIsolationError);
  await assert.rejects(() => assertTrustedFilesystemOperation(forged, root), TrustedFilesystemIsolationError);
  await assert.rejects(() => assertTrustedFilesystemOperation(authority, otherRoot), TrustedFilesystemIsolationError);
  assert.throws(() => new GitWorkspaceService({
    store: new InMemoryWorkflowStore(),
    ticketRoot: otherRoot,
    filesystemAuthority: authority,
    requirePublishingGates: false,
  }), TrustedFilesystemIsolationError);

  await closeTrustedFilesystemIsolationAuthority(authority);
  await assert.rejects(() => assertTrustedFilesystemOperation(authority, root), TrustedFilesystemIsolationError);
  assert.throws(() => new GitWorkspaceService({
    store: new InMemoryWorkflowStore(),
    ticketRoot: root,
    filesystemAuthority: authority,
    requirePublishingGates: false,
  }), TrustedFilesystemIsolationError);
  await closeTrustedFilesystemIsolationAuthority(authority);

  const missing = path.join(root, "missing-root");
  await assert.rejects(() => composeTrustedFilesystemIsolationAuthority(missing), TrustedFilesystemIsolationError);
  await assert.rejects(() => composeTrustedFilesystemIsolationAuthority(`${root}${path.sep}`), TrustedFilesystemIsolationError);
});

test("unprivileged mount-namespace production constructor rejects forged authority before bind escape", async t => {
  const authorityModule = pathToFileURL(path.resolve("dist/src/git/trusted-isolation.js")).href;
  const serviceModule = pathToFileURL(path.resolve("dist/src/git/workspace-service.js")).href;
  const script = `
    import { execFileSync } from "node:child_process";
    import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    const { GitWorkspaceService } = await import(${JSON.stringify(serviceModule)});
    const { TrustedFilesystemIsolationError, assertTrustedFilesystemOperation, closeTrustedFilesystemIsolationAuthority, composeTrustedFilesystemIsolationAuthority } = await import(${JSON.stringify(authorityModule)});
    const main = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-mount-probe-"));
    const ticketRoot = path.join(root, "ticket");
    const mounted = path.join(ticketRoot, "artifacts");
    const outside = path.join(root, "outside");
    await mkdir(ticketRoot, { recursive: false, mode: 0o700 });
    await mkdir(mounted, { recursive: false, mode: 0o700 });
    await mkdir(outside, { recursive: false, mode: 0o700 });
    let mountedSuccessfully = false;
    let authority;
    try {
      // Issue before the bind mount, then prove the operation boundary makes
      // that otherwise authentic token stale when topology changes.
      authority = await composeTrustedFilesystemIsolationAuthority(ticketRoot);
      try { execFileSync("mount", ["--make-rprivate", "/"], { stdio: "pipe" }); } catch (error) {
        console.log(JSON.stringify({ status: "unavailable", reason: "mount-namespace-private" }));
        return;
      }
      try { execFileSync("mount", ["--bind", outside, mounted], { stdio: "pipe" }); mountedSuccessfully = true; } catch (error) {
        console.log(JSON.stringify({ status: "unavailable", reason: "bind-mount" }));
        return;
      }
      let compositionRejected = false;
      try { await composeTrustedFilesystemIsolationAuthority(ticketRoot); } catch (error) { compositionRejected = error instanceof TrustedFilesystemIsolationError; }
      let staleOperationRejected = false;
      try { await assertTrustedFilesystemOperation(authority, ticketRoot); } catch (error) { staleOperationRejected = error instanceof TrustedFilesystemIsolationError; }
      const forged = { assertTicketRoot: async () => undefined };
      let constructorRejected = false;
      try {
        new GitWorkspaceService({
          store: {},
          ticketRoot,
          // Deliberately retain the JavaScript lookalike shape from the old bypass.
          filesystemAuthority: forged,
          sourceAuthorizer: { authorize: async () => ({ cloneUrl: outside, localTransport: true }) },
          allowLocalTransport: true,
          requirePublishingGates: false,
        });
      } catch (error) { constructorRejected = error instanceof TrustedFilesystemIsolationError; }
      let forgedOperationRejected = false;
      try { await assertTrustedFilesystemOperation(forged, ticketRoot); } catch (error) { forgedOperationRejected = error instanceof TrustedFilesystemIsolationError; }
      let staleWriteEscaped = false;
      try {
        const service = new GitWorkspaceService({
          store: {},
          ticketRoot,
          filesystemAuthority: authority,
          sourceAuthorizer: { authorize: async () => ({ cloneUrl: outside, localTransport: true }) },
          allowLocalTransport: true,
          requirePublishingGates: false,
        });
        await service.createSpec({ runId: "run_stale_mount", ticketIdentifier: "AIDEV-222", repository: { owner: "example", name: "service", cloneUrl: "https://github.com/example/service.git" }, baseBranch: "main", baseSha: "a".repeat(40), objectFormat: "sha1" });
      } catch (error) { /* stale operation must fail before the writer */ }
      try { await stat(path.join(outside, "git", "run_stale_mount", "workspace-spec.json")); staleWriteEscaped = true; } catch (error) { /* expected */ }
      let escaped = false;
      try { await stat(path.join(outside, "git", "run_mount_probe", "workspace-spec.json")); escaped = true; } catch (error) { /* expected */ }
      console.log(JSON.stringify({ status: "mounted", compositionRejected, staleOperationRejected, staleWriteEscaped, constructorRejected, forgedOperationRejected, writeEscapedThroughBind: escaped, mountedSuccessfully }));
    } finally {
      if (mountedSuccessfully) { try { execFileSync("umount", ["--", mounted], { stdio: "pipe" }); } catch (error) { /* report is already emitted */ } }
      if (authority) await closeTrustedFilesystemIsolationAuthority(authority).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
    };
    await main();
  `;

  let probe: MountProbeResult | undefined;
  try {
    const result = await execute("unshare", ["--user", "--map-root-user", "--mount", "--", process.execPath, "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    // A malformed child result is a test failure, not an unavailable mount
    // capability; do not accidentally turn implementation errors into a skip.
    probe = parseProbeResult(result.stdout);
  } catch (error) {
    if (!namespaceProbeUnavailable(error)) throw error;
    // Namespace creation is an environment capability, not a security result.
    // The non-skip fallback below still exercises runtime forgery rejection and
    // unavailable-evidence failure; it never credits a mount test that did not run.
  }

  if (probe?.status === "mounted") {
    assert.equal(probe.compositionRejected, true);
    assert.equal(probe.staleOperationRejected, true);
    assert.equal(probe.staleWriteEscaped, false);
    assert.equal(probe.constructorRejected, true);
    assert.equal(probe.forgedOperationRejected, true);
    assert.equal(probe.writeEscapedThroughBind, false);
    assert.equal(probe.mountedSuccessfully, true);
    return;
  }

  // Explicit fallback: a skipped/unavailable mount probe is not positive
  // isolation evidence. Re-run the two properties that remain testable here.
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-isolation-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forged = { assertTicketRoot: async (): Promise<void> => undefined };
  assert.throws(() => new GitWorkspaceService({
    store: new InMemoryWorkflowStore(),
    ticketRoot: root,
    // @ts-expect-error Deliberately pass a runtime-forged lookalike.
    filesystemAuthority: forged,
    requirePublishingGates: false,
  }), TrustedFilesystemIsolationError);
  await assert.rejects(() => composeTrustedFilesystemIsolationAuthority(path.join(root, "not-created")), TrustedFilesystemIsolationError);
});

test("unprivileged saved mountinfo bind-over rejects every Git side-effect boundary", async () => {
  const authorityModule = pathToFileURL(path.resolve("dist/src/git/trusted-isolation.js")).href;
  const serviceModule = pathToFileURL(path.resolve("dist/src/git/workspace-service.js")).href;
  const storeModule = pathToFileURL(path.resolve("dist/test/support/in-memory-workflow-store.js")).href;
  const fixturesModule = pathToFileURL(path.resolve("dist/test/support/fixtures.js")).href;
  const script = `
    import { execFileSync } from "node:child_process";
    import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    const { GitWorkspaceService } = await import(${JSON.stringify(serviceModule)});
    const { TrustedFilesystemIsolationError, closeTrustedFilesystemIsolationAuthority, composeTrustedFilesystemIsolationAuthority, assertTrustedFilesystemOperation } = await import(${JSON.stringify(authorityModule)});
    const { InMemoryWorkflowStore } = await import(${JSON.stringify(storeModule)});
    const { run } = await import(${JSON.stringify(fixturesModule)});

    const main = async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-descriptor-probe-"));
      const source = path.join(root, "source");
      const sourceEnv = { ...process.env, HOME: path.join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "descriptor-probe", GIT_AUTHOR_EMAIL: "descriptor-probe@localhost.invalid", GIT_COMMITTER_NAME: "descriptor-probe", GIT_COMMITTER_EMAIL: "descriptor-probe@localhost.invalid" };
      const scenarios = [];
      const mountedTargets = [];
      let mountInfoTargetMounted = false;
      let freshAuthority;
      let baseSha;
      let clockNow = Date.now();
      const unavailable = reason => { console.log(JSON.stringify({ status: "unavailable", reason })); };
      const git = (...args) => String(execFileSync("git", args, { cwd: source, env: sourceEnv, stdio: ["ignore", "pipe", "pipe"] })).trim();
      const snapshotTree = async directory => {
        const rows = [];
        const visit = async current => {
          const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            const full = path.join(current, entry.name);
            const relative = path.relative(directory, full);
            const info = await stat(full, { bigint: true });
            const identity = [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");
            if (entry.isDirectory()) { rows.push(relative + "/:" + identity); await visit(full); }
            else if (entry.isFile()) rows.push(relative + ":" + identity + ":" + (await readFile(full)).toString("base64"));
            else rows.push(relative + ":unsupported:" + identity);
          }
        };
        await visit(directory);
        return rows.join("\\n");
      };
      const rejectsIsolation = async action => {
        try { await action(); return false; }
        catch (error) { return error instanceof TrustedFilesystemIsolationError; }
      };
      const makeScenario = async (name, runId, createRun) => {
        const ticketRoot = path.join(root, name, "ticket");
        await mkdir(path.join(ticketRoot, "artifacts"), { recursive: true, mode: 0o700 });
        const authority = await composeTrustedFilesystemIsolationAuthority(ticketRoot);
        scenarios.push({ name, ticketRoot, authority });
        const store = new InMemoryWorkflowStore();
        if (createRun) await store.create(run({ runId }));
        const service = new GitWorkspaceService({ store, ticketRoot, filesystemAuthority: authority, clock: { now: () => clockNow, sleep: async milliseconds => { clockNow += milliseconds; } }, allowLocalTransport: true, requirePublishingGates: false, sourceAuthorizer: { authorize: async () => ({ cloneUrl: source, localTransport: true }) } });
        const input = { runId, ticketIdentifier: "AIDEV-222", repository: { owner: "example", name: "service", cloneUrl: "https://github.com/example/service.git" }, baseBranch: "main", baseSha, objectFormat: "sha1" };
        return { name, ticketRoot, authority, store, service, input };
      };
      try {
        await mkdir(source, { recursive: false, mode: 0o700 });
        git("init", "--initial-branch=main", "--object-format=sha1");
        await writeFile(path.join(source, "README.md"), "descriptor probe\\n");
        git("add", ".");
        git("commit", "-m", "descriptor probe base");
        baseSha = git("rev-parse", "HEAD");
        try { execFileSync("mount", ["--make-rprivate", "/"], { stdio: "pipe" }); }
        catch (error) { unavailable("mount-namespace-private"); return; }
        const savedMountInfo = path.join(root, "saved-mountinfo");
        await writeFile(savedMountInfo, await readFile("/proc/self/mountinfo"), { mode: 0o600 });

        const ready = await makeScenario("ready", "run_descriptor_ready", true);
        const disposal = await makeScenario("disposal", "run_descriptor_disposal", true);
        const gitScenario = await makeScenario("git", "run_descriptor_git", true);
        const create = await makeScenario("create", "run_descriptor_create", false);
        const readySpec = await ready.service.createSpec(ready.input);
        await ready.service.provision(ready.input.runId, readySpec, "descriptor-ready");
        const disposalSpec = await disposal.service.createSpec(disposal.input);
        await disposal.service.provision(disposal.input.runId, disposalSpec, "descriptor-disposal");
        const gitSpec = await gitScenario.service.createSpec(gitScenario.input);
        const retention = { outcome: "success", workspaceRetainUntil: new Date(clockNow + 60_000).toISOString(), bundleRetainUntil: new Date(clockNow + 60_000).toISOString() };
        await disposal.service.markRetained(disposal.input.runId, retention, "descriptor-retention");
        clockNow += 120_000;
        const fence = await disposal.store.acquireRunTerminalFence(disposal.input.runId, "descriptor-fence", clockNow);

        const outside = [];
        for (const scenario of [ready, disposal, gitScenario, create]) {
          const target = path.join(root, "outside-" + scenario.name);
          await mkdir(target, { recursive: false, mode: 0o700 });
          const artifactRoot = path.join(scenario.ticketRoot, "artifacts");
          await cp(artifactRoot, target, { recursive: true });
          outside.push({ scenario, target, before: await snapshotTree(target) });
        }
        try { execFileSync("mount", ["--bind", savedMountInfo, "/proc/" + process.pid + "/mountinfo"], { stdio: "pipe" }); mountInfoTargetMounted = true; }
        catch (error) { unavailable("mountinfo-bind-over"); return; }
        try {
          for (const item of outside) {
            const target = path.join(item.scenario.ticketRoot, "artifacts");
            execFileSync("mount", ["--bind", item.target, target], { stdio: "pipe" });
            mountedTargets.push(target);
          }
        } catch (error) { unavailable("artifact-bind-over"); return; }

        try { freshAuthority = await composeTrustedFilesystemIsolationAuthority(create.ticketRoot); }
        catch (error) { /* A pathname-reopened regular saved file must fail issuance. */ }
        const issuanceRejected = !freshAuthority;
        if (freshAuthority) await closeTrustedFilesystemIsolationAuthority(freshAuthority).catch(() => undefined);
        const operationRejected = await rejectsIsolation(() => assertTrustedFilesystemOperation(ready.authority, ready.ticketRoot));
        const createSpecRejected = await rejectsIsolation(() => create.service.createSpec({ ...create.input, runId: "run_descriptor_new_spec" }));
        const realGitRejected = await rejectsIsolation(() => gitScenario.service.provision(gitScenario.input.runId, gitSpec, "descriptor-git"));
        const bundleRejected = await rejectsIsolation(() => ready.service.exportBundle(ready.input.runId, ready.input.baseSha, "descriptor-bundle"));
        const disposalRejected = await rejectsIsolation(() => disposal.service.disposeUnderTerminalFence(disposal.input.runId, fence, { now: clockNow, workspaceRetainUntil: retention.workspaceRetainUntil, bundleRetainUntil: retention.bundleRetainUntil }));
        const externalUntouched = (await Promise.all(outside.map(async item => (await snapshotTree(item.target)) === item.before))).every(Boolean);
        let gitTouched = false;
        try { await stat(path.join(gitScenario.ticketRoot, "git", "repo.git")); gitTouched = true; } catch (error) { /* expected */ }
        let createTouched = false;
        try { await stat(path.join(outside.find(item => item.scenario.name === "create").target, "git", "run_descriptor_new_spec", "workspace-spec.json")); createTouched = true; } catch (error) { /* expected */ }
        console.log(JSON.stringify({ status: "mounted", issuanceRejected, operationRejected, createSpecRejected, realGitRejected, bundleRejected, disposalRejected, externalUntouched, gitTouched, createTouched, mountedTargets: mountedTargets.length, mountInfoTargetMounted }));
      } finally {
        for (const target of [...mountedTargets].reverse()) { try { execFileSync("umount", ["--", target], { stdio: "pipe" }); } catch (error) { /* report is already emitted */ } }
        if (mountInfoTargetMounted) { try { execFileSync("umount", ["--", "/proc/" + process.pid + "/mountinfo"], { stdio: "pipe" }); } catch (error) { /* report is already emitted */ } }
        for (const scenario of scenarios) await closeTrustedFilesystemIsolationAuthority(scenario.authority).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    };
    await main();
  `;
  let probe: DescriptorMountProbeResult | undefined;
  try {
    const result = await execute("unshare", ["--user", "--map-root-user", "--mount", "--", process.execPath, "--input-type=module", "-e", script], { cwd: process.cwd(), timeout: 120_000, maxBuffer: 256 * 1024 });
    probe = parseDescriptorMountProbeResult(result.stdout);
  } catch (error) {
    if (!namespaceProbeUnavailable(error)) throw error;
  }
  if (!probe || probe.status !== "mounted") {
    // Namespace/mount capability is environmental. An unavailable probe is
    // deliberately not counted as positive isolation evidence.
    return;
  }
  assert.equal(probe.issuanceRejected, true);
  assert.equal(probe.operationRejected, true);
  assert.equal(probe.createSpecRejected, true);
  assert.equal(probe.realGitRejected, true);
  assert.equal(probe.bundleRejected, true);
  assert.equal(probe.disposalRejected, true);
  assert.equal(probe.externalUntouched, true);
  assert.equal(probe.gitTouched, false);
  assert.equal(probe.createTouched, false);
  assert.equal(probe.mountedTargets, 4);
  assert.equal(probe.mountInfoTargetMounted, true);
});

interface DescriptorMountProbeResult {
  readonly status: "mounted" | "unavailable";
  readonly issuanceRejected?: boolean;
  readonly operationRejected?: boolean;
  readonly createSpecRejected?: boolean;
  readonly realGitRejected?: boolean;
  readonly bundleRejected?: boolean;
  readonly disposalRejected?: boolean;
  readonly externalUntouched?: boolean;
  readonly gitTouched?: boolean;
  readonly createTouched?: boolean;
  readonly mountedTargets?: number;
  readonly mountInfoTargetMounted?: boolean;
}

function parseDescriptorMountProbeResult(stdout: string): DescriptorMountProbeResult {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) throw new Error("descriptor mount probe emitted no result");
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value) || !((value as { status?: unknown }).status === "mounted" || (value as { status?: unknown }).status === "unavailable")) throw new Error("descriptor mount probe result is malformed");
  return value as DescriptorMountProbeResult;
}

interface MountProbeResult {
  readonly status: "mounted" | "unavailable";
  readonly compositionRejected?: boolean;
  readonly staleOperationRejected?: boolean;
  readonly staleWriteEscaped?: boolean;
  readonly constructorRejected?: boolean;
  readonly forgedOperationRejected?: boolean;
  readonly writeEscapedThroughBind?: boolean;
  readonly mountedSuccessfully?: boolean;
}

function namespaceProbeUnavailable(error: unknown): boolean {
  return error instanceof Error && /(?:unshare failed|operation not permitted|permission denied|spawn .*ENOENT|command not found)/iu.test(error.message);
}

function parseProbeResult(stdout: string): MountProbeResult {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) throw new Error("mount probe emitted no result");
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value) || !((value as { status?: unknown }).status === "mounted" || (value as { status?: unknown }).status === "unavailable")) throw new Error("mount probe result is malformed");
  return value as MountProbeResult;
}
