import assert from "node:assert/strict";
import test from "node:test";
import { assertBaseBranch, assertCredentialFreeHttpsCloneUrl, assertFullObjectId, assertGitRefFormat, assertValidInternalRefName, assertValidRefName, branchRef, deriveFeatureBranch, GitIdentityError } from "../src/git/identity.js";

test("derives the immutable AIDEV-222 branch and validates complete refs", async () => {
  assert.equal(deriveFeatureBranch("AIDEV-222", "run_example01"), "squire/aidev-222-run_example01");
  assert.equal(branchRef("squire/aidev-222-run_example01"), "refs/heads/squire/aidev-222-run_example01");
  assert.equal(assertBaseBranch("main"), "refs/heads/main");
  assert.equal(assertValidInternalRefName("refs/squire/run_example01/base"), "refs/squire/run_example01/base");
  await assert.doesNotReject(() => assertGitRefFormat("refs/heads/main", { checkRefFormat: async () => undefined }));
});

test("rejects identity, revision-expression, and unsafe source values", () => {
  assert.equal(deriveFeatureBranch("AIDEV-222", "run_x"), "squire/aidev-222-run_x");
  for (const value of ["run_", "run_x/../y", "run_x.lock", "run_x@{1}"]) assert.throws(() => deriveFeatureBranch("AIDEV-222", value), GitIdentityError);
  for (const value of ["a".repeat(39), "A".repeat(40), "0".repeat(40), "a".repeat(40) + "^{}", "a".repeat(64)]) assert.throws(() => assertFullObjectId(value, "sha1"), GitIdentityError);
  assert.equal(assertFullObjectId("b".repeat(64), "sha256"), "b".repeat(64));
  assert.throws(() => assertFullObjectId("b".repeat(40), "sha256"), GitIdentityError);
  for (const value of ["refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a@{1}", "refs/tags/a", "refs/heads/a\n-b"]) assert.throws(() => assertValidRefName(value), GitIdentityError);
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("http://github.com/example/service.git", "example", "service"), GitIdentityError);
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("https://user:secret@github.com/example/service.git", "example", "service"), GitIdentityError);
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("https://github.com/example/other.git", "example", "service"), GitIdentityError);
});

test("accepts only the exact credential-free repository URL identity", () => {
  const approved = assertCredentialFreeHttpsCloneUrl("https://github.com/example/service.git", "example", "service");
  assert.equal(approved.url.hostname, "github.com");
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("https://github.com/example/service.git?token=secret", "example", "service"), GitIdentityError);
  assert.throws(() => assertCredentialFreeHttpsCloneUrl("https://github.com/example/service.git#fragment", "example", "service"), GitIdentityError);
});
