import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { NodeCommandRunner, type CommandPort, type CommandRequest, type CommandResult } from "../src/personal/command.js";
import { loadPersonalMvpConfig } from "../src/personal/config.js";
import { DockerSandboxWorkspace } from "../src/personal/docker-sandbox.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import { LinearClient } from "../src/personal/linear-client.js";
import { validatePhaseResultShape } from "../src/personal/phase-result.js";
import { SandboxPiPhaseRunner, type PhaseProfile } from "../src/personal/pi-phase-runner.js";
import type { PersonalPhase, PhaseInput } from "../src/personal/types.js";

const BASE = "a".repeat(40);
const TOKEN = `ghs_${"x".repeat(40)}`;
const execFileAsync = promisify(execFile);

class RecordingCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  dirty = false;
  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push({ ...request, args: [...request.args], ...(request.env ? { env: { ...request.env } } : {}) });
    if (request.command === "git" && request.args.includes("rev-parse")) return { stdout: `${BASE}\n`, stderr: "" };
    if (request.command === "sbx" && request.args.includes("rev-parse")) return { stdout: `${BASE}\n`, stderr: "" };
    if (request.command === "sbx" && request.args.includes("--porcelain")) return { stdout: this.dirty ? " M file.ts\n" : "", stderr: "" };
    return { stdout: "", stderr: "" };
  }
}

const PROFILES: Readonly<Record<PersonalPhase, PhaseProfile>> = {
  plan: { provider: "provider", model: "plan-model", thinking: "medium" },
  implement: { provider: "provider", model: "implement-model", thinking: "high" },
  review: { provider: "provider", model: "review-model", thinking: "medium" },
  test: { provider: "provider", model: "test-model", thinking: "high" },
};

function phaseInput(phase: PersonalPhase): PhaseInput {
  return {
    runId: "aidev-1-0123456789",
    ticket: { id: "AIDEV-1", title: "Small", description: "Change one file" },
    repository: "example/repo",
    baseBranch: "main",
    sandbox: "squire-aidev-1-0123456789",
    branch: deterministicFeatureBranch("example/repo", "AIDEV-1"),
    phase,
    attempt: 1,
    expectedHead: BASE,
    previous: {},
    feedback: [],
  };
}

function details(phase: PersonalPhase): object {
  if (phase === "plan") return { steps: ["make change"] };
  if (phase === "implement") return { changes: ["changed file"] };
  if (phase === "review") return { findings: [] };
  return { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] };
}

test("Node command runner closes stdin for non-interactive child processes", async () => {
  const result = await new NodeCommandRunner().run({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('closed'))"],
    timeoutMs: 2_000,
  });
  assert.equal(result.stdout, "closed");
});

