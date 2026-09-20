import { NodeCommandRunner } from "../src/personal/command.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandPort, CommandRequest, CommandResult } from "../src/personal/command.js";
import { CommandGitHubTokenProvider, GitHubPublisher, type GitHubTokenProvider } from "../src/personal/github-publisher.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import type { ImplementPhaseResult, PersonalPhase, PhaseResult, PublicationInput } from "../src/personal/types.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PREVIOUS_HEAD = "c".repeat(40);
const CONCURRENT_HEAD = "d".repeat(40);
const TOKEN = `ghs_${"x".repeat(40)}`;
const BRANCH = deterministicFeatureBranch("example/repo", "AIDEV-1");

class FakeCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  readonly writtenBodies: string[] = [];
  listCalls = 0;
  currentBody: string | undefined;
  constructor(
    readonly behavior: "existing" | "create" | "ambiguous" | "fast-forward" | "eventual-head" | "stale-body" | "diverged" | "concurrent" | "exact-concurrent" | "multiple",
    readonly mutateRecord?: (record: Record<string, unknown>) => Record<string, unknown>,
  ) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push({ ...request, args: [...request.args], ...(request.env ? { env: { ...request.env } } : {}) });
    if (request.command === "git" && request.args.includes("ls-remote")) {
      const pushed = this.requests.some(item => item.args.includes("push"));
      const head = ["fast-forward", "eventual-head", "diverged", "concurrent"].includes(this.behavior) && !pushed ? PREVIOUS_HEAD : HEAD;
      return { stdout: (this.behavior === "create" || this.behavior === "ambiguous") && !pushed ? "" : `${head}\trefs/heads/${BRANCH}\n`, stderr: "" };
    }
    if (request.command === "git" && request.args.includes("rev-parse")) return { stdout: `${request.args.includes("refs/squire-publication/observed-head") && ["fast-forward", "eventual-head", "diverged", "concurrent"].includes(this.behavior) ? PREVIOUS_HEAD : HEAD}\n`, stderr: "" };
    if (request.command === "git" && request.args.includes("cat-file") && request.args.includes("-t")) return { stdout: "commit\n", stderr: "" };
    if (request.command === "git" && request.args.includes("cat-file") && request.args.some(argument => argument.startsWith("e".repeat(40)))) throw new Error("missing commit");
    if (request.command === "git" && request.args.includes("merge-base") && (this.behavior === "diverged" || (request.args.includes(HEAD) && request.args.includes(PREVIOUS_HEAD) && request.args.indexOf(HEAD) < request.args.indexOf(PREVIOUS_HEAD)))) throw new Error("not an ancestor");
    if (request.command === "gh" && request.args[1] === "list") {
      this.listCalls += 1;
      const exists = this.behavior !== "create" && (this.behavior !== "ambiguous" || this.listCalls > 2);
      const headRefOid = this.behavior === "fast-forward"
        ? (this.listCalls <= 2 ? PREVIOUS_HEAD : HEAD)
        : this.behavior === "eventual-head"
          ? (this.listCalls <= 3 ? PREVIOUS_HEAD : HEAD)
        : this.behavior === "concurrent"
          ? (this.listCalls === 1 ? PREVIOUS_HEAD : CONCURRENT_HEAD)
          : this.behavior === "exact-concurrent"
            ? (this.listCalls === 1 ? HEAD : CONCURRENT_HEAD)
          : this.behavior === "diverged"
            ? PREVIOUS_HEAD
            : HEAD;
      const validatedHead = this.behavior === "stale-body" ? PREVIOUS_HEAD : headRefOid;
      const body = [
        "## AIDEV-1",
        "",
        `Validated head: \`${validatedHead}\``,
        "",
        "## Squire phases",
        "",
        "- Plan: old plan",
        "- Implement: old implement",
        "- Review: old review",
        "- Test: old test",
        "- Retro: old retro",
        "",
        "Owner notes",
        "",
        "## Retro",
        "",
        "- old",
        "",
      ].join("\n");
      const currentBody = this.currentBody ?? body;
      if (this.currentBody === undefined) this.currentBody = currentBody;
      const record = this.mutateRecord?.({ url: "https://github.com/example/repo/pull/7", number: 7, baseRefName: "main", headRefName: BRANCH, headRefOid, headRepositoryOwner: { login: "example" }, headRepository: { name: "repo", nameWithOwner: "" }, body: currentBody }) ?? { url: "https://github.com/example/repo/pull/7", number: 7, baseRefName: "main", headRefName: BRANCH, headRefOid, headRepositoryOwner: { login: "example" }, headRepository: { name: "repo", nameWithOwner: "" }, body: currentBody };
      return { stdout: exists ? JSON.stringify(this.behavior === "multiple" ? [record, record] : [record]) : "[]", stderr: "" };
    }
    if (request.command === "gh" && (request.args[1] === "create" || request.args[1] === "edit")) {
      const bodyFile = request.args[request.args.indexOf("--body-file") + 1];
      if (bodyFile) {
        const written = await readFile(bodyFile, "utf8");
        this.writtenBodies.push(written);
        if (request.args[1] === "edit") this.currentBody = written;
      }
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
  if (phase === "implement") return { ...common, phase, details: { changes: ["made change"], projectWiki: { status: "not_required", reason: "the ticket adds no durable project knowledge" } } };
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
  const publication = requests.filter(request => request.command === "gh" || request.args.includes("push") || request.args.includes("fetch") || request.args.includes("ls-remote"));
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

test("publisher rejects inconsistent candidate bundle metadata before remote commands", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const original = await input(directory);
    for (const [name, bundle] of [
      ["size", { ...original.bundle, byteLength: original.bundle.byteLength + 1 }],
      ["digest", { ...original.bundle, sha256: "e".repeat(64) }],
      ["base", { ...original.bundle, baseSha: "not-a-sha" }],
    ] as const) {
      await t.test(name, async () => {
        const commands = new FakeCommands("create");
        await assert.rejects(new GitHubPublisher({ commands, tokens }).publish({ ...original, bundle }), /candidate bundle (size|digest|base SHA)/);
        assert.equal(commands.requests.length, 0);
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
    assert.equal(commands.writtenBodies[0]?.match(/^## Knowledge$/gmu)?.length, 1);
    assert.equal(commands.writtenBodies[0]?.match(/^## Retro$/gmu)?.length, 1);
    assert.match(commands.writtenBodies[0] ?? "", /- Disposition: not_required/);
    assert.match(commands.writtenBodies[0] ?? "", /- Reason: the ticket adds no durable project knowledge/);
    assert.match(commands.writtenBodies[0] ?? "", /- Keep phase isolation explicit/);
    assert.match(commands.writtenBodies[0] ?? "", /- \[ \] Document the next proof run/);
    assertTokenScope(commands.requests);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher recovers a provably stale body after a prior partial publication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const commands = new FakeCommands("stale-body");
    const published = await new GitHubPublisher({ commands, tokens }).publish(await input(directory));
    assert.equal(published.reused, true);
    assert.equal(commands.requests.some(request => request.args.includes("push")), false);
    assert.ok(commands.requests.some(request => request.args.includes("--is-ancestor") && request.args.includes(PREVIOUS_HEAD) && request.args.includes(HEAD)));
    assert.match(commands.writtenBodies.at(-1) ?? "", new RegExp("Validated head: `" + HEAD + "`"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher safely fast-forwards one existing PR before reconciling its body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const commands = new FakeCommands("fast-forward");
    const published = await new GitHubPublisher({ commands, tokens }).publish(await input(directory));
    assert.equal(published.reused, true);
    assert.equal(commands.listCalls, 4);
    const push = commands.requests.find(request => request.args.includes("push"));
    assert.ok(push?.args.includes(`${HEAD}:refs/heads/${BRANCH}`));
    assert.ok(push?.args.includes(`--force-with-lease=refs/heads/${BRANCH}:${PREVIOUS_HEAD}`));
    assert.equal(push?.args.includes("--force"), false);
    assert.ok(commands.requests.some(request => request.args.includes("--is-ancestor") && request.args.includes(PREVIOUS_HEAD) && request.args.includes(HEAD)));
    assert.equal(commands.requests.filter(request => request.command === "gh" && request.args[1] === "edit").length, 1);
    assert.equal(commands.writtenBodies.at(-1)?.match(/^## Retro$/gmu)?.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher tolerates bounded stale GitHub reads after a leased fast-forward", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const commands = new FakeCommands("eventual-head");
    const published = await new GitHubPublisher({ commands, tokens, consistencyDelayMs: 0 }).publish(await input(directory));
    assert.equal(published.reused, true);
    assert.equal(commands.listCalls, 5);
    assert.equal(commands.requests.filter(request => request.args.includes("push")).length, 1);
    assert.equal(commands.requests.filter(request => request.command === "gh" && request.args[1] === "edit").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher rejects divergent or concurrently changed existing PR heads", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    await t.test("diverged", async () => {
      const commands = new FakeCommands("diverged");
      await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(await input(directory)), /not an ancestor/);
      assert.equal(commands.requests.some(request => request.args.includes("push")), false);
    });
    await t.test("concurrent fast-forward", async () => {
      const commands = new FakeCommands("concurrent");
      await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(await input(directory)), /changed before publication/);
      assert.equal(commands.requests.filter(request => request.args.includes("push")).length, 0);
      assert.equal(commands.requests.some(request => request.command === "gh" && request.args[1] === "edit"), false);
    });
    await t.test("concurrent exact-head reuse", async () => {
      const commands = new FakeCommands("exact-concurrent");
      await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(await input(directory)), /changed before body reconciliation/);
      assert.equal(commands.requests.some(request => request.args.includes("push")), false);
      assert.equal(commands.requests.some(request => request.command === "gh" && request.args[1] === "edit"), false);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher rejects mismatched PR identity, malformed bodies, and multiple matches before mutation", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const cases: readonly [string, FakeCommands][] = [
      ["wrong base", new FakeCommands("fast-forward", record => ({ ...record, baseRefName: "develop" }))],
      ["wrong head", new FakeCommands("fast-forward", record => ({ ...record, headRefName: "squire/other-ticket" }))],
      ["wrong repository owner", new FakeCommands("fast-forward", record => ({ ...record, headRepositoryOwner: { login: "other-owner" } }))],
      ["repository owner without canonical login", new FakeCommands("fast-forward", record => ({ ...record, headRepositoryOwner: { name: "example" } }))],
      ["wrong repository URL", new FakeCommands("fast-forward", record => ({ ...record, url: "https://github.com/other/repo/pull/7" }))],
      ["malformed body", new FakeCommands("fast-forward", record => ({ ...record, body: "owner text without Squire markers" }))],
      ["malformed duplicate validated head marker", new FakeCommands("fast-forward", record => ({ ...record, body: `${String(record["body"])}\nValidated head: not-a-sha\n` }))],
      ["unexpected validated head", new FakeCommands("fast-forward", record => ({ ...record, body: String(record["body"]).replace(/Validated head: `[^`]+`/u, `Validated head: \`${"e".repeat(40)}\``) }))],
      ["candidate validated head on old PR", new FakeCommands("fast-forward", record => ({ ...record, body: String(record["body"]).replace(/Validated head: `[^`]+`/u, `Validated head: \`${HEAD}\``) }))],
      ["validated head before ticket", new FakeCommands("fast-forward", record => {
        const body = String(record["body"]);
        const marker = body.match(/^Validated head: `[^`]+`\n\n/mu)?.[0] ?? "";
        return { ...record, body: `${marker}${body.replace(marker, "")}` };
      })],
      ["Retro before Squire phases", new FakeCommands("fast-forward", record => {
        const body = String(record["body"]);
        const retro = body.indexOf("\n## Retro");
        return { ...record, body: `${body.slice(retro + 1)}\n\n${body.slice(0, retro)}` };
      })],
      ["duplicate Retro sections", new FakeCommands("fast-forward", record => ({ ...record, body: `${String(record["body"])}\n## Retro\n\n- duplicate\n` }))],
      ["duplicate Knowledge sections", new FakeCommands("fast-forward", record => ({ ...record, body: `${String(record["body"])}\n## Knowledge\n\n- Disposition: not_required\n- Reason: duplicate\n` }))],
      ["malformed Knowledge section", new FakeCommands("fast-forward", record => ({ ...record, body: String(record["body"]).replace("\n## Retro", "\n## Knowledge\n\n- malformed\n\n## Retro") }))],
      ["Knowledge after Retro", new FakeCommands("fast-forward", record => ({ ...record, body: `${String(record["body"])}\n## Knowledge\n\n- Disposition: not_required\n- Reason: misplaced\n` }))],
      ["case-insensitive duplicate Retro sections", new FakeCommands("fast-forward", record => ({ ...record, body: `${String(record["body"])}\n## retro\n\n- duplicate\n` }))],
      ["malformed response", new FakeCommands("fast-forward", record => ({ ...record, number: "7" }))],
      ["multiple matches", new FakeCommands("multiple")],
    ];
    for (const [name, commands] of cases) {
      await t.test(name, async () => {
        await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(await input(directory)), /unexpected identity or body|multiple matching|unexpected Squire body/);
        assert.equal(commands.requests.some(request => request.args.includes("push")), false);
        assert.equal(commands.requests.some(request => request.command === "gh" && request.args[1] === "edit"), false);
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher renders an updated Knowledge disposition with sorted committed paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    const original = await input(directory);
    const implementation = original.phases.implement as ImplementPhaseResult;
    const updated: PublicationInput = {
      ...original,
      phases: {
        ...original.phases,
        implement: {
          ...implementation,
          details: {
            ...implementation.details,
            projectWiki: {
              status: "updated",
              paths: [".llm-wiki/wiki/z.md", ".llm-wiki/wiki/a.md"],
              summary: "documented the durable project knowledge",
            },
          },
        },
      },
    };
    const commands = new FakeCommands("create");
    await new GitHubPublisher({ commands, tokens }).publish(updated);
    const body = commands.writtenBodies[0] ?? "";
    assert.equal(body.match(/^## Knowledge$/gmu)?.length, 1);
    assert.equal(body.match(/^## Retro$/gmu)?.length, 1);
    assert.match(body, /- Disposition: updated/);
    assert.match(body, /- Summary: documented the durable project knowledge/);
    assert.ok(body.indexOf(".llm-wiki/wiki/a.md") < body.indexOf(".llm-wiki/wiki/z.md"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publisher replaces one valid legacy Knowledge section and rejects malformed disposition evidence before mutation", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-publisher-"));
  try {
    await t.test("replace one valid section", async () => {
      const commands = new FakeCommands("existing", record => ({
        ...record,
        body: String(record["body"]).includes("## Knowledge") ? String(record["body"]) : String(record["body"]).replace("\n## Retro", "\n## Knowledge\n\n- Disposition: not_required\n- Reason: old reason\n\n## Retro"),
      }));
      await new GitHubPublisher({ commands, tokens }).publish(await input(directory));
      const body = commands.writtenBodies.at(-1) ?? "";
      assert.equal(body.match(/^## Knowledge$/gmu)?.length, 1);
      assert.match(body, /the ticket adds no durable project knowledge/);
      assert.doesNotMatch(body, /old reason/);
    });
    for (const [name, mutate] of [
      ["duplicate", (record: Record<string, unknown>) => ({ ...record, body: `${String(record["body"])}\n## Knowledge\n\n- Disposition: not_required\n- Reason: duplicate\n` })],
      ["malformed", (record: Record<string, unknown>) => ({ ...record, body: String(record["body"]).replace("\n## Retro", "\n## Knowledge\n\n- malformed\n\n## Retro") })],
    ] as const) {
      await t.test(name, async () => {
        const commands = new FakeCommands("fast-forward", mutate);
        await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(await input(directory)), /unexpected Squire body/);
        assert.equal(commands.requests.some(request => request.args.includes("push")), false);
        assert.equal(commands.requests.some(request => request.command === "gh" && request.args[1] === "edit"), false);
      });
    }
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
    assert.equal(commands.listCalls, 5);
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

for (const failure of ["fetch-failure", "timeout", "cancelled", "moved", "tag-object", "missing-branch", "malformed-ref", "no-pr-diverged", "edited-before-push"]) {
  test(`publisher preflight rejects ${failure} without remote mutation`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "squire-fetch-negative-"));
    const base = new FakeCommands(failure === "no-pr-diverged" || failure === "malformed-ref" ? "create" : "fast-forward");
    const abort = new AbortController();
    try {
      const commands: CommandPort = { async run(request, signal) {
        assert.equal(signal, abort.signal);
        if (request.args.includes("fetch")) {
          assert.equal(request.timeoutMs, 180_000);
          assert.equal(request.sensitive, true);
          assert.ok(request.args.includes("--no-tags"));
          assert.ok(request.args.includes("--no-write-fetch-head"));
          assert.ok(request.args.includes(`+refs/heads/${BRANCH}:refs/squire-publication/observed-head`));
          assert.equal(request.env?.["GIT_TERMINAL_PROMPT"], "0");
          if (["fetch-failure", "timeout", "cancelled", "missing-branch"].includes(failure)) throw new Error(failure);
        }
        if (request.args.includes("ls-remote")) return { stdout: failure === "malformed-ref" ? `${PREVIOUS_HEAD}\trefs/heads/other\n` : `${PREVIOUS_HEAD}\trefs/heads/${BRANCH}\n`, stderr: "" };
        if (request.args.includes("rev-parse") && request.args.includes("refs/squire-publication/observed-head")) return { stdout: failure === "moved" ? CONCURRENT_HEAD : PREVIOUS_HEAD, stderr: "" };
        if (request.args.includes("cat-file") && request.args.includes("-t") && failure === "tag-object") return { stdout: "tag", stderr: "" };
        if (request.args.includes("merge-base") && request.args.includes(PREVIOUS_HEAD) && failure === "no-pr-diverged") throw new Error("not an ancestor");
        const result = await base.run(request);
        if (request.command === "gh" && request.args[1] === "list" && base.listCalls === 2 && failure === "edited-before-push") {
          const records = JSON.parse(result.stdout); records[0].body += "owner edit";
          return { stdout: JSON.stringify(records), stderr: "" };
        }
        return result;
      } };
      await assert.rejects(new GitHubPublisher({ commands, tokens, consistencyDelayMs: 0 }).publish(await input(directory), abort.signal));
      assert.equal(base.requests.some(request => request.args.includes("push") || request.args[1] === "edit" || request.args[1] === "create"), false);
      const clone = base.requests.find(request => request.args[0] === "clone");
      if (clone) await assert.rejects(readFile(path.join(clone.args[2]!, ".git", "HEAD")), { code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("authenticated fetch supplies an absent real remote head but cannot authorize unrelated replacement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-fetch-real-"));
  const runner = new NodeCommandRunner();
  const git = async (args: readonly string[]) => (await runner.run({ command: "git", args })).stdout.trim();
  try {
    const repository = path.join(directory, "source");
    const remote = path.join(directory, "remote.git");
    await git(["init", repository]); await git(["init", "--bare", remote]);
    await git(["-C", repository, "config", "user.email", "fixture@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "Fixture"]);
    await writeFile(path.join(repository, "file"), "base");
    await git(["-C", repository, "add", "."]); await git(["-C", repository, "commit", "-m", "base"]);
    const baseSha = await git(["-C", repository, "rev-parse", "HEAD"]);
    await writeFile(path.join(repository, "file"), "previous failed candidate");
    await git(["-C", repository, "commit", "-am", "previous"]);
    const previous = await git(["-C", repository, "rev-parse", "HEAD"]);
    await git(["-C", repository, "push", remote, `HEAD:refs/heads/${BRANCH}`]);
    await git(["-C", repository, "checkout", "-B", BRANCH, baseSha]);
    await writeFile(path.join(repository, "file"), "fresh candidate");
    await git(["-C", repository, "commit", "-am", "candidate"]);
    const head = await git(["-C", repository, "rev-parse", "HEAD"]);
    const original = await input(directory);
    await rm(original.bundle.path);
    await git(["-C", repository, "bundle", "create", original.bundle.path, `refs/heads/${BRANCH}`]);
    const bytes = await readFile(original.bundle.path);
    const candidate: PublicationInput = { ...original, head, phases: JSON.parse(JSON.stringify(original.phases).replaceAll(HEAD, head).replaceAll(BASE, baseSha)), bundle: { ...original.bundle, baseSha, head, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
    const fake = new FakeCommands("fast-forward");
    let fetched = false; let absentBeforeFetch = false;
    const commands: CommandPort = { async run(request, signal) {
      if (request.command === "gh") {
        const result = await fake.run(request);
        return { ...result, stdout: result.stdout.replaceAll(PREVIOUS_HEAD, previous).replaceAll(HEAD, head) };
      }
      assert.equal(request.args.includes("push"), false, "unrelated candidate must never push");
      if (request.args.includes("fetch")) {
        const checkout = request.args[1]!;
        await assert.rejects(git(["-C", checkout, "cat-file", "-e", previous]));
        absentBeforeFetch = true;
        assert.equal(request.sensitive, true); assert.equal(request.timeoutMs, 180_000);
        assert.ok(request.env?.["GIT_CONFIG_VALUE_0"]);
        const result = await runner.run({ ...request, args: request.args.map(arg => arg === "https://github.com/example/repo.git" ? remote : arg) }, signal);
        assert.equal(await git(["-C", checkout, "cat-file", "-t", previous]), "commit");
        fetched = true; return result;
      }
      return runner.run(request, signal);
    } };
    await assert.rejects(new GitHubPublisher({ commands, tokens }).publish(candidate));
    assert.equal(absentBeforeFetch, true); assert.equal(fetched, true);
    assert.equal(await git(["--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`]), previous);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
