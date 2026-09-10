import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandPort } from "./command.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { PERSONAL_PHASES, type PersonalPhase, type PublicationInput, type PublicationPort, type PublicationResult, type RetroPhaseResult } from "./types.js";

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
  /** Bounded GitHub read-after-write convergence delay; tests may set zero. */
  readonly consistencyDelayMs?: number;
}

interface PullRequestRecord {
  readonly url: string;
  readonly number: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly headRepositoryOwner: string;
  readonly headRepository: string;
  readonly body: string;
}

/** Verifies locally, then supplies a short-lived token only to host git/gh publication commands. */
export class GitHubPublisher implements PublicationPort {
  readonly #commands: CommandPort;
  readonly #tokens: GitHubTokenProvider;
  readonly #git: string;
  readonly #gh: string;
  readonly #consistencyDelayMs: number;

  constructor(options: GitHubPublisherOptions) {
    this.#commands = options.commands;
    this.#tokens = options.tokens;
    this.#git = options.gitExecutable ?? "git";
    this.#gh = options.ghExecutable ?? "gh";
    this.#consistencyDelayMs = options.consistencyDelayMs ?? 500;
    if (!Number.isSafeInteger(this.#consistencyDelayMs) || this.#consistencyDelayMs < 0 || this.#consistencyDelayMs > 5_000) throw new Error("invalid GitHub consistency delay");
  }

  async publish(input: PublicationInput, signal?: AbortSignal): Promise<PublicationResult> {
    validatePublication(input);
    const bundleInfo = await lstat(input.bundle.path);
    if (!bundleInfo.isFile() || bundleInfo.size !== input.bundle.byteLength) throw new Error("candidate bundle size or file type mismatch");
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
        const remote = `https://github.com/${input.repository}.git`;
        const existing = await this.#findPullRequest(input, ghEnvironment, signal);
        if (existing) {
          // Validate and prepare the body before the first possible remote
          // mutation. A correction run must not advance a branch and only then
          // discover that an owner-edited PR body is ambiguous.
          const initialBody = await this.#prepareReconciledBody(checkout, input, existing, signal);
          let confirmed: PullRequestRecord;
          let body: string;
          if (existing.headRefOid !== input.head) {
            // The accepted candidate bundle is the only trusted source for a
            // prior PR head. Prove ancestry locally, then bind the remote
            // update to the exact observed head. This lease cannot overwrite
            // a concurrent branch change and the independent ancestry check
            // prevents using the lease as an unconditional force push.
            await this.#commands.run({ command: this.#git, args: ["-C", checkout, "cat-file", "-e", `${existing.headRefOid}^{commit}`] }, signal);
            await this.#commands.run({ command: this.#git, args: ["-C", checkout, "merge-base", "--is-ancestor", existing.headRefOid, input.head] }, signal);
            await this.#commands.run({ command: this.#git, args: ["-C", checkout, "push", `--force-with-lease=refs/heads/${input.branch}:${existing.headRefOid}`, remote, `${input.head}:refs/heads/${input.branch}`], env: gitEnvironment, timeoutMs: 180_000, sensitive: true }, signal);
            const refreshed = await this.#waitForHead(input, existing, input.head, ghEnvironment, signal);
            confirmed = refreshed;
            body = initialBody;
          } else {
            const refreshed = await this.#findPullRequest(input, ghEnvironment, signal);
            if (!samePullRequest(existing, refreshed) || refreshed.headRefOid !== input.head || refreshed.body !== existing.body) throw new Error("matching pull request changed before body reconciliation");
            confirmed = refreshed;
            body = initialBody;
          }
          await this.#editPullRequestBody(input, confirmed.number, body, temporary, ghEnvironment, signal);
          const verified = await this.#waitForBody(input, confirmed, body, ghEnvironment, signal);
          return { url: verified.url, number: verified.number, reused: true };
        }

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
          const url = created.stdout.trim().split(/\s+/u).find(value => pullRequestNumber(value, input.repository) !== undefined);
          const number = url === undefined ? undefined : pullRequestNumber(url, input.repository);
          if (!url || number === undefined) throw new Error("gh did not return a pull-request URL");
          return { url, number, reused: false };
        } catch (error) {
          const reconciled = await this.#findPullRequest(input, ghEnvironment, signal);
          if (reconciled?.headRefOid === input.head) {
            const body = await this.#prepareReconciledBody(checkout, input, reconciled, signal);
            await this.#editPullRequestBody(input, reconciled.number, body, temporary, ghEnvironment, signal);
            const verified = await this.#waitForBody(input, reconciled, body, ghEnvironment, signal);
            return { url: verified.url, number: verified.number, reused: true };
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

  async #prepareReconciledBody(checkout: string, input: PublicationInput, pullRequest: PullRequestRecord, signal?: AbortSignal): Promise<string> {
    const validatedHead = pullRequestValidatedHead(pullRequest.body);
    const reconciled = reconcilePullRequestBody(pullRequest.body, input, validatedHead);
    if (validatedHead !== pullRequest.headRefOid) {
      try {
        await this.#commands.run({ command: this.#git, args: ["-C", checkout, "cat-file", "-e", `${validatedHead}^{commit}`] }, signal);
        await this.#commands.run({ command: this.#git, args: ["-C", checkout, "merge-base", "--is-ancestor", validatedHead, pullRequest.headRefOid] }, signal);
      } catch {
        throw new Error("matching pull request has an unexpected Squire body");
      }
    }
    return reconciled;
  }

  async #waitForHead(input: PublicationInput, previous: PullRequestRecord, expectedHead: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<PullRequestRecord> {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const current = await this.#findPullRequest(input, environment, signal);
      if (!samePullRequest(previous, current) || current.body !== previous.body) throw new Error("matching pull request changed during fast-forward publication");
      if (current.headRefOid === expectedHead) return current;
      if (current.headRefOid !== previous.headRefOid || attempt === 12) throw new Error("matching pull request changed during fast-forward publication");
      await delay(this.#consistencyDelayMs, undefined, { signal });
    }
    throw new Error("matching pull request changed during fast-forward publication");
  }

  async #waitForBody(input: PublicationInput, previous: PullRequestRecord, expectedBody: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<PullRequestRecord> {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const current = await this.#findPullRequest(input, environment, signal);
      if (!samePullRequest(previous, current) || current.headRefOid !== input.head) throw new Error("matching pull request changed during body reconciliation");
      if (current.body === expectedBody) return current;
      if (current.body !== previous.body || attempt === 12) throw new Error("matching pull request changed during body reconciliation");
      await delay(this.#consistencyDelayMs, undefined, { signal });
    }
    throw new Error("matching pull request changed during body reconciliation");
  }

  async #editPullRequestBody(
    input: PublicationInput,
    number: number,
    body: string,
    temporary: string,
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<void> {
    const bodyPath = path.join(temporary, "pull-request-reconciled.md");
    await writeFile(bodyPath, body, { mode: 0o600 });
    await this.#commands.run({
      command: this.#gh,
      args: ["pr", "edit", String(number), "--repo", input.repository, "--body-file", bodyPath],
      env: environment,
      timeoutMs: 120_000,
      sensitive: true,
    }, signal);
  }

  async #findPullRequest(input: PublicationInput, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<PullRequestRecord | undefined> {
    const listed = await this.#commands.run({
      command: this.#gh,
      args: ["pr", "list", "--repo", input.repository, "--state", "open", "--base", input.baseBranch, "--head", input.branch, "--json", "url,number,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository,body"],
      env: environment,
      maxOutputBytes: 2 * 1024 * 1024,
      sensitive: true,
    }, signal);
    let values: unknown;
    try { values = JSON.parse(listed.stdout); } catch { throw new Error("gh returned malformed pull-request JSON"); }
    if (!Array.isArray(values)) throw new Error("gh returned malformed pull-request list");
    if (values.length > 1) throw new Error("multiple matching pull requests require owner intervention");
    if (values.length === 0) return undefined;
    return parsePullRequestRecord(values[0], input);
  }
}

