import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { NodeCommandRunner, type CommandPort, type CommandRequest, type CommandResult } from "../src/personal/command.js";
import { DockerSandboxWorkspace } from "../src/personal/docker-sandbox.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";

const exec = promisify(execFile);

type OwnershipRequest = Readonly<{ owner: string; target: string; recursive: boolean }>;

function shellPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):/u, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

class SandboxShim implements CommandPort {
  readonly host = new NodeCommandRunner();
  readonly requests: CommandRequest[] = [];
  readonly ownershipRequests: OwnershipRequest[] = [];
  readonly executedShellScripts: string[] = [];
  readonly runtimeRequests: string[] = [];
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
      const translate = (value: string): string => value
        .replaceAll("/ticket", shellPath(path.join(this.sandboxRoot, "ticket")))
        .replaceAll("/tmp/squire-source.bundle", shellPath(path.join(this.sandboxRoot, "tmp/squire-source.bundle")));
      if (script.includes("npm ci --prefix /ticket/runtime")) {
        assert.equal(request.args[1], "-u");
        assert.equal(request.args[2], "1000:1000");
        this.runtimeRequests.push(script);
        // Execute the conditional runtime setup instead of returning success
        // blindly. This proves repositories without the optional declaration
        // do not fail on Squire-specific CI fixtures.
        const executable = translate(script)
          .replace(/npm ci --prefix (\S+) --ignore-scripts --no-audit --no-fund/u, "mkdir -p $1/node_modules")
          .replace(/^\s*node \S+\/\.github\/validate-ticket-runtime\.mjs$/mu, "  true");
        return this.host.run({ command: "sh", args: ["-lc", executable] }, signal);
      }
      const ownershipCommand = "chown -R '1000:1000' /ticket";
      const lines = script.split("\n");
      assert.equal(lines.filter(line => line === ownershipCommand).length, 1, "production must request the expected privileged ownership setup");
      this.ownershipRequests.push({ owner: "1000:1000", target: "/ticket", recursive: true });
      // `chown` is a privileged sandbox setup operation. Model its successful
      // execution rather than running it on the unprivileged test host, while
      // leaving every real Git, filesystem, and permission operation intact.
      const executableScript = lines.filter(line => line !== ownershipCommand).join("\n");
      const translated = translate(executableScript);
      this.executedShellScripts.push(translated);
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
  const sourceLookup = commands.requests.find(request => request.command === "git" && request.args.includes("rev-parse"));
  assert.deepEqual(sourceLookup?.args.slice(-3), ["--verify", "--end-of-options", "refs/remotes/origin/main^{commit}"]);
  const setup = commands.requests.find(request => request.command === "sbx" && request.args[0] === "exec" && request.args.includes("sh"));
  assert.deepEqual(setup?.args.slice(0, 5), ["exec", "-u", "root", "squire-aidev-1-0123456789", "sh"]);
  assert.match(setup?.args.at(-1) ?? "", /chown -R '1000:1000' \/ticket/u);
  const runtime = commands.requests.find(request => request.command === "sbx" && request.args[0] === "exec" && request.args.some(argument => argument.includes("npm ci --prefix /ticket/runtime")));
  assert.deepEqual(runtime?.args.slice(0, 5), ["exec", "-u", "1000:1000", "squire-aidev-1-0123456789", "sh"]);
  assert.match(runtime?.args.at(-1) ?? "", /npm ci --prefix \/ticket\/runtime --ignore-scripts --no-audit --no-fund/u);
  assert.match(runtime?.args.at(-1) ?? "", /node \/ticket\/workspace\/\.github\/validate-ticket-runtime\.mjs/u);
  assert.match(runtime?.args.at(-1) ?? "", /if \[ -e \/ticket\/workspace\/.github\/runtime\/package\.json \] \|\| \[ -L \/ticket\/workspace\/.github\/runtime\/package\.json \].*\[ -e \/ticket\/workspace\/.github\/runtime\/package-lock\.json \].*\[ -e \/ticket\/workspace\/.github\/validate-ticket-runtime\.mjs \].*\[ -L \/ticket\/workspace\/.github\/validate-ticket-runtime\.mjs \]; then/u);
  assert.match(runtime?.args.at(-1) ?? "", /test -f \/ticket\/workspace\/.github\/runtime\/package-lock\.json && test ! -L \/ticket\/workspace\/.github\/runtime\/package-lock\.json/u);
  assert.equal(commands.runtimeRequests.length, 1);
  await assert.rejects(readFile(path.join(sandboxRoot, "ticket/runtime/package.json")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepEqual(commands.ownershipRequests, [{ owner: "1000:1000", target: "/ticket", recursive: true }]);
  assert.equal(commands.executedShellScripts.some(script => script.split("\n").some(line => line.includes("chown"))), false);
  assert.equal(commands.executedShellScripts.some(script => script.includes("chmod 0700")), true);
  const requestsBeforeMovedSource = commands.requests.length;
  const secondBridge = path.join(root, "bridges", "aidev-1-0123456789-second");
  const secondStaging = path.join(root, "staging", "aidev-1-0123456789-second");
  await assert.rejects(workspace.prepare({
    runId: "aidev-1-0123456789-second",
    ticketId: "AIDEV-1",
    sandbox: "squire-aidev-1-0123456789-second",
    branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
    repositoryPath: repository,
    sourceRef: "refs/remotes/origin/main",
    expectedBaseSha: first,
  }), /configured source ref changed after background reservation/u);
  assert.equal(commands.requests.slice(requestsBeforeMovedSource).some(request => request.command === "sbx"), false);
  await assert.rejects(access(secondBridge));
  await assert.rejects(access(secondStaging));
  assert.equal(await git(repository, ["rev-parse", "refs/remotes/origin/main"]), localHead);
  const refs = await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/squire-source-"]);
  assert.equal(refs, "");
  const checkout = path.join(sandboxRoot, "ticket/workspace");
  assert.equal((await readFile(path.join(checkout, "source.txt"), "utf8")).replaceAll("\r\n", "\n"), "one\n");
  assert.ok((await readdir(path.join(root, "staging", "aidev-1-0123456789"))).includes("source.bundle"));
});

test("declared ticket runtime is provisioned and incomplete declarations fail closed", async t => {
  await t.test("complete declaration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-runtime-complete-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    await exec("git", ["init", "-q", repository]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await mkdir(path.join(repository, ".github/runtime"), { recursive: true });
    await writeFile(path.join(repository, ".github/runtime/package.json"), '{"name":"runtime-fixture","version":"1.0.0","private":true}\n');
    await writeFile(path.join(repository, ".github/runtime/package-lock.json"), '{"name":"runtime-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"runtime-fixture","version":"1.0.0"}}}\n');
    await writeFile(path.join(repository, ".github/validate-ticket-runtime.mjs"), "process.exit(0);\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "runtime"]);

    const sandboxRoot = path.join(root, "sandbox");
    const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-runtime-ok");
    const workspace = new DockerSandboxWorkspace({ commands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
    await workspace.prepare({ runId: "aidev-1-runtime-ok", ticketId: "AIDEV-1", sandbox: "squire-aidev-1-runtime-ok", branch: deterministicFeatureBranch("example/repo", "AIDEV-1"), repositoryPath: repository, sourceRef: "HEAD" });
    assert.match(await readFile(path.join(sandboxRoot, "ticket/runtime/package.json"), "utf8"), /runtime-fixture/u);
    assert.equal(commands.runtimeRequests.length, 1);
  });

  await t.test("partial declaration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-runtime-partial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    await exec("git", ["init", "-q", repository]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await mkdir(path.join(repository, ".github/runtime"), { recursive: true });
    await writeFile(path.join(repository, ".github/runtime/package.json"), '{"name":"incomplete","version":"1.0.0"}\n');
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "incomplete runtime"]);

    const sandboxRoot = path.join(root, "sandbox");
    const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-runtime-bad");
    const workspace = new DockerSandboxWorkspace({ commands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
    await assert.rejects(workspace.prepare({ runId: "aidev-1-runtime-bad", ticketId: "AIDEV-1", sandbox: "squire-aidev-1-runtime-bad", branch: deterministicFeatureBranch("example/repo", "AIDEV-1"), repositoryPath: repository, sourceRef: "HEAD" }), /sh failed/u);
    assert.equal(commands.runtimeRequests.length, 1);
  });

  await t.test("symlinked declaration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-runtime-symlink-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    await exec("git", ["init", "-q", repository]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await mkdir(path.join(repository, ".github/runtime"), { recursive: true });
    await writeFile(path.join(repository, "runtime-package.json"), '{"name":"linked","version":"1.0.0"}\n');
    await symlink("../../runtime-package.json", path.join(repository, ".github/runtime/package.json"));
    await writeFile(path.join(repository, ".github/runtime/package-lock.json"), '{"name":"linked","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"linked","version":"1.0.0"}}}\n');
    await writeFile(path.join(repository, ".github/validate-ticket-runtime.mjs"), "process.exit(0);\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "symlinked runtime"]);

    const sandboxRoot = path.join(root, "sandbox");
    const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-runtime-link");
    const workspace = new DockerSandboxWorkspace({ commands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
    await assert.rejects(workspace.prepare({ runId: "aidev-1-runtime-link", ticketId: "AIDEV-1", sandbox: "squire-aidev-1-runtime-link", branch: deterministicFeatureBranch("example/repo", "AIDEV-1"), repositoryPath: repository, sourceRef: "HEAD" }), /sh failed/u);
    assert.equal(commands.runtimeRequests.length, 1);
  });
});

test("temporary source refs are compare-deleted when bundling fails or is aborted", async t => {
  await t.test("bundle failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-source-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    await exec("git", ["init", "-q", repository]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repository, "source.txt"), "pinned\n");
    await git(repository, ["add", "source.txt"]);
    await git(repository, ["commit", "-qm", "first"]);
    const first = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["update-ref", "refs/remotes/origin/main", first]);

    const sandboxRoot = path.join(root, "sandbox");
    const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-0123456789");
    const failingCommands: CommandPort = {
      async run(request, signal) {
        if (request.command === "git" && request.args.includes("bundle")) throw new Error("bundle failed");
        return commands.run(request, signal);
      },
    };
    const workspace = new DockerSandboxWorkspace({ commands: failingCommands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
    await assert.rejects(workspace.prepare({
      runId: "aidev-1-0123456789",
      ticketId: "AIDEV-1",
      sandbox: "squire-aidev-1-0123456789",
      branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
      repositoryPath: repository,
      sourceRef: "refs/remotes/origin/main",
    }), /bundle failed/);
    assert.equal(await git(repository, ["rev-parse", "refs/remotes/origin/main"]), first);
    assert.equal(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/squire-source-"]), "");
    assert.ok(commands.requests.some(request => request.command === "git" && request.args.includes("update-ref") && request.args.includes("-d")));
  });

  await t.test("ref-creation collision is not cleaned up as owned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-source-collision-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    await exec("git", ["init", "-q", repository]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repository, "source.txt"), "pinned\n");
    await git(repository, ["add", "source.txt"]);
    await git(repository, ["commit", "-qm", "first"]);
    const first = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["update-ref", "refs/remotes/origin/main", first]);

    const sandboxRoot = path.join(root, "sandbox");
    const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-0123456789");
    let collidingRef: string | undefined;
    const collidingCommands: CommandPort = {
      async run(request, signal) {
        if (request.command === "git" && request.args.includes("update-ref") && !request.args.includes("-d")) {
          const updateRefIndex = request.args.indexOf("update-ref");
          collidingRef = request.args[updateRefIndex + 1];
          if (collidingRef) await git(repository, ["update-ref", collidingRef, first]);
        }
        return commands.run(request, signal);
      },
    };
    const workspace = new DockerSandboxWorkspace({ commands: collidingCommands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
    await assert.rejects(workspace.prepare({
      runId: "aidev-1-0123456789",
      ticketId: "AIDEV-1",
      sandbox: "squire-aidev-1-0123456789",
      branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
      repositoryPath: repository,
      sourceRef: "refs/remotes/origin/main",
    }));
    assert.ok(collidingRef);
    assert.equal(await git(repository, ["rev-parse", collidingRef]), first);
    assert.equal(commands.requests.some(request => request.command === "git" && request.args.includes("update-ref") && request.args.includes("-d")), false);
  });

  await t.test("abort during bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "squire-source-abort-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    await exec("git", ["init", "-q", repository]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repository, "source.txt"), "pinned\n");
    await git(repository, ["add", "source.txt"]);
    await git(repository, ["commit", "-qm", "first"]);
    const first = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["update-ref", "refs/remotes/origin/main", first]);

    const sandboxRoot = path.join(root, "sandbox");
    const commands = new SandboxShim(sandboxRoot, "squire-aidev-1-0123456789");
    const abort = new AbortController();
    const abortingCommands: CommandPort = {
      async run(request, signal) {
        if (request.command === "git" && request.args.includes("bundle")) {
          abort.abort();
          throw new Error("bundle aborted");
        }
        return commands.run(request, signal);
      },
    };
    const workspace = new DockerSandboxWorkspace({ commands: abortingCommands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging") });
    await assert.rejects(workspace.prepare({
      runId: "aidev-1-0123456789",
      ticketId: "AIDEV-1",
      sandbox: "squire-aidev-1-0123456789",
      branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
      repositoryPath: repository,
      sourceRef: "refs/remotes/origin/main",
    }, abort.signal), /bundle aborted/);
    assert.equal(await git(repository, ["rev-parse", "refs/remotes/origin/main"]), first);
    assert.equal(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/squire-source-"]), "");
    assert.ok(commands.requests.some(request => request.command === "git" && request.args.includes("update-ref") && request.args.includes("-d")));
  });
});
