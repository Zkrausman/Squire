import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandPort } from "./command.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { PERSONAL_PHASES, type PublicationInput, type PublicationPort, type PublicationResult, type RetroPhaseResult } from "./types.js";

export interface GitHubTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
}

export interface CommandGitHubTokenProviderOptions {
  readonly commands: CommandPort;
  readonly command: string;
  readonly args?: readonly string[];
}

/** Runs a host-side helper that prints one short-lived installation token. */
export class CommandGitHubTokenProvider implements GitHubTokenProvider {
  readonly #commands: CommandPort;
  readonly #command: string;
  readonly #args: readonly string[];

  constructor(options: CommandGitHubTokenProviderOptions) {
    if (!options.command.trim()) throw new Error("GitHub token command is required");
    this.#commands = options.commands;
    this.#command = options.command;
    this.#args = options.args ?? [];
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    const result = await this.#commands.run({ command: this.#command, args: this.#args, maxOutputBytes: 8_192, sensitive: true }, signal);
    const token = result.stdout.trim();
    if (!/^[A-Za-z0-9_.-]{20,512}$/u.test(token)) throw new Error("GitHub token command returned an invalid token");
    return token;
  }
}

export interface GitHubPublisherOptions {
  readonly commands: CommandPort;
  readonly tokens: GitHubTokenProvider;
  readonly gitExecutable?: string;
  readonly ghExecutable?: string;
}

/** Verifies locally, then supplies a short-lived token only to host git/gh publication commands. */
export class GitHubPublisher implements PublicationPort {
  readonly #commands: CommandPort;
  readonly #tokens: GitHubTokenProvider;
  readonly #git: string;
  readonly #gh: string;

  constructor(options: GitHubPublisherOptions) {
    this.#commands = options.commands;
    this.#tokens = options.tokens;
    this.#git = options.gitExecutable ?? "git";
    this.#gh = options.ghExecutable ?? "gh";
  }

  async publish(input: PublicationInput, signal?: AbortSignal): Promise<PublicationResult> {
    validatePublication(input);
    const actualDigest = await sha256File(input.bundle.path);
    if (actualDigest !== input.bundle.sha256) throw new Error("candidate bundle digest mismatch");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "squire-publish-"));
    const checkout = path.join(temporary, "repository");
    try {
      await this.#commands.run({ command: this.#git, args: ["clone", input.bundle.path, checkout], timeoutMs: 180_000 }, signal);
      await this.#commands.run({ command: this.#git, args: ["-C", checkout, "bundle", "verify", input.bundle.path] }, signal);
      const bundledHead = (await this.#commands.run({ command: this.#git, args: ["-C", checkout, "rev-parse", `refs/remotes/origin/${input.branch}^{commit}`] }, signal)).stdout.trim();
      if (bundledHead !== input.head) throw new Error("bundle feature branch does not match the accepted HEAD");
      await this.#commands.run({ command: this.#git, args: ["-C", checkout, "cat-file", "-e", `${input.bundle.baseSha}^{commit}`] }, signal);
      await this.#commands.run({ command: this.#git, args: ["-C", checkout, "merge-base", "--is-ancestor", input.bundle.baseSha, input.head] }, signal);

      let token = await this.#tokens.getToken(signal);
      const ghEnvironment = publicationEnvironment({ GH_TOKEN: token, GH_PROMPT_DISABLED: "1" });
      const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
      const gitEnvironment = publicationEnvironment({
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
      });
      try {
        const existing = await this.#findPullRequest(input, ghEnvironment, signal);
        if (existing) {
          await this.#reconcilePullRequestBody(input, existing, temporary, ghEnvironment, signal);
          return { url: existing.url, number: existing.number, reused: true };
        }

        const remote = `https://github.com/${input.repository}.git`;
        await this.#commands.run({ command: this.#git, args: ["-C", checkout, "push", remote, `${input.head}:refs/heads/${input.branch}`], env: gitEnvironment, timeoutMs: 180_000, sensitive: true }, signal);
        const bodyPath = path.join(temporary, "pull-request.md");
        await writeFile(bodyPath, pullRequestBody(input), { mode: 0o600 });
        try {
          const created = await this.#commands.run({
            command: this.#gh,
            args: ["pr", "create", "--repo", input.repository, "--base", input.baseBranch, "--head", input.branch, "--title", `${input.ticket.id}: ${input.ticket.title}`, "--body-file", bodyPath],
            env: ghEnvironment,
            timeoutMs: 120_000,
            sensitive: true,
          }, signal);
          const url = created.stdout.trim().split(/\s+/u).find(value => /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/u.test(value));
          if (!url) throw new Error("gh did not return a pull-request URL");
          return { url, reused: false };
        } catch (error) {
          const reconciled = await this.#findPullRequest(input, ghEnvironment, signal);
          if (reconciled) {
            await this.#reconcilePullRequestBody(input, reconciled, temporary, ghEnvironment, signal);
            return { url: reconciled.url, number: reconciled.number, reused: true };
          }
          throw error;
        }
      } finally {
        token = "";
        ghEnvironment["GH_TOKEN"] = "";
        gitEnvironment["GIT_CONFIG_VALUE_0"] = "";
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #reconcilePullRequestBody(
    input: PublicationInput,
    pullRequest: { readonly url: string; readonly number: number; readonly body: string },
    temporary: string,
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<void> {
    const bodyPath = path.join(temporary, "pull-request-reconciled.md");
    await writeFile(bodyPath, reconcileRetroSection(pullRequest.body, retroSection(input)), { mode: 0o600 });
    await this.#commands.run({
      command: this.#gh,
      args: ["pr", "edit", String(pullRequest.number), "--repo", input.repository, "--body-file", bodyPath],
      env: environment,
      timeoutMs: 120_000,
      sensitive: true,
    }, signal);
  }

  async #findPullRequest(input: PublicationInput, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ url: string; number: number; body: string } | undefined> {
    const listed = await this.#commands.run({
      command: this.#gh,
      args: ["pr", "list", "--repo", input.repository, "--state", "open", "--base", input.baseBranch, "--head", input.branch, "--json", "url,number,headRefOid,body"],
      env: environment,
      sensitive: true,
    }, signal);
    let values: unknown;
    try { values = JSON.parse(listed.stdout); } catch { throw new Error("gh returned malformed pull-request JSON"); }
    if (!Array.isArray(values)) throw new Error("gh returned malformed pull-request list");
    if (values.length > 1) throw new Error("multiple matching pull requests require owner intervention");
    if (values.length === 0) return undefined;
    const value = values[0] as Record<string, unknown>;
    if (value["headRefOid"] !== input.head || typeof value["url"] !== "string" || typeof value["number"] !== "number" || typeof value["body"] !== "string") throw new Error("matching pull request has an unexpected identity or body");
    return { url: value["url"], number: value["number"], body: value["body"] };
  }
}

