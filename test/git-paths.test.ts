import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeAncestors, chmodFileNoFollow, createGitWorkspaceFilesystemPaths, ensurePrivateDirectory, GitPathSecurityError, inspectResource, removeTreeNoFollow, sameResourceIdentity, writeExclusiveFile, type RemovalChildIdentity } from "../src/git/paths.js";

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

test("descriptor-bound cleanup rejects synchronized parent and leaf substitutions", async t => {
  const root = await mkdtemp(path.join("/tmp", "squire-path-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join("/tmp", "squire-path-race-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "sentinel"), "must-survive\n");

  const parent = path.join(root, "parent");
  await mkdir(parent, { mode: 0o700 });
  const parentIdentity = await inspectResource(parent, "directory", true, root);
  await rm(parent, { recursive: true, force: true });
  await symlink(outside, parent);
  await assert.rejects(() => chmodFileNoFollow(path.join(parent, "leaf"), root), GitPathSecurityError);
  await assert.rejects(() => removeTreeNoFollow(parent, parentIdentity, root), GitPathSecurityError);

  const tree = path.join(root, "tree");
  const nested = path.join(tree, "nested");
  await mkdir(nested, { recursive: true, mode: 0o700 });
  await writeFile(path.join(nested, "owned"), "owned\n");
  const treeIdentity = await inspectResource(tree, "directory", true, root);
  const nestedIdentity = await inspectResource(nested, "directory", true, root);
  const expectedChild: RemovalChildIdentity = { name: "nested", kind: "directory", device: nestedIdentity.device, inode: nestedIdentity.inode, mode: nestedIdentity.mode, linkCount: nestedIdentity.linkCount };
  await rm(nested, { recursive: true, force: true });
  await symlink(outside, nested);
  await assert.rejects(() => removeTreeNoFollow(tree, treeIdentity, root, [expectedChild]), GitPathSecurityError);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(outside, "sentinel"), "utf8")), "must-survive\n");
});

test("filesystem-crossing policy is fail-closed on Linux when a bind mount cannot be proven", { skip: process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0 }, async t => {
  // CI environments without CAP_SYS_ADMIN skip this privileged probe. The
  // production helper still rejects every differing device seen through a
  // held descriptor; the test is intentionally never run against the checkout.
  const root = await mkdtemp(path.join("/tmp", "squire-path-mount-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mounted = path.join(root, "mounted");
  await mkdir(mounted, { mode: 0o700 });
  const outside = await mkdtemp(path.join("/tmp", "squire-path-mount-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { spawn } = await import("node:child_process");
  const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: "ignore" }); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed`))); });
  await run("/usr/bin/mount", ["--bind", outside, mounted]);
  t.after(() => run("/usr/bin/umount", ["--", mounted]).catch(() => undefined));
  await assert.rejects(() => assertSafeAncestors(path.join(mounted, "file"), root, true), GitPathSecurityError);
});
