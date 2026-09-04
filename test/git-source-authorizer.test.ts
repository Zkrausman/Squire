import assert from "node:assert/strict";
import test from "node:test";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AllowlistedRepositorySourceAuthorizer, buildGitHttpsResolveConfig, RepositorySourceAuthorizationError } from "../src/git/source-authorizer.js";
import { assertCredentialFreeHttpsCloneUrl, isUnsafeNetworkAddress } from "../src/git/identity.js";
import { GitWorkspaceService, type GitWorkspaceServiceOptions } from "../src/git/workspace-service.js";
import type { TrustedFilesystemIsolationCapability } from "../src/git/trusted-isolation.js";
import { createGitFixture } from "./support/git-fixture.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { run } from "./support/fixtures.js";

test("production source authorization is closed over repository and public resolved addresses", async () => {
  const repository = { owner: "example", name: "service", cloneUrl: "https://github.com/example/service.git" };
  const authorizer = new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["140.82.112.3"] });
  assert.deepEqual(await authorizer.authorize(repository), { cloneUrl: repository.cloneUrl, resolvedAddresses: ["140.82.112.3"] });
  assert.deepEqual(buildGitHttpsResolveConfig(repository, ["140.82.112.3"]), ["http.curloptResolve=github.com:443:140.82.112.3"]);
  assert.deepEqual(buildGitHttpsResolveConfig({ ...repository, cloneUrl: "https://[2001:4860:4860::8888]/example/service.git" }, ["2001:4860:4860::8888"]), ["http.curloptResolve=[2001:4860:4860::8888]:443:[2001:4860:4860::8888]"]);
  await assert.rejects(() => new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["127.0.0.1"] }).authorize(repository), RepositorySourceAuthorizationError);
  await assert.rejects(() => new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://evil.example"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["140.82.112.3"] }).authorize(repository), /origin/u);
  await assert.rejects(() => new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["not-an-address"] }).authorize(repository), RepositorySourceAuthorizationError);
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("https://127.0.0.1/example/service.git", "example", "service"), /private|local/u);
  assert.equal(isUnsafeNetworkAddress("::ffff:127.0.0.1"), true);
  assert.equal(isUnsafeNetworkAddress("fc00::1"), true);
  assert.equal(isUnsafeNetworkAddress("fe80::1"), true);
  assert.equal(isUnsafeNetworkAddress("8.8.8.8"), false);
  assert.throws(() => buildGitHttpsResolveConfig(repository, ["127.0.0.1"]), RepositorySourceAuthorizationError);
});

test("Git HTTPS transport receives only the authorizer-approved address set", async () => {
  const repository = { owner: "example", name: "service", cloneUrl: "https://github.com/example/service.git" };
  const authorizer = new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["140.82.112.3", "140.82.112.4"] });
  const approval = await authorizer.authorize(repository);
  assert.deepEqual(approval.resolvedAddresses, ["140.82.112.3", "140.82.112.4"]);
  assert.deepEqual(buildGitHttpsResolveConfig(repository, approval.resolvedAddresses ?? []), ["http.curloptResolve=github.com:443:140.82.112.3", "http.curloptResolve=github.com:443:140.82.112.4"]);
});

test("production authorizer and real Git import pin the approved HTTPS addresses across a DNS change", async t => {
  const ticketRoot = await mkdtemp(path.join(os.tmpdir(), "squire-https-import-"));
  t.after(() => rm(ticketRoot, { recursive: true, force: true }));
  const repository = { owner: "octocat", name: "Hello-World", cloneUrl: "https://github.com/octocat/Hello-World.git" };
  const publicAddresses = (await lookup("github.com", { all: true, verbatim: true })).map(value => value.address).filter(address => !isUnsafeNetworkAddress(address));
  assert.ok(publicAddresses.length > 0, "the HTTPS E2E requires at least one public GitHub address");
  let resolverCalls = 0;
  let rebound = false;
  const authorizer = new AllowlistedRepositorySourceAuthorizer({
    allowedOrigins: ["https://github.com"],
    allowedRepositories: ["octocat/Hello-World"],
    resolveAddresses: async () => {
      resolverCalls += 1;
      if (resolverCalls <= 2) {
        if (resolverCalls === 2) rebound = true;
        return publicAddresses;
      }
      return rebound ? ["127.0.0.1"] : publicAddresses;
    },
  });
  const store = new InMemoryWorkflowStore();
  await store.create(run({ currentHead: "a".repeat(40) }));
  const filesystemIsolation = { assertTicketRoot: async (): Promise<void> => undefined } as unknown as TrustedFilesystemIsolationCapability;
  const service = new GitWorkspaceService({ store, ticketRoot, filesystemIsolation, sourceAuthorizer: authorizer, requirePublishingGates: false, commandTimeoutMs: 30_000 });
  const input = { runId: "run_example01", ticketIdentifier: "AIDEV-222", repository, baseBranch: "master", baseSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d", objectFormat: "sha1" as const };
  const spec = await service.createSpec(input);
  const ready = await service.provision(input.runId, spec, "https-e2e");
  assert.equal(ready.headSha, input.baseSha);
  assert.equal(resolverCalls, 2, "Git must not invoke the policy resolver after the approved transport grant");
  await assert.rejects(() => authorizer.authorize(repository), /private|local/u);
  assert.equal(resolverCalls, 3);
});

test("workspace provisioning refuses the permissive missing production authorizer", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  assert.throws(() => new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, requirePublishingGates: false } as unknown as GitWorkspaceServiceOptions), /trusted filesystem isolation capability/u);
  const service = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, filesystemIsolation: fixture.filesystemIsolation, requirePublishingGates: false });
  await assert.rejects(() => service.createSpec(fixture.input), /explicit approved repository source authorizer/u);
  const isolationBlocked = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, filesystemIsolation: { assertTicketRoot: async () => { throw new Error("sandbox isolation unavailable"); } } as unknown as typeof fixture.filesystemIsolation, requirePublishingGates: false });
  await assert.rejects(() => isolationBlocked.createSpec(fixture.input), /sandbox isolation unavailable/u);
  await assert.rejects(() => stat(path.join(fixture.ticketRoot, "git", "repo.git")));
});

test("filesystem isolation is re-proven before Git side effects", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  let checks = 0;
  const capability = { assertTicketRoot: async (): Promise<void> => { checks += 1; if (checks > 2) throw new Error("sandbox isolation unavailable"); } } as unknown as TrustedFilesystemIsolationCapability;
  const service = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, filesystemIsolation: capability, allowLocalTransport: true, sourceAuthorizer: { authorize: async (): Promise<{ cloneUrl: string; localTransport: true }> => ({ cloneUrl: fixture.source, localTransport: true }) }, requirePublishingGates: false });
  const spec = await service.createSpec(fixture.input);
  await assert.rejects(() => service.provision(fixture.input.runId, spec, "isolation-recheck"), /sandbox isolation unavailable/u);
  await assert.rejects(() => stat(path.join(fixture.ticketRoot, "git", "repo.git")));
});