function publicationEnvironment(additions: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...additions };
}

function pullRequestBody(input: PublicationInput): string {
  return [
    `## ${input.ticket.id}`,
    "",
    input.ticket.url ? `[Linear ticket](${input.ticket.url})` : input.ticket.title,
    "",
    `Validated head: \`${input.head}\``,
    "",
    "## Squire phases",
    "",
    `- Plan: ${input.phases.plan.summary}`,
    `- Implement: ${input.phases.implement.summary}`,
    `- Review: ${input.phases.review.summary}`,
    `- Test: ${input.phases.test.summary}`,
    `- Retro: ${input.phases.retro.summary}`,
    "",
    "> Squire does not merge pull requests. The owner retains the final decision.",
    "",
    retroSection(input),
  ].join("\n");
}

function retroSection(input: PublicationInput): string {
  const retro = input.phases.retro as RetroPhaseResult;
  const followUps = retro.details.followUps.length > 0
    ? retro.details.followUps.map(item => `- [ ] ${markdownListItem(item)}`)
    : ["No follow-ups proposed."];
  return [
    "## Retro",
    "",
    "### Lessons",
    ...retro.details.lessons.map(item => `- ${markdownListItem(item)}`),
    "",
    "### Proposed follow-ups",
    ...followUps,
    "",
  ].join("\n");
}

function markdownListItem(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\n  ");
}

function reconcileRetroSection(body: string, section: string): string {
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s+Retro\s*$/iu.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^##\s+/u.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  const withoutRetro = kept.join("\n").trimEnd();
  return `${withoutRetro ? `${withoutRetro}\n\n` : ""}${section.trimEnd()}\n`;
}

function validatePublication(input: PublicationInput): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)) throw new Error("invalid GitHub repository");
  if (!/^squire\/[a-z0-9][a-z0-9._/-]{1,127}$/u.test(input.branch) || input.branch.includes("..")) throw new Error("invalid publication branch");
  if (!/^[a-f0-9]{40,64}$/u.test(input.head) || input.bundle.head !== input.head || input.bundle.branch !== input.branch) throw new Error("invalid publication identity");
  for (const phase of PERSONAL_PHASES) {
    const result = input.phases[phase];
    validatePhaseResultShape(result, phase);
    if (result.runId !== input.runId || result.phase !== phase || result.status !== "passed") throw new Error("publication requires passing phase results for this run");
  }
  const review = input.phases.review;
  const test = input.phases.test;
  const retro = input.phases.retro;
  if (review.inputHead !== input.head || review.outputHead !== input.head || test.inputHead !== input.head || test.outputHead !== input.head || retro.inputHead !== input.head || retro.outputHead !== input.head) throw new Error("publication requires fresh passing Review, Test, and Retro");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