test("Linear client sends its credential only to the configured GraphQL endpoint", async () => {
  const original = globalThis.fetch;
  let captured: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = { input: String(input), ...(init ? { init } : {}) };
    return new Response(JSON.stringify({ data: { issue: { identifier: "AIDEV-1", title: "Small", description: "One change", url: "https://linear.example/AIDEV-1" } } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const ticket = await new LinearClient({ apiKey: "linear-secret", endpoint: "https://linear.example/graphql" }).get("AIDEV-1");
    assert.equal(ticket.id, "AIDEV-1");
    assert.equal(captured?.input, "https://linear.example/graphql");
    assert.equal(new Headers(captured?.init?.headers).get("authorization"), "linear-secret");
    assert.equal(JSON.parse(String(captured?.init?.body)).variables.id, "AIDEV-1");
  } finally { globalThis.fetch = original; }
});

test("Docker Sandbox adapter uses exact create/copy/exec argv and exposes no publication token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-adapter-"));
  try {
    const commands = new RecordingCommands();
    const workspace = new DockerSandboxWorkspace({ commands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging"), template: "template:v1" });
    const input = phaseInput("plan");
    const prepared = await workspace.prepare({ runId: input.runId, ticketId: input.ticket.id, sandbox: input.sandbox, branch: input.branch, repositoryPath: root, sourceRef: "main" });
    assert.equal(prepared.head, BASE);
    const create = commands.requests.find(request => request.command === "sbx" && request.args[0] === "create");
    assert.deepEqual(create?.args.slice(0, 6), ["create", "--name", input.sandbox, "--template", "template:v1", "shell"]);
    assert.ok(commands.requests.some(request => request.command === "sbx" && request.args[0] === "cp" && request.args[2] === `${input.sandbox}:/tmp/squire-source.bundle`));
    assert.ok(commands.requests.some(request => request.command === "sbx" && request.args[0] === "exec" && request.args.includes("/ticket/workspace")));
    assert.equal(commands.requests.some(request => request.env?.["GH_TOKEN"] === TOKEN || request.args.some(argument => argument.includes(TOKEN))), false);
    await workspace.assertClean(input.sandbox);
    commands.dirty = true;
    await assert.rejects(workspace.assertClean(input.sandbox), /uncommitted changes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi adapter launches exact profiles under env -i and denies Plan/Review write tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-phase-"));
  try {
    let phaseDocument: Record<string, unknown> | undefined;
    const requests: CommandRequest[] = [];
    const commands: CommandPort = {
      async run(request) {
        requests.push({ ...request, args: [...request.args], ...(request.env ? { env: { ...request.env } } : {}) });
        if (request.command === "sbx" && request.args[0] === "cp") phaseDocument = JSON.parse(await readFile(request.args[1]!, "utf8"));
        if (request.command === "sbx" && request.args.includes("--print")) {
          const phase = phaseDocument?.["phase"] as PersonalPhase;
          return { stdout: JSON.stringify({
            runId: phaseDocument?.["runId"], phase, attempt: phaseDocument?.["attempt"], sessionId: phaseDocument?.["sessionId"], sessionFile: phaseDocument?.["sessionFile"], inputHead: phaseDocument?.["expectedHead"], outputHead: BASE, status: "passed", summary: `${phase} passed`, details: details(phase),
          }), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    };
    const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, profiles: PROFILES, testCommands: ["npm test"] });
    for (const phase of ["plan", "review", "test", "implement"] as const) await runner.run(phaseInput(phase));
    const launches = requests.filter(request => request.command === "sbx" && request.args.includes("--print"));
    assert.equal(launches.length, 4);
    for (const [index, phase] of (["plan", "review", "test", "implement"] as const).entries()) {
      const launch = launches[index]!;
      const envIndex = launch.args.indexOf("/usr/bin/env");
      assert.equal(launch.args[envIndex + 1], "-i");
      assert.equal(launch.args.includes("PI_OFFLINE=1"), true);
      assert.equal(launch.args.includes("PI_TELEMETRY=0"), true);
      assert.equal(launch.args[launch.args.indexOf("--model") + 1], PROFILES[phase].model);
      assert.equal(launch.args.includes("--session-id"), false);
      assert.equal(launch.args.some(argument => argument.includes(TOKEN) || argument.includes("LINEAR_API_KEY") || argument.includes("GH_TOKEN")), false);
      const tools = launch.args[launch.args.indexOf("--tools") + 1];
      if (phase === "plan" || phase === "review") assert.equal(tools?.split(",").includes("write"), false);
      if (phase === "implement") assert.equal(tools?.split(",").includes("write"), true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("passing Plan output without actionable steps is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-phase-"));
  try {
    let document: Record<string, unknown> | undefined;
    const commands: CommandPort = { async run(request) {
      if (request.args[0] === "cp") document = JSON.parse(await readFile(request.args[1]!, "utf8"));
      if (request.args.includes("--print")) return { stdout: JSON.stringify({ runId: document?.["runId"], phase: "plan", attempt: 1, sessionId: document?.["sessionId"], sessionFile: document?.["sessionFile"], inputHead: BASE, outputHead: BASE, status: "passed", summary: "empty", details: { steps: [] } }), stderr: "" };
      return { stdout: "", stderr: "" };
    } };
    const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, profiles: PROFILES, testCommands: ["npm test"] });
    await assert.rejects(runner.run(phaseInput("plan")), /Plan steps/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("passing Review and Test require their structured phase evidence", () => {
  const common = { runId: "aidev-1-run", attempt: 1, sessionId: "session", sessionFile: "/ticket/sessions/review/1.jsonl", inputHead: BASE, outputHead: BASE, status: "passed", summary: "passed" };
  assert.throws(() => validatePhaseResultShape({ ...common, phase: "review" }, "review"), /fields|details/);
  assert.throws(() => validatePhaseResultShape({ ...common, phase: "test", sessionFile: "/ticket/sessions/test/1.jsonl", details: { commands: [] } }, "test"), /Test commands/);
});

test("configuration requires an external GitHub token command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-config-"));
  try {
    const file = path.join(root, "config.json");
    await writeFile(file, JSON.stringify({
      repository: { slug: "example/repo", path: ".", sourceRef: "main", baseBranch: "main" },
      paths: { state: "state", bridges: "bridges", staging: "staging" },
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      github: { tokenCommand: ["token-helper", "--installation", "123"] },
      sandbox: { roleUser: "1000:1000", piExecutable: "pi", piAgentDirectory: "/ticket/runtime/pi-agent" },
      profiles: PROFILES,
      testCommands: ["npm test"],
    }));
    const config = await loadPersonalMvpConfig(file);
    assert.deepEqual(config.github.tokenCommand, ["token-helper", "--installation", "123"]);
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), github: {} }));
    await assert.rejects(loadPersonalMvpConfig(file), /github.tokenCommand/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI invalid invocation exits with usage and starts no adapter", async () => {
  const cli = fileURLToPath(new URL("../src/personal/cli.js", import.meta.url));
  await assert.rejects(execFileAsync(process.execPath, [cli]), error => {
    const failure = error as Error & { code?: number; stderr?: string };
    assert.equal(failure.code, 2);
    assert.match(failure.stderr ?? "", /Usage: squire run/);
    return true;
  });
});
