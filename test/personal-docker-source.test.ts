import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { NodeCommandRunner, type CommandPort, type CommandRequest, type CommandResult } from "../src/personal/command.js";
import { DockerSandboxWorkspace } from "../src/personal/docker-sandbox.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";

const exec = promisify(execFile);

class SandboxShim implements CommandPort {
  readonly host = new NodeCommandRunner();
  readonly requests: CommandRequest[] = [];
  constructor(readonly sandboxRoot: string, readonly sandbox: string) {}

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    this.requests.push({ ...request, args: [...request.args] });
    if (request.command === "git") {
      return this.host.run(request, signal);
    }
    assert.equal(request.command, "sbx");
    if (request.args[0] === "create") {
      await mkdir(path.join(this.sandboxRoot, "ticket"), { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (request.args[0] === "cp") {
      const source = request.args[1]!;
      const destination = request.args[2]!;
      const target = path.join(this.sandboxRoot, destination.slice(this.sandbox.length + 1));
      await mkdir(path.dirname(target), { recursive: true });
      await (await import("node:fs/promises")).copyFile(source, target);
      return { stdout: "", stderr: "" };
    }
    if (request.args[0] === "exec" && request.args.includes("sh")) {
      const script = request.args[request.args.length - 1]!;
      const translated = script
        .replaceAll("/ticket", path.join(this.sandboxRoot, "ticket"))
        .replaceAll("/tmp/squire-source.bundle", path.join(this.sandboxRoot, "tmp/squire-source.bundle"));
      return this.host.run({ command: "sh", args: ["-lc", translated] }, signal);
    }
    if (request.args[0] === "exec" && request.args.includes("git")) {
      const args = request.args.slice(request.args.indexOf("git") + 1).map(argument => argument === "/ticket/workspace" ? path.join(this.sandboxRoot, "ticket/workspace") : argument);
      return this.host.run({ command: "git", args }, signal);
    }
    throw new Error(`unsupported sandbox command: ${request.args.join(" ")}`);
  }
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-C", directory, ...args]);
  return result.stdout.trim();
}

test("remote-tracking source is pinned and cloned at the exact resolved commit", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-remote-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  await exec("git", ["init", "-q", repository]);
  await git(repository, ["config", "user.name", "Test"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repository, "source.txt"), "one\n");
  await git(repository, ["add", "source.txt"]);
  await git(repository, ["commit", "-qm", "first"]);
  const first = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repository, "source.txt"), "two\n");
  await git(repository, ["commit", "-qam", "second"]);
  const localHead = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["update-ref", "refs/remotes/origin/main", first]);

  const sandboxRoot = path.join(root, "sandbox");
  const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-0123456789");
  let moved = false;
  const movingCommands: CommandPort = {
    async run(request, signal) {
      const result = await commands.run(request, signal);
      if (!moved && request.command === "git" && request.args.includes("rev-parse")) {
        moved = true;
        await git(repository, ["update-ref", "refs/remotes/origin/main", localHead]);
      }
      return result;
    },
  };
  const workspace = new DockerSandboxWorkspace({ commands: movingCommands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
  const prepared = await workspace.prepare({
    runId: "aidev-1-0123456789",
    ticketId: "AIDEV-1",
    sandbox: "squire-aidev-1-0123456789",
    branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
    repositoryPath: repository,
    sourceRef: "refs/remotes/origin/main",
  });
  assert.equal(prepared.baseSha, first);
  assert.equal(prepared.head, first);
  assert.notEqual(first, localHead);
  assert.equal(await git(repository, ["rev-parse", "refs/remotes/origin/main"]), localHead);
  const refs = await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/squire-source-"]);
  assert.equal(refs, "");
  const checkout = path.join(sandboxRoot, "ticket/workspace");
  assert.equal(await readFile(path.join(checkout, "source.txt"), "utf8"), "one\n");
  assert.ok((await readdir(path.join(root, "staging", "aidev-1-0123456789"))).includes("source.bundle"));
});
