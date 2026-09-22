import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installSkills, resolvePiAgentDirectory } from "../src/personal/install-skills.js";
import { parseArguments } from "../src/personal/cli-arguments.js";

const repository = process.cwd();

function environment(agentDirectory: string): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: agentDirectory };
}

async function packageFixture(root: string): Promise<string> {
  const packageRoot = path.join(root, "package");
  await mkdir(packageRoot, { recursive: true });
  await cp(path.join(repository, "skills"), path.join(packageRoot, "skills"), { recursive: true });
  return packageRoot;
}

test("install-skills has a bounded grammar and resolves Windows/POSIX agent paths", () => {
  assert.deepEqual(parseArguments(["install-skills"]), { command: "install-skills" });
  assert.equal(parseArguments(["install-skills", "--config", "ignored.json"]), undefined);
  assert.equal(resolvePiAgentDirectory({ platform: "posix", env: { HOME: "/home/ada" } }), "/home/ada/.pi/agent");
  assert.equal(resolvePiAgentDirectory({ platform: "win32", env: { USERPROFILE: "C:\\Users\\Ada" } }), "C:\\Users\\Ada\\.pi\\agent");
  assert.equal(resolvePiAgentDirectory({ platform: "win32", env: { PI_CODING_AGENT_DIR: "D:\\Pi\\agent" } }), "D:\\Pi\\agent");
  assert.throws(() => resolvePiAgentDirectory({ platform: "posix", env: { PI_CODING_AGENT_DIR: "relative" } }), /absolute directory/u);
  assert.throws(() => resolvePiAgentDirectory({ platform: "posix", env: { PI_CODING_AGENT_DIR: "/" } }), /filesystem root/u);
});

test("first install, refresh, idempotence, preservation, and writable modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-install-skills-"));
  try {
    const packageRoot = await packageFixture(root);
    const agent = path.join(root, "agent");
    const unrelatedFile = path.join(agent, "skills", "unrelated", "keep.txt");
    await mkdir(path.dirname(unrelatedFile), { recursive: true });
    await writeFile(unrelatedFile, "unrelated");

    // Simulate a read-only packaged/build checkout. These bits are not
    // artifact content and must not be inherited by installed files.
    await chmod(path.join(packageRoot, "skills", "squire-operator", "SKILL.md"), 0o444);
    const first = await installSkills({ packageRoot, env: environment(agent) });
    assert.deepEqual(first.skills.map(item => item.status), ["installed", "installed"]);
    assert.equal((await stat(path.join(agent, "skills", "squire-operator", "SKILL.md"))).mode & 0o200, 0o200);
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated");

    const second = await installSkills({ packageRoot, env: environment(agent) });
    assert.deepEqual(second.skills.map(item => item.status), ["current", "current"]);

    const changed = path.join(agent, "skills", "squire-operator", "SKILL.md");
    await writeFile(changed, "changed by test");
    await chmod(changed, 0o444);
    const third = await installSkills({ packageRoot, env: environment(agent) });
    assert.deepEqual(third.skills.map(item => item.status), ["refreshed", "current"]);
    assert.deepEqual(await readFile(changed), await readFile(path.join(packageRoot, "skills", "squire-operator", "SKILL.md")));
    assert.equal((await stat(changed)).mode & 0o200, 0o200);
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged and owned destination aliases are rejected", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-install-alias-"));
  try {
    const packageRoot = await packageFixture(root);
    const sourceAlias = path.join(packageRoot, "skills", "squire-operator", "references", "alias.md");
    const sourceTarget = path.join(root, "outside-source.txt");
    await writeFile(sourceTarget, "outside");
    await symlink(sourceTarget, sourceAlias);
    await assert.rejects(installSkills({ packageRoot, env: environment(path.join(root, "agent")) }), /alias/u);

    const cleanPackageRoot = await packageFixture(path.join(root, "clean"));
    const agent = path.join(root, "agent-destination");
    const destination = path.join(agent, "skills", "squire-operator");
    const destinationTarget = path.join(root, "outside-destination");
    await mkdir(path.dirname(destination), { recursive: true });
    await mkdir(destinationTarget);
    await symlink(destinationTarget, destination);
    await assert.rejects(installSkills({ packageRoot: cleanPackageRoot, env: environment(agent) }), /alias/u);
    assert.deepEqual(await readdir(destinationTarget), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed refresh rolls back and removes the sibling temporary directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-install-failure-"));
  try {
    const packageRoot = await packageFixture(root);
    const agent = path.join(root, "agent");
    await installSkills({ packageRoot, env: environment(agent) });
    const destinationFile = path.join(agent, "skills", "squire-operator", "SKILL.md");
    await writeFile(destinationFile, "preserve this old owned file");
    let injected = false;
    await assert.rejects(installSkills({
      packageRoot,
      env: environment(agent),
      fileSystem: {
        rename: async (source, destination) => {
          if (!injected && source.includes(`${path.sep}.squire-operator.squire-install-`) && destination.endsWith(`${path.sep}squire-operator`)) {
            injected = true;
            const error = new Error("injected rename failure") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
          await fsRename(source, destination);
        },
      },
    }), /owned skill replacement/u);
    assert.equal(injected, true);
    assert.equal(await readFile(destinationFile, "utf8"), "preserve this old owned file");
    assert.deepEqual((await readdir(path.join(agent, "skills"))).sort(), ["squire-bug-report", "squire-operator"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
