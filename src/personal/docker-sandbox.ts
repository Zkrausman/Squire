import { createHash } from "node:crypto";
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

    const baseSha = (await this.#commands.run({ command: this.#git, args: ["-C", repositoryPath, "rev-parse", `${input.sourceRef}^{commit}`] }, signal)).stdout.trim();
    assertSha(baseSha);
    await this.#commands.run({ command: this.#git, args: ["-C", repositoryPath, "bundle", "create", sourceBundle, input.sourceRef], timeoutMs: 180_000 }, signal);

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
