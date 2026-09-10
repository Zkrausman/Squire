import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandPort } from "./command.js";
import type { CandidateBundle, PreparedWorkspace, WorkspacePort } from "./types.js";

export interface DockerSandboxWorkspaceOptions {
  readonly commands: CommandPort;
  readonly bridgeRoot: string;
  readonly stagingRoot: string;
  readonly template?: string;
  readonly roleUser?: string;
  readonly piAgentDirectory?: string;
  readonly piAuthFile?: string;
  readonly sbxExecutable?: string;
  readonly gitExecutable?: string;
}

export class DockerSandboxWorkspace implements WorkspacePort {
  readonly #commands: CommandPort;
  readonly #bridgeRoot: string;
  readonly #stagingRoot: string;
  readonly #template: string | undefined;
  readonly #roleUser: string;
  readonly #piAgentDirectory: string;
  readonly #piAuthFile: string | undefined;
  readonly #sbx: string;
  readonly #git: string;

  constructor(options: DockerSandboxWorkspaceOptions) {
    this.#commands = options.commands;
    this.#bridgeRoot = path.resolve(options.bridgeRoot);
    this.#stagingRoot = path.resolve(options.stagingRoot);
    this.#template = options.template;
    this.#roleUser = options.roleUser ?? "1000:1000";
    this.#piAgentDirectory = options.piAgentDirectory ?? "/ticket/runtime/pi-agent";
    this.#piAuthFile = options.piAuthFile ? path.resolve(options.piAuthFile) : undefined;
    this.#sbx = options.sbxExecutable ?? "sbx";
    this.#git = options.gitExecutable ?? "git";
  }