function samePullRequest(expected: PullRequestRecord, actual: PullRequestRecord | undefined): actual is PullRequestRecord {
  return actual !== undefined
    && actual.url === expected.url
    && actual.number === expected.number
    && actual.baseRefName === expected.baseRefName
    && actual.headRefName === expected.headRefName
    && sameRepository(actual.headRepositoryOwner, expected.headRepositoryOwner)
    && sameRepository(actual.headRepository, expected.headRepository);
}

function publicationEnvironment(additions: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...additions };
}

function parsePullRequestRecord(value: unknown, input: PublicationInput): PullRequestRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("matching pull request has an unexpected identity or body");
  const object = value as Record<string, unknown>;
  const url = object["url"];
  const number = object["number"];
  const baseRefName = object["baseRefName"];
  const headRefName = object["headRefName"];
  const headRefOid = object["headRefOid"];
  const body = object["body"];
  const headRepositoryOwner = pullRequestOwner(object["headRepositoryOwner"]);
  const headRepository = pullRequestRepository(object["headRepository"], headRepositoryOwner);
  if (
    typeof url !== "string"
    || !Number.isSafeInteger(number) || (number as number) < 1
    || typeof baseRefName !== "string"
    || typeof headRefName !== "string"
    || typeof headRefOid !== "string" || !/^[a-f0-9]{40,64}$/u.test(headRefOid)
    || typeof body !== "string" || body.length > 1_900_000
    || !headRepositoryOwner
    || !headRepository
    || pullRequestNumber(url, input.repository) !== number
    || baseRefName !== input.baseBranch
    || headRefName !== input.branch
    || !sameRepository(headRepository, input.repository)
    || !sameRepository(`${headRepositoryOwner}/${repositoryName(input.repository)}`, input.repository)
  ) throw new Error("matching pull request has an unexpected identity or body");
  return {
    url,
    number: number as number,
    baseRefName,
    headRefName,
    headRefOid,
    headRepositoryOwner,
    headRepository,
    body,
  };
}

