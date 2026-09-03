import assert from "node:assert/strict";
import test from "node:test";
import { stat } from "node:fs/promises";
import path from "node:path";
import { AllowlistedRepositorySourceAuthorizer, RepositorySourceAuthorizationError } from "../src/git/source-authorizer.js";
import { assertCredentialFreeHttpsCloneUrl, isUnsafeNetworkAddress } from "../src/git/identity.js";
import { GitWorkspaceService } from "../src/git/workspace-service.js";
import { createGitFixture } from "./support/git-fixture.js";

test("production source authorization is closed over repository and public resolved addresses", async () => {
  const repository = { owner: "example", name: "service", cloneUrl: "https://github.com/example/service.git" };
  const authorizer = new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["140.82.112.3"] });
  assert.deepEqual(await authorizer.authorize(repository), { cloneUrl: repository.cloneUrl });
  await assert.rejects(() => new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["127.0.0.1"] }).authorize(repository), RepositorySourceAuthorizationError);
  await assert.rejects(() => new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://evil.example"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["140.82.112.3"] }).authorize(repository), /origin/u);
  await assert.rejects(() => new AllowlistedRepositorySourceAuthorizer({ allowedOrigins: ["https://github.com"], allowedRepositories: ["example/service"], resolveAddresses: async () => ["not-an-address"] }).authorize(repository), RepositorySourceAuthorizationError);
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("https://127.0.0.1/example/service.git", "example", "service"), /private|local/u);
  assert.equal(isUnsafeNetworkAddress("::ffff:127.0.0.1"), true);
  assert.equal(isUnsafeNetworkAddress("fc00::1"), true);
  assert.equal(isUnsafeNetworkAddress("fe80::1"), true);
  assert.equal(isUnsafeNetworkAddress("8.8.8.8"), false);
});

test("workspace provisioning refuses the permissive missing production authorizer", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, requirePublishingGates: false });
  await assert.rejects(() => service.createSpec(fixture.input), /explicit approved repository source authorizer/u);
  await assert.rejects(() => stat(path.join(fixture.ticketRoot, "git", "repo.git")));
});
