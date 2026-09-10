import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandPort, CommandRequest, CommandResult } from "../src/personal/command.js";
import { CommandGitHubTokenProvider, GitHubPublisher, type GitHubTokenProvider } from "../src/personal/github-publisher.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import type { PersonalPhase, PhaseResult, PublicationInput } from "../src/personal/types.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TOKEN = `ghs_${"x".repeat(40)}`;
const BRANCH = deterministicFeatureBranch("example/repo", "AIDEV-1");

class FakeCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  readonly writtenBodies: string[] = [];
  listCalls = 0;
  constructor(readonly behavior: "existing" | "create" | "ambiguous") {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push({ ...request, args: [...request.args], ...(request.env ? { env: { ...request.env } } : {}) });
    if (request.command === "git" && request.args.includes("rev-parse")) return { stdout: `${HEAD}\n`, stderr: "" };
    if (request.command === "gh" && request.args[1] === "list") {
      this.listCalls += 1;
      const exists = this.behavior === "existing" || (this.behavior === "ambiguous" && this.listCalls > 1);
      return { stdout: exists ? JSON.stringify([{ url: "https://github.com/example/repo/pull/7", number: 7, headRefOid: HEAD, body: "Owner notes\n\n## Retro\n\n- old\n\n## Retro\n\n- duplicate\n" }]) : "[]", stderr: "" };
    }
    if (request.command === "gh" && (request.args[1] === "create" || request.args[1] === "edit")) {
      const bodyFile = request.args[request.args.indexOf("--body-file") + 1];
      if (bodyFile) this.writtenBodies.push(await readFile(bodyFile, "utf8"));
    }
    if (request.command === "gh" && request.args[1] === "create") {
      if (this.behavior === "ambiguous") throw new Error("response lost");
      return { stdout: "https://github.com/example/repo/pull/8\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

const tokens: GitHubTokenProvider = { async getToken() { return TOKEN; } };

function result(phase: PersonalPhase): PhaseResult {
  const common = { runId: "aidev-1-run", attempt: 1, sessionId: phase, sessionFile: `/ticket/sessions/${phase}/1.jsonl`, inputHead: phase === "plan" || phase === "implement" ? BASE : HEAD, outputHead: phase === "plan" ? BASE : HEAD, status: "passed" as const, summary: `${phase} passed` };
  if (phase === "plan") return { ...common, phase, details: { steps: ["make change"] } };
  if (phase === "implement") return { ...common, phase, details: { changes: ["made change"] } };
  if (phase === "review") return { ...common, phase, details: { findings: [] } };
  if (phase === "test") return { ...common, phase, details: { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] } };
  return { ...common, phase, details: { lessons: ["Keep phase isolation explicit"], followUps: ["Document the next proof run"] } };
}

async function input(directory: string): Promise<PublicationInput> {
  const bundle = path.join(directory, "candidate.bundle");
  const bytes = Buffer.from("test bundle bytes");
  await writeFile(bundle, bytes);
  return {
    runId: "aidev-1-run",
    ticket: { id: "AIDEV-1", title: "Small change", description: "Make one change" },
    repository: "example/repo",
    baseBranch: "main",
    branch: BRANCH,
    head: HEAD,
    bundle: { path: bundle, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, baseSha: BASE, head: HEAD, branch: BRANCH },
    phases: { plan: result("plan"), implement: result("implement"), review: result("review"), test: result("test"), retro: result("retro") },
  };
}

function assertTokenScope(requests: readonly CommandRequest[]): void {
  const publication = requests.filter(request => request.command === "gh" || request.args.includes("push"));
  assert.ok(publication.length > 0);
  for (const request of publication) {
    assert.equal(request.sensitive, true);
    assert.equal(request.args.some(argument => argument.includes(TOKEN)), false);
    const carriesToken = request.env?.["GH_TOKEN"] === TOKEN || request.env?.["GIT_CONFIG_VALUE_0"]?.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    assert.equal(carriesToken, true);
  }
  for (const request of requests.filter(request => !publication.includes(request))) {
    assert.equal(request.env?.["GH_TOKEN"], undefined);
    assert.equal(request.env?.["GIT_CONFIG_VALUE_0"], undefined);
  }
}

test("publisher reuses one exact existing PR without pushing or merging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const commands = new FakeCommands("existing");
    const published = await new GitHubPublisher({ commands, tokens }).publish(await input(directory));
    assert.equal(published.reused, true);
    assert.equal(published.number, 7);
    assert.equal(commands.requests.some(request => request.args.includes("push")), false);
    assert.equal(commands.requests.some(request => request.args.includes("merge")), false);
    assert.equal(commands.requests.filter(request => request.command === "gh" && request.args[1] === "edit").length, 1);
    assert.equal(commands.writtenBodies[0]?.match(/^## Retro$/gmu)?.length, 1);
    assert.match(commands.writtenBodies[0] ?? "", /- Keep phase isolation explicit/);
    assert.match(commands.writtenBodies[0] ?? "", /- \[ \] Document the next proof run/);
    assertTokenScope(commands.requests);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher scopes its token to exact git and gh publication commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const commands = new FakeCommands("create");
    const published = await new GitHubPublisher({ commands, tokens }).publish(await input(directory));
    assert.equal(published.reused, false);
    assert.equal(published.url, "https://github.com/example/repo/pull/8");
    const push = commands.requests.find(request => request.args.includes("push"));
    assert.ok(push?.args.includes(`${HEAD}:refs/heads/${BRANCH}`));
    assert.equal(commands.requests.some(request => request.args.includes("merge")), false);
    assert.equal(commands.writtenBodies[0]?.match(/^## Retro$/gmu)?.length, 1);
    assert.match(commands.writtenBodies[0] ?? "", /- \[ \] Document the next proof run/);
    assertTokenScope(commands.requests);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ambiguous create failure re-queries and reuses the exact PR", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const commands = new FakeCommands("ambiguous");
    const published = await new GitHubPublisher({ commands, tokens }).publish(await input(directory));
    assert.equal(published.reused, true);
    assert.equal(published.number, 7);
    assert.equal(commands.listCalls, 2);
    assert.equal(commands.requests.filter(request => request.command === "gh" && request.args[1] === "create").length, 1);
    assert.equal(commands.requests.filter(request => request.command === "gh" && request.args[1] === "edit").length, 1);
    assert.equal(commands.writtenBodies.at(-1)?.match(/^## Retro$/gmu)?.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher rejects missing, failed, or stale Retro before any command", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    for (const [name, mutate] of [
      ["missing", (value: PublicationInput) => ({ ...value, phases: { ...value.phases, retro: undefined } })],
      ["failed", (value: PublicationInput) => ({ ...value, phases: { ...value.phases, retro: { ...value.phases.retro, status: "failed" } } })],
      ["stale", (value: PublicationInput) => ({ ...value, phases: { ...value.phases, retro: { ...value.phases.retro, inputHead: BASE } } })],
    ] as const) {
      await t.test(name, async () => {
        const commands = new FakeCommands("create");
        const invalid = mutate(await input(directory)) as PublicationInput;
        await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(invalid), /phase result|passing phase|fresh passing/);
        assert.equal(commands.requests.length, 0);
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("command token provider uses a sensitive host-only command", async () => {
  const requests: CommandRequest[] = [];
  const commands: CommandPort = { async run(request) { requests.push(request); return { stdout: `${TOKEN}\n`, stderr: "" }; } };
  const provider = new CommandGitHubTokenProvider({ commands, command: "token-helper", args: ["--installation", "123"] });
  assert.equal(await provider.getToken(), TOKEN);
  assert.deepEqual(requests[0]?.args, ["--installation", "123"]);
  assert.equal(requests[0]?.sensitive, true);
});
