import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, rm, symlink, link, readFile } from "node:fs/promises";
import path from "node:path";
import { publishCohort, readPrivateArtifact, sha256 } from "../src/personal/private-artifact-store.js";
import { launchTestRoot, assertProtectedAcl, grant } from "./helpers/windows-launch.js";
import { privateFile } from "./helpers/cohort.js";
const repository = path.resolve(".");
test("private atomic publication is exact-byte idempotent and conflict refusing", async () => {
  const root = await launchTestRoot("cohort-store-");
  try {
    const bytes = Buffer.from('{"synthetic":true}'), id = sha256("request");
    const file = await publishCohort(root, repository, id, bytes), before = await lstat(file);
    assert.deepEqual(await readPrivateArtifact(file, repository), bytes);
    assert.equal(await publishCohort(root, repository, id, bytes), file);
    const after = await lstat(file); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
    await assert.rejects(publishCohort(root, repository, id, Buffer.from('{}')));
    assert.deepEqual(await readFile(file), bytes);
    if (process.platform === "win32") assertProtectedAcl(file); else { assert.equal(after.mode & 0o777, 0o600); assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700); }
    await assert.rejects(publishCohort(root, repository, "../escape", bytes));
    await assert.rejects(publishCohort(repository, repository, id, bytes));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("bounded immutable reads reject links, public permissions and repository containment", async () => {
  const root = await launchTestRoot("cohort-store-");
  try {
    const source = await privateFile(root, "source", Buffer.from("sensitive"));
    await assert.rejects(readPrivateArtifact(source.path, root));
    await assert.rejects(readPrivateArtifact(source.path, repository, 3));
    const hard = path.join(root, "hard.json"); await link(source.path, hard);
    await assert.rejects(readPrivateArtifact(source.path, repository)); await rm(hard);
    const linked = path.join(root, "linked.json");
    try { await symlink(source.path, linked); await assert.rejects(readPrivateArtifact(linked, repository)); } catch (e) { if (process.platform !== "win32" || (e as NodeJS.ErrnoException).code !== "EPERM") throw e; }
    if (process.platform === "win32") grant(source.path, "S-1-1-0", "R"); else await chmod(source.path, 0o644);
    await assert.rejects(readPrivateArtifact(source.path, repository));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("native artifact reads preserve bytes beyond report's 2MiB bound without weakening report limits", async () => {
  const root = await launchTestRoot("cohort-store-");
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 65), source = await privateFile(root, "large", bytes);
    assert.deepEqual(await readPrivateArtifact(source.path, repository), bytes);
    await assert.rejects(readPrivateArtifact(source.path, repository, 2 * 1024 * 1024));
  } finally { await rm(root, { recursive: true, force: true }); }
});
