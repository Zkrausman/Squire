import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InMemoryWorkflowStore } from "./in-memory-workflow-store.js";
import { run } from "./fixtures.js";
import { GitWorkspaceService, type GitSourceAuthorization } from "../../src/git/workspace-service.js";
import type { GitWorkspaceSpecInput } from "../../src/git/domain.js";
import type { TrustedFilesystemIsolationCapability } from "../../src/git/trusted-isolation.js";

const exec = promisify(execFile);

export interface GitFixture {
  readonly root: string;
  readonly source: string;
  readonly ticketRoot: string;
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly git: (...args: string[]) => Promise<string>;
  readonly store: InMemoryWorkflowStore;
  readonly service: GitWorkspaceService;
  /** Test-only adapter; production receives this from AIDEV-223. */
  readonly filesystemIsolation: TrustedFilesystemIsolationCapability;
  readonly input: GitWorkspaceSpecInput;
  readonly cleanup: () => Promise<void>;
}

export async function createGitFixture(options: { readonly runId?: string; readonly objectFormat?: "sha1" | "sha256"; readonly workflowState?: "accepted" | "publishing"; readonly maliciousSourceMetadata?: boolean } = {}): Promise<GitFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-workspace-"));
  const source = path.join(root, "source");
  const ticketRoot = path.join(root, "ticket");
  await mkdir(source, { recursive: false, mode: 0o700 });
  await mkdir(ticketRoot, { recursive: false, mode: 0o700 });
  const sourceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost.invalid",
  };
  const git = async (...args: string[]): Promise<string> => {
    const result = await exec("git", args, { cwd: source, env: sourceEnv });
    return result.stdout.trim();
  };
  const objectFormat = options.objectFormat ?? "sha1";
  await git("init", "--initial-branch=main", `--object-format=${objectFormat}`);
  await writeFile(path.join(source, "README.md"), "fixture base\n");
  await git("add", ".");
  await git("commit", "-m", "fixture base");
  if (options.maliciousSourceMetadata) {
    await writeFile(path.join(source, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(path.join(source, ".gitmodules"), `[submodule "evil"]
\tpath = evil
\turl = file:///outside/untrusted
`);
    await git("add", ".gitattributes", ".gitmodules");
    await git("commit", "-m", "untrusted repository metadata");
    const sourceHook = path.join(source, ".git", "hooks", "pre-commit");
    await writeFile(sourceHook, "#!/bin/sh\nprintf source-hook-ran > /tmp/squire-source-hook-sentinel\n");
    await (await import("node:fs/promises")).chmod(sourceHook, 0o700);
    await git("config", "filter.evil.clean", "sh -c 'printf external-filter > /tmp/squire-filter-sentinel; cat'");
    await git("config", "filter.evil.smudge", "cat");
  }
  const baseSha = await git("rev-parse", "HEAD");
  const runId = options.runId ?? "run_example01";
  const store = new InMemoryWorkflowStore();
  await store.create(run({ runId, state: options.workflowState ?? "accepted", currentHead: "a".repeat(objectFormat === "sha1" ? 40 : 64) }));
  const sourceAuthorizer = {
    authorize: async (): Promise<GitSourceAuthorization> => ({ cloneUrl: source, localTransport: true }),
  };
  const filesystemIsolation = { assertTicketRoot: async (): Promise<void> => undefined } as unknown as TrustedFilesystemIsolationCapability;
  const service = new GitWorkspaceService({ store, ticketRoot, filesystemIsolation, allowLocalTransport: true, requirePublishingGates: false, sourceAuthorizer });
  const input: GitWorkspaceSpecInput = {
    runId,
    ticketIdentifier: "AIDEV-222",
    repository: { owner: "example", name: "service", cloneUrl: "https://github.com/example/service.git" },
    baseBranch: "main",
    baseSha,
    objectFormat,
  };
  return {
    root,
    source,
    ticketRoot,
    sourceEnv,
    git,
    store,
    service,
    filesystemIsolation,
    input,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
