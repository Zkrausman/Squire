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
import { assertTrustedFilesystemOperation, composeTrustedFilesystemIsolationAuthority, TrustedFilesystemIsolationError } from "../src/git/trusted-isolation.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";

const execute = promisify(execFile);

test("runtime authentication rejects lookalikes, cross-root tokens, and unavailable evidence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-isolation-auth-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "squire-git-isolation-other-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });
  assert.equal("TrustedFilesystemIsolationAuthority" in isolationModule, false, "the authority token has no public runtime constructor");
  const authority = await composeTrustedFilesystemIsolationAuthority(root);
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
    const { TrustedFilesystemIsolationError, assertTrustedFilesystemOperation, composeTrustedFilesystemIsolationAuthority } = await import(${JSON.stringify(authorityModule)});
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
