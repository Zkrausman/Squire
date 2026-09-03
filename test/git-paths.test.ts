import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeAncestors, createGitWorkspaceFilesystemPaths, ensurePrivateDirectory, GitPathSecurityError, inspectResource, removeTreeNoFollow, sameResourceIdentity, writeExclusiveFile } from "../src/git/paths.js";

test("creates fixed run-scoped paths and rejects symlinked ancestors", async t => {
  const ticketRoot = await mkdtemp(path.join("/tmp", "squire-path-test-"));
  t.after(async () => rm(ticketRoot, { recursive: true, force: true }));
  const paths = createGitWorkspaceFilesystemPaths("run_example01", ticketRoot);
  assert.equal(paths.repository, path.join(ticketRoot, "git", "repo.git"));
  assert.equal(paths.worktree, path.join(ticketRoot, "workspace"));
  await ensurePrivateDirectory(path.join(ticketRoot, "safe"), ticketRoot);
  await writeExclusiveFile(path.join(ticketRoot, "safe", "one.json"), Buffer.from("one\n"), ticketRoot);
  const identity = await inspectResource(path.join(ticketRoot, "safe", "one.json"), "file", true, ticketRoot);
  assert.equal(identity.linkCount, 1);
  assert.equal(sameResourceIdentity(identity, identity), true);
  await assert.rejects(() => inspectResource(path.join(ticketRoot, "safe", "one.json"), "directory", true, ticketRoot), GitPathSecurityError);
  await assert.rejects(() => assertSafeAncestors(path.join(ticketRoot, "safe", "one.json", "child"), ticketRoot, false), GitPathSecurityError);
});

test("rejects symlinks and hardlinked sensitive files without following them", async t => {
  const fs = await import("node:fs/promises");
  const ticketRoot = await fs.mkdtemp(path.join("/tmp", "squire-path-negative-"));
  t.after(async () => fs.rm(ticketRoot, { recursive: true, force: true }));
  await mkdir(path.join(ticketRoot, "real"), { mode: 0o700 });
  await writeFile(path.join(ticketRoot, "real", "target"), "target\n");
  await symlink(path.join(ticketRoot, "real"), path.join(ticketRoot, "link"));
  await assert.rejects(() => ensurePrivateDirectory(path.join(ticketRoot, "link", "child"), ticketRoot), GitPathSecurityError);
  await assert.rejects(() => inspectResource(path.join(ticketRoot, "link"), "directory", true, ticketRoot), GitPathSecurityError);
  const second = path.join(ticketRoot, "real", "second");
  await writeFile(second, "target\n");
  const hardlink = path.join(ticketRoot, "real", "hardlink");
  await fs.link(second, hardlink);
  await assert.rejects(() => inspectResource(hardlink, "file", true, ticketRoot), GitPathSecurityError);
  const tree = path.join(ticketRoot, "tree");
  await mkdir(path.join(tree, "nested"), { mode: 0o700, recursive: true });
  await writeFile(path.join(tree, "nested", "file"), "x");
  const treeIdentity = await inspectResource(tree, "directory", true, ticketRoot);
  await removeTreeNoFollow(tree, treeIdentity, ticketRoot);
  await assert.rejects(() => lstat(tree));
});