  async prepare(input: { readonly runId: string; readonly ticketId: string; readonly sandbox: string; readonly branch: string; readonly repositoryPath: string; readonly sourceRef: string }, signal?: AbortSignal): Promise<PreparedWorkspace> {
    validateName(input.runId, "run");
    validateName(input.sandbox, "sandbox");
    validateBranch(input.branch);
    const repositoryPath = path.resolve(input.repositoryPath);
    const runStaging = path.join(this.#stagingRoot, input.runId);
    const bridge = path.join(this.#bridgeRoot, input.runId);
    await rm(bridge, { recursive: true, force: true });
    await mkdir(bridge, { recursive: true, mode: 0o700 });
    await mkdir(runStaging, { recursive: true, mode: 0o700 });
    const sourceBundle = path.join(runStaging, "source.bundle");
    await rm(sourceBundle, { force: true });

    const baseSha = (await this.#commands.run({ command: this.#git, args: ["-C", repositoryPath, "rev-parse", "--verify", `${input.sourceRef}^{commit}`] }, signal)).stdout.trim();
    assertSha(baseSha);

    // A remote-tracking ref is not a reliable bundle head for `git clone`.
    // Pin the already-resolved commit behind a clone-visible temporary branch,
    // bundle that ref, and compare-delete it even when bundling fails. The
    // source ref is never reread after resolution, so movement during prepare
    // cannot change the sandbox base.
    const bundleRef = `refs/heads/squire-source-${input.runId}-${randomUUID().replaceAll("-", "")}`;
    let bundleRefCreated = false;
    try {
      // The UUID makes a collision unlikely and the zero old-value makes the
      // create compare-and-set safe for both SHA-1 and SHA-256 repositories.
      // Complete this tiny host-side mutation before observing cancellation:
      // if update-ref fails because a colliding ref already exists, ownership
      // was never established and cleanup must not delete that ref. If the
      // caller is cancelled while it runs, the following bundle command sees
      // the cancellation and the established ref is still cleaned up.
      await this.#commands.run({ command: this.#git, args: ["-C", repositoryPath, "update-ref", bundleRef, baseSha, "0".repeat(baseSha.length)] });
      bundleRefCreated = true;
      await this.#commands.run({ command: this.#git, args: ["-C", repositoryPath, "bundle", "create", sourceBundle, bundleRef], timeoutMs: 180_000 }, signal);
    } finally {
      // Cleanup is a host-side safety obligation and must still run after an
      // aborted caller signal, but only after this invocation established the
      // compare-and-set ref.
      if (bundleRefCreated) await this.#commands.run({ command: this.#git, args: ["-C", repositoryPath, "update-ref", "-d", bundleRef, baseSha] });
    }

    const createArgs = ["create", "--name", input.sandbox];
    if (this.#template) createArgs.push("--template", this.#template);
    createArgs.push("shell", bridge);
    await this.#commands.run({ command: this.#sbx, args: createArgs, timeoutMs: 180_000 }, signal);
    await this.#commands.run({ command: this.#sbx, args: ["cp", sourceBundle, `${input.sandbox}:/tmp/squire-source.bundle`], timeoutMs: 180_000 }, signal);

    const script = [
      "set -eu",
      "rm -rf /ticket",
      `mkdir -p /ticket/git /ticket/sessions /ticket/artifacts/inputs /ticket/artifacts/results /ticket/runtime/home /ticket/runtime/config /ticket/runtime/tmp ${sh(this.#piAgentDirectory)}`,
      "git clone /tmp/squire-source.bundle /ticket/workspace",
      `git -C /ticket/workspace checkout -b ${sh(input.branch)} ${sh(baseSha)}`,
      "git -C /ticket/workspace config user.name Squire",
      "git -C /ticket/workspace config user.email squire@localhost",
      `chown -R ${sh(this.#roleUser)} /ticket`,
      "chmod 0700 /ticket /ticket/workspace /ticket/sessions /ticket/artifacts /ticket/runtime",
    ].join("\n");
    await this.#commands.run({ command: this.#sbx, args: ["exec", "-u", "root", input.sandbox, "sh", "-lc", script], timeoutMs: 180_000 }, signal);
    // Keep repository-controlled Node/npm execution out of the privileged
    // setup command. The role user owns /ticket after the setup above, so a
    // declared ticket runtime is installed and validated with the same
    // pinned commands CI uses, without granting it sandbox-root privileges.
    const runtimeSetup = [
      "set -eu",
      // Only repositories that declare the pinned ticket runtime need the
      // additional installation. A normal configured checkout must remain
      // usable without Squire's repository-specific CI fixtures.
      // `-e` follows symlinks, so include `-L` in the declaration probe and
      // reject symlinked declarations below. A repository must not bypass the
      // pinned-runtime contract with a dangling or outside-tree link.
      "if [ -e /ticket/workspace/.github/runtime/package.json ] || [ -L /ticket/workspace/.github/runtime/package.json ] || [ -e /ticket/workspace/.github/runtime/package-lock.json ] || [ -L /ticket/workspace/.github/runtime/package-lock.json ] || [ -e /ticket/workspace/.github/validate-ticket-runtime.mjs ] || [ -L /ticket/workspace/.github/validate-ticket-runtime.mjs ]; then",
      "  test -f /ticket/workspace/.github/runtime/package.json && test ! -L /ticket/workspace/.github/runtime/package.json",
      "  test -f /ticket/workspace/.github/runtime/package-lock.json && test ! -L /ticket/workspace/.github/runtime/package-lock.json",
      "  test -f /ticket/workspace/.github/validate-ticket-runtime.mjs && test ! -L /ticket/workspace/.github/validate-ticket-runtime.mjs",
      "  cp /ticket/workspace/.github/runtime/package.json /ticket/runtime/package.json",
      "  cp /ticket/workspace/.github/runtime/package-lock.json /ticket/runtime/package-lock.json",
      "  npm ci --prefix /ticket/runtime --ignore-scripts --no-audit --no-fund",
      "  node /ticket/workspace/.github/validate-ticket-runtime.mjs",
      "fi",
    ].join("\n");
    await this.#commands.run({ command: this.#sbx, args: ["exec", "-u", this.#roleUser, input.sandbox, "sh", "-lc", runtimeSetup], timeoutMs: 180_000 }, signal);
    if (this.#piAuthFile) {
      await this.#commands.run({ command: this.#sbx, args: ["cp", this.#piAuthFile, `${input.sandbox}:${this.#piAgentDirectory}/auth.json`] }, signal);
      const secureAuth = `chown ${sh(this.#roleUser)} ${sh(`${this.#piAgentDirectory}/auth.json`)}; chmod 0600 ${sh(`${this.#piAgentDirectory}/auth.json`)}`;
      await this.#commands.run({ command: this.#sbx, args: ["exec", "-u", "root", input.sandbox, "sh", "-lc", secureAuth] }, signal);
    }
    const head = await this.currentHead(input.sandbox, signal);
    return { sandbox: input.sandbox, baseSha, head };
  }

  async currentHead(sandbox: string, signal?: AbortSignal): Promise<string> {
    validateName(sandbox, "sandbox");
    const result = await this.#commands.run({ command: this.#sbx, args: ["exec", sandbox, "git", "-C", "/ticket/workspace", "rev-parse", "HEAD"] }, signal);
    const head = result.stdout.trim();
    assertSha(head);
    return head;
  }

  async assertClean(sandbox: string, signal?: AbortSignal): Promise<void> {
    validateName(sandbox, "sandbox");
    const status = await this.#commands.run({ command: this.#sbx, args: ["exec", sandbox, "git", "-C", "/ticket/workspace", "status", "--porcelain"] }, signal);
    if (status.stdout.trim()) throw new Error("workspace has uncommitted changes");
  }

  async exportBundle(input: { readonly runId: string; readonly sandbox: string; readonly branch: string; readonly baseSha: string; readonly head: string }, signal?: AbortSignal): Promise<CandidateBundle> {
    validateName(input.runId, "run");
    validateName(input.sandbox, "sandbox");
    validateBranch(input.branch);
    assertSha(input.baseSha);
    assertSha(input.head);
    await this.assertClean(input.sandbox, signal);
    const observed = await this.currentHead(input.sandbox, signal);
    if (observed !== input.head) throw new Error("workspace HEAD changed before bundle export");
    await this.#commands.run({ command: this.#sbx, args: ["exec", input.sandbox, "git", "-C", "/ticket/workspace", "bundle", "create", "/ticket/artifacts/candidate.bundle", `refs/heads/${input.branch}`], timeoutMs: 180_000 }, signal);
    const destination = path.join(this.#stagingRoot, input.runId, "candidate.bundle");
    await rm(destination, { force: true });
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await this.#commands.run({ command: this.#sbx, args: ["cp", `${input.sandbox}:/ticket/artifacts/candidate.bundle`, destination], timeoutMs: 180_000 }, signal);
    const info = await stat(destination);
    if (!info.isFile() || info.size <= 0) throw new Error("candidate bundle was not exported");
    const sha256 = createHash("sha256").update(await readFile(destination)).digest("hex");
    return { path: destination, sha256, byteLength: info.size, baseSha: input.baseSha, head: input.head, branch: input.branch };
  }
}

function sh(value: string): string {
  if (value.includes("\0")) throw new Error("shell value contains NUL");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateName(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,127}$/u.test(value)) throw new Error(`invalid ${label} name`);
}

function validateBranch(value: string): void {
  if (!/^squire\/[a-z0-9][a-z0-9._/-]{1,127}$/u.test(value) || value.includes("..") || value.endsWith("/")) throw new Error("invalid feature branch");
}

function assertSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) throw new Error("invalid Git SHA");
}