function pullRequestOwner(value: unknown): string | undefined {
  if (typeof value === "string" && /^[A-Za-z0-9_.-]+$/u.test(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const login = object["login"] ?? object["name"];
  return typeof login === "string" && /^[A-Za-z0-9_.-]+$/u.test(login) ? login : undefined;
}

function pullRequestRepository(value: unknown, separateOwner?: string): string | undefined {
  if (typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const nameWithOwner = object["nameWithOwner"];
  if (typeof nameWithOwner === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(nameWithOwner)) return nameWithOwner;
  const name = object["name"];
  const owner = pullRequestOwner(object["owner"]) ?? separateOwner;
  return typeof name === "string" && /^[A-Za-z0-9_.-]+$/u.test(name) && owner ? `${owner}/${name}` : undefined;
}

function pullRequestNumber(value: string, repository: string): number | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) return undefined;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/u.exec(url.pathname);
  if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) return undefined;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function repositoryName(repository: string): string {
  return repository.slice(repository.indexOf("/") + 1);
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
    `- Plan: ${markdownInline(input.phases.plan.summary)}`,
    `- Implement: ${markdownInline(input.phases.implement.summary)}`,
    `- Review: ${markdownInline(input.phases.review.summary)}`,
    `- Test: ${markdownInline(input.phases.test.summary)}`,
    `- Retro: ${markdownInline(input.phases.retro.summary)}`,
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

function pullRequestValidatedHead(body: string): string {
  if (body.length > 1_900_000) throw new Error("matching pull request has an unexpected Squire body");
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const index = uniqueLineIndex(lines, /^Validated head: `[a-f0-9]{40,64}`$/u);
  const match = index === undefined ? undefined : /^Validated head: `([a-f0-9]{40,64})`$/u.exec(lines[index] ?? "");
  if (!match) throw new Error("matching pull request has an unexpected Squire body");
  return match[1]!;
}

function reconcilePullRequestBody(body: string, input: PublicationInput, expectedValidatedHead: string): string {
  if (body.length > 1_900_000) throw new Error("matching pull request has an unexpected Squire body");
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const invalidBody = (): never => { throw new Error("matching pull request has an unexpected Squire body"); };
  const ticketIndex = uniqueLineIndex(lines, `## ${input.ticket.id}`) ?? invalidBody();
  const validatedIndex = uniqueLineIndex(lines, /^Validated head: `[a-f0-9]{40,64}`$/u) ?? invalidBody();
  const validatedMatch = /^Validated head: `([a-f0-9]{40,64})`$/u.exec(lines[validatedIndex] ?? "");
  if (!validatedMatch || validatedMatch[1] !== expectedValidatedHead) return invalidBody();
  const squireHeadings = lines.flatMap((line, index) => /^##\s+Squire phases\s*$/u.test(line) ? [index] : []);
  const retroHeadings = lines.flatMap((line, index) => /^##\s+Retro\s*$/iu.test(line) ? [index] : []);
  const squireIndex = squireHeadings.length === 1 ? squireHeadings[0] : undefined;
  if (squireIndex === undefined || retroHeadings.length !== 1 || retroHeadings[0]! <= squireIndex || validatedIndex >= squireIndex || ticketIndex >= squireIndex) return invalidBody();
  const nextHeading = lines.findIndex((line, index) => index > squireIndex && /^##\s+/u.test(line));
  const phaseEnd = nextHeading === -1 ? lines.length : nextHeading;
  for (const phase of PERSONAL_PHASES) {
    const matches = lines.flatMap((line, index) => index > squireIndex && index < phaseEnd && new RegExp(`^- ${capitalize(phase)}: .+$`, "u").test(line) ? [index] : []);
    if (matches.length !== 1) return invalidBody();
    lines[matches[0]!] = `- ${capitalize(phase)}: ${markdownInline(input.phases[phase].summary)}`;
  }
  lines[validatedIndex] = `Validated head: \`${input.head}\``;
  return reconcileRetroSection(lines.join("\n"), retroSection(input));
}

function uniqueLineIndex(lines: readonly string[], expected: string | RegExp): number | undefined {
  const matches = lines.flatMap((line, index) => (typeof expected === "string" ? line === expected : expected.test(line)) ? [index] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

function markdownInline(value: string): string {
  return value.replaceAll("\r\n", " ").replaceAll("\r", " ").replaceAll("\n", " ");
}

function capitalize(value: PersonalPhase): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
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
  if (!/^[A-Za-z0-9._/-]+$/u.test(input.baseBranch) || input.baseBranch.includes("..") || input.baseBranch.startsWith("/") || input.baseBranch.endsWith("/")) throw new Error("invalid publication base branch");
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(input.ticket.id)) throw new Error("invalid publication ticket");
  if (!/^squire\/[a-z0-9][a-z0-9._/-]{1,127}$/u.test(input.branch) || input.branch.includes("..")) throw new Error("invalid publication branch");
  if (!/^[a-f0-9]{40,64}$/u.test(input.head) || input.bundle.head !== input.head || input.bundle.branch !== input.branch) throw new Error("invalid publication identity");
  if (typeof input.bundle.path !== "string" || input.bundle.path.length === 0 || !path.isAbsolute(input.bundle.path)) throw new Error("invalid candidate bundle path");
  if (!/^[a-f0-9]{64}$/u.test(input.bundle.sha256)) throw new Error("invalid candidate bundle digest");
  if (!Number.isSafeInteger(input.bundle.byteLength) || input.bundle.byteLength <= 0) throw new Error("invalid candidate bundle size");
  if (!/^[a-f0-9]{40,64}$/u.test(input.bundle.baseSha)) throw new Error("candidate bundle base SHA is invalid");
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
