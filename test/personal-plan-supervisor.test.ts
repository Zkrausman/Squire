import { PersonalMvpController } from "../src/personal/controller.js";
import { validateState } from "../src/personal/json-run-state.js";
import type { PersonalRunState } from "../src/personal/types.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { captureLaunchMaterial, composeSystemPrompt } from "../src/personal/launch-material.js";
import { supervisePlan, REMOTE_GUARD } from "../src/personal/plan-supervisor.js";
import { PlanSupervisorRunner, supervisorEnvironment } from "../src/personal/plan-supervisor-runner.js";
import { validateExecutablePlan } from "../src/personal/prompt-policy.js";
import { digestArtifact, validateRequirements, validateDesign, type RequirementsArtifact } from "../src/personal/plan-artifacts.js";
import { validatePhaseResultShape } from "../src/personal/phase-result.js";
import type { CommandPort, CommandRequest } from "../src/personal/command.js";
import type { PhaseInput } from "../src/personal/types.js";
import { TEST_CONFIG_DIGEST, TEST_MATERIAL } from "./helpers/personal-launch.js";
import { createPlanSbx } from "./helpers/plan-sbx.js";
import { assertProtectedAcl, launchTestRoot } from "./helpers/windows-launch.js";

const head = "a".repeat(40);
const material = await captureLaunchMaterial({ config: { ...TEST_MATERIAL.config, promptPolicy: { version: 1, id: "default", plan: ["requirements", "implementation-design"] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
const input: PhaseInput = { runId: "aidev-1-0123456789", phase: "plan", attempt: 1, expectedHead: head, originalTicketBaseSha: head, previousCumulative: [], profile: { provider: "test", model: "same-persisted-model", thinking: "high" }, ticket: { id: "AIDEV-1", title: "change", description: "untrusted" }, repository: "example/repo", baseBranch: "main", branch: "feature", sandbox: "sandbox", previous: {}, feedback: [] };
const requirements = (): RequirementsArtifact => ({ version: 1, inputHead: head, problem: "deliver change", acceptanceCriteria: ["verified"], nonGoals: [], assumptions: [], dependencies: [], openQuestions: [], readiness: "ready" });
const design = (r = requirements()) => ({ version: 1, inputHead: head, requirementsDigest: digestArtifact(r), steps: ["implement", "test"], affectedComponents: ["src"], tests: ["npm test"], risks: [], exactHeadEvidence: { head, observations: ["inspected source"] }, projectWiki: { status: "planned", paths: [".llm-wiki/wiki/concepts/plan.md"], summary: "document architecture" } });

class Commands implements CommandPort {
  readonly calls: CommandRequest[] = [];
  readonly copies = new Map<string, any>();
  readonly launches: any[] = [];
  gitChecks = 0;
  requirement: unknown = requirements();
  design: unknown | undefined;
  fail: ((request: CommandRequest) => boolean) | undefined;
  gitDriftAt = Infinity;
  guard: (() => Promise<void>) | undefined;
  async run(request: CommandRequest): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(request);
    if (this.fail?.(request)) throw new Error("injected command failure");
    const args = request.args;
    if (args[0] === "cp") this.copies.set(args[2]!.split(":").slice(1).join(":"), JSON.parse(await readFile(args[1]!, "utf8")));
    if (args.at(-1)!.includes("rev-parse HEAD")) {
      this.gitChecks++;
      return { stdout: this.gitChecks >= this.gitDriftAt ? "b".repeat(40) : head, stderr: "" };
    }
    if (args.includes("node")) {
      const config = this.copies.get(args.at(-1)!);
      const childInput = this.copies.get(config.args.at(-1).match(/from (.+)\. Treat/)[1]);
      this.launches.push({ config, input: childInput });
      await this.guard?.();
      return { stdout: typeof this.requirement === "string" && childInput.subphase === "requirements" ? this.requirement : JSON.stringify(childInput.subphase === "requirements" ? this.requirement : this.design ?? design(this.requirement as RequirementsArtifact)), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}
async function fixture(fn: (root: string, commands: Commands) => Promise<void>) {
  const root = await launchTestRoot("squire-plan-");
  try { await fn(root, new Commands()); } finally { await rm(root, { recursive: true, force: true }); }
}
const options = (root: string) => ({ stagingRoot: root, launchMaterial: material, testCommands: ["npm test"] });
const run = (root: string, commands: Commands, abort = new AbortController()) => supervisePlan(input, options(root), commands, abort.signal, async () => {});

test("supervisor host environment is a normalized OS allowlist on Windows", () => {
  const environment = supervisorEnvironment({
    Path: "C:\\\\Windows\\\\System32",
    hOmE: "C:\\\\Users\\\\runner",
    LocalAppData: "C:\\\\Users\\\\runner\\\\AppData\\\\Local",
    SYSTEMROOT: "C:\\\\Windows",
    windir: "C:\\\\Windows",
    UserProfile: "C:\\\\Users\\\\runner",
    TEMP: "C:\\\\Users\\\\runner\\\\AppData\\\\Local\\\\Temp",
    Tmp: "C:\\\\Users\\\\runner\\\\AppData\\\\Local\\\\Temp",
    LINEAR_API_KEY: "must-not-cross",
    GITHUB_TOKEN: "must-not-cross",
    NODE_OPTIONS: "--require=evil"
  }, "win32");
  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "LOCALAPPDATA", "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"].sort());
  assert.equal(environment["PATH"], "C:\\\\Windows\\\\System32");
  assert.equal(environment["LOCALAPPDATA"], "C:\\\\Users\\\\runner\\\\AppData\\\\Local");
  assert.equal(environment["NODE_OPTIONS"], undefined);
  assert.equal(environment["LINEAR_API_KEY"], undefined);
});

test("supervisor host environment preserves exact Linux PATH and HOME casing", () => {
  const environment = supervisorEnvironment({ path: "/wrong", home: "/wrong-home", PATH: "/usr/bin", HOME: "/home/runner", NODE_OPTIONS: "--require=evil" }, "linux");
  assert.equal(environment["PATH"], "/usr/bin");
  assert.equal(environment["HOME"], "/home/runner");
  assert.equal(environment["path"], undefined);
  assert.equal(environment["home"], undefined);
});

test("supervisor host environment omits missing HOME and uses platform PATH default", () => {
  const environment = supervisorEnvironment({ path: "/wrong" }, "linux");
  assert.equal(environment["HOME"], undefined);
  assert.equal(environment["PATH"], "/usr/local/bin:/usr/bin:/bin");
  assert.deepEqual(Object.keys(environment), ["PATH"]);
});

test("supervisor host environment omits empty HOME but preserves empty PATH", () => {
  assert.deepEqual(supervisorEnvironment({ HOME: "", PATH: "" }, "linux"), { PATH: "" });
  assert.deepEqual(supervisorEnvironment({ hOmE: "", pAtH: "" }, "win32"), { PATH: "" });
});

test("supervisor host environment omits missing Windows variables", () => {
  const environment = supervisorEnvironment({ pAtH: "C:\\\\Windows\\\\System32", hOmE: "C:\\\\Users\\\\runner" }, "win32");
  assert.deepEqual(environment, { PATH: "C:\\\\Windows\\\\System32", HOME: "C:\\\\Users\\\\runner" });
});

test("only legacy empty or dependency-valid complete Plan selections execute", () => {
  validateExecutablePlan([]); validateExecutablePlan(["requirements", "implementation-design"]);
  for (const selection of [["requirements"], ["implementation-design"], ["implementation-design", "requirements"], ["requirements", "requirements"], ["unknown"]]) assert.throws(() => validateExecutablePlan(selection as never));
});

test("supervisor sequentially binds read-only fresh children, immutable handoff and aggregate", async () => fixture(async (root, commands) => {
  const events: string[] = [];
  const result = await supervisePlan(input, options(root), commands, new AbortController().signal, async p => {
    events.push(p.subphase);
    assert.equal(commands.launches.length, events.length - 1, "progress precedes only its immediate child");
  });
  assert.deepEqual(events, ["requirements", "implementation-design"]);
  assert.equal(result.status, "passed", result.summary);
  assert.equal(commands.gitChecks, 4);
  const [r, d] = commands.launches;
  assert.notEqual(r.input.sessionId, d.input.sessionId);
  assert.notEqual(r.input.sessionFile, d.input.sessionFile);
  assert.notEqual(r.config.env.HOME, d.config.env.HOME);
  assert.deepEqual(d.input.requirements, { content: requirements(), digest: digestArtifact(requirements()) });
  for (const launch of commands.launches) {
    assert.equal(launch.input.expectedHead, head);
    assert.deepEqual(launch.input.profile, input.profile);
    assert.equal(launch.config.args[launch.config.args.indexOf("--tools") + 1], "read,grep,find,ls");
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"]) assert.ok(launch.config.args.includes(flag));
    assert.deepEqual(Object.keys(launch.config.env).sort(), ["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "TMPDIR"]);
  }
  assert.equal(result.details.supervision?.children.length, 2);
  validatePhaseResultShape(JSON.parse(JSON.stringify(result)), "plan");
  for (const c of result.details.supervision!.children) {
    assert.equal(c.artifact!.digest, digestArtifact(c.artifact!.content));
    assert.deepEqual(commands.copies.get(c.artifact!.path), c.artifact!.content);
    assert.equal(c.launchDigest, material.digest);
  }
  assert.ok(commands.calls.some(c => c.args.at(-1)?.includes("termination unobserved")), "explicit remote close observation");
}));

test("clarification keeps validated questions, never launches Design, returns non-passing aggregate", async () => fixture(async (root, commands) => {
  commands.requirement = { ...requirements(), readiness: "needs_clarification", openQuestions: ["Which delivery target?"] };
  const result = await run(root, commands);
  assert.equal(result.status, "failed");
  assert.equal(result.details.supervision!.outcome, "needs_clarification");
  assert.match(result.summary, /Which delivery target/);
  assert.equal(commands.launches.length, 1);
  validatePhaseResultShape(result);
}));

test("malformed, extra JSON, unknown fields and wrong HEAD fail Requirements before Design", async t => {
  for (const value of ["{}\n{}", "```json\n{}\n```", { ...requirements(), extra: true }, { ...requirements(), inputHead: "b".repeat(40) }, { ...requirements(), readiness: "needs_clarification" }, { ...requirements(), acceptanceCriteria: [] }]) await t.test(JSON.stringify(value).slice(0, 80), () => fixture(async (root, commands) => {
    commands.requirement = value;
    const result = await run(root, commands);
    assert.equal(result.status, "failed");
    assert.equal(commands.launches.length, 1);
    assert.equal(result.details.supervision!.children[0]!.artifact, null);
    assert.ok(commands.gitChecks >= 2);
  }));
});

test("Design rejects unbound Requirements, HEAD, wiki claims and empty ordered steps", async t => {
  for (const bad of [{ ...design(), requirementsDigest: "f".repeat(64) }, { ...design(), inputHead: "b".repeat(40) }, { ...design(), projectWiki: { status: "updated", paths: [".llm-wiki/file"], summary: "already committed" } }, { ...design(), steps: [] }]) await t.test(JSON.stringify(bad), () => fixture(async (root, commands) => {
    commands.design = bad;
    const result = await run(root, commands);
    assert.equal(result.status, "failed");
    assert.equal(result.details.supervision!.children[1]!.outcome, "failed");
    assert.equal(result.details.supervision!.children[0]!.outcome, "passed");
  }));
});

test("closed bounded artifacts and aggregate reject forged identities, digests, order and profile", async () => fixture(async (root, commands) => {
  assert.throws(() => validateRequirements({ ...requirements(), problem: "x".repeat(8001) }, head));
  assert.throws(() => validateDesign({ ...design(), extra: true }, head, digestArtifact(requirements())));
  const result = await run(root, commands);
  for (const mutate of [
    (v: any) => { v.details.supervision.extra = 1; },
    (v: any) => { v.details.supervision.supervisorId = "forged"; },
    (v: any) => { v.details.supervision.children.reverse(); },
    (v: any) => { v.details.supervision.children[1].sessionId = v.details.supervision.children[0].sessionId; },
    (v: any) => { v.details.supervision.children[0].profile.model = "reselected"; },
    (v: any) => { v.details.supervision.children[0].launchDigest = "f".repeat(64); },
    (v: any) => { v.details.supervision.children[0].artifact.content.problem = "substituted"; },
    (v: any) => { v.details.supervision.children[0].artifact.path = "/child-writable"; },
    (v: any) => { v.details.supervision.children[1].inputHead = "b".repeat(40); },
    (v: any) => { v.details.steps = ["different plan"]; },
    (v: any) => { v.details.supervision.children = []; },
  ]) { const clone = JSON.parse(JSON.stringify(result)); mutate(clone); assert.throws(() => validatePhaseResultShape(clone), String(mutate)); }
}));

test("HEAD drift at every inspection blocks aggregation/next child", async t => {
  for (const at of [1, 2, 3, 4]) await t.test(String(at), () => fixture(async (root, commands) => {
    commands.gitDriftAt = at;
    const result = await run(root, commands);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /HEAD\/cleanliness/);
    assert.ok(commands.launches.length <= (at <= 3 ? 1 : 2));
  }));
});

test("failure at preparation, input copy, child exit, close observation, artifact persistence propagates", async t => {
  for (const stage of ["prepare", "input", "child", "reap", "artifact"]) await t.test(stage, () => fixture(async (root, commands) => {
    commands.fail = request => stage === "prepare" ? request.args.at(-1)!.includes("mkdir -m 755") : stage === "input" ? request.args[0] === "cp" && request.args[1]!.endsWith("requirements-input.json") : stage === "child" ? request.args.includes("node") : stage === "reap" ? request.args.at(-1)!.includes("termination unobserved") : request.args[0] === "cp" && request.args[1]!.endsWith("requirements.json");
    const result = await run(root, commands);
    assert.equal(result.status, "failed");
    assert.equal(result.details.supervision!.outcome, "failed");
    assert.ok(commands.launches.length <= 1);
    validatePhaseResultShape(result);
  }));
});

test("cancellation during child waits for cleanup and post-exit HEAD check; Design never launches", async () => fixture(async (root, commands) => {
  const abort = new AbortController();
  commands.guard = async () => { abort.abort(new Error("operator stop")); throw abort.signal.reason; };
  const result = await run(root, commands, abort);
  assert.equal(result.status, "failed");
  assert.equal(commands.launches.length, 1);
  assert.equal(commands.gitChecks, 2);
  assert.ok(commands.calls.some(c => c.args.at(-1)!.includes("termination unobserved")));
}));

test("real adapter forks one credential-free supervisor; only that supervisor invokes sbx", async () => fixture(async (root) => {
  const record = path.join(root, "launches.jsonl");
  const sbx = await createPlanSbx(root, record);
  let legacy = 0;
  const runner = new PlanSupervisorRunner({ ...options(root), sbxExecutable: sbx }, { async run() { legacy++; throw new Error("not legacy"); } });
  const progress: string[] = [];
  const sentinel = process.env["SQUIRE_FIXTURE_SECRET"];
  process.env["SQUIRE_FIXTURE_SECRET"] = "must-not-cross";
  let result;
  try { result = await runner.run(input, undefined, async event => { progress.push(event.subphase); }); }
  finally {
    if (sentinel === undefined) delete process.env["SQUIRE_FIXTURE_SECRET"];
    else process.env["SQUIRE_FIXTURE_SECRET"] = sentinel;
  }
  assert.equal(legacy, 0);
  assert.equal(result.status, "passed", result.summary);
  assert.deepEqual(progress, ["requirements", "implementation-design"]);
  const launches = (await readFile(record, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.equal(launches.length, 2);
  assert.equal(launches[0].supervisorPid, launches[1].supervisorPid);
  assert.notEqual(launches[0].supervisorPid, process.pid);
  const expectedHostKeys = ["HOME", "PATH"];
  if (process.platform === "win32") expectedHostKeys.push(...["LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "USERPROFILE", "TEMP", "TMP"]);
  if (process.platform === "win32") {
    // libuv supplies these OS defaults even for an explicit env block. They
    // are not additions to supervisorEnvironment's application allowlist.
    const osDefaults = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME"];
    const keys = launches[0].envKeys.map((key: string) => key.toUpperCase());
    assert.ok(keys.every((key: string) => [...expectedHostKeys, ...osDefaults].includes(key)));
    for (const key of expectedHostKeys) if (supervisorEnvironment()[key] !== undefined) assert.ok(keys.includes(key));
  } else assert.deepEqual(launches[0].envKeys.sort(), expectedHostKeys.sort());
  for (const key of ["NODE_OPTIONS", "LINEAR_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SQUIRE_FIXTURE_SECRET"]) {
    assert.ok(!launches[0].envKeys.some((actual: string) => actual.toUpperCase() === key), `${key} must not reach the transport`);
  }
  assert.equal(launches[0].prompt, composeSystemPrompt(material, "plan", "requirements"));
  if (process.platform === "win32") {
    assert.ok(result.phase === "plan");
    const local = path.join(root, input.runId, "plan", String(input.attempt), result.details.supervision!.supervisorId);
    for (const name of ["requirements.json", "implementation-design.json", "result.json"]) assertProtectedAcl(path.join(local, name));
    for (const launch of launches) {
      await assert.rejects(readFile(launch.stagingPath), /ENOENT/);
      await assert.rejects(readFile(launch.guardStagingPath), /ENOENT/);
    }
  }
}));

test("real adapter cancellation at acknowledged progress cannot launch either Pi child", async () => fixture(async root => {
  const record = path.join(root, "launches.jsonl");
  const sbx = await createPlanSbx(root, record);
  const abort = new AbortController();
  const runner = new PlanSupervisorRunner({ ...options(root), sbxExecutable: sbx }, {} as never);
  await assert.rejects(runner.run(input, abort.signal, async () => { abort.abort(); }), /interrupted/);
  await assert.rejects(readFile(record), /ENOENT/);
}));

test("remote guard observes child close after cancellation, rather than sbx-client exit", { skip: process.platform === "win32" }, async () => fixture(async root => {
  const control = path.join(root, "control"); await mkdir(control);
  const childFile = path.join(root, "child.cjs");
  await writeFile(childFile, "process.on('SIGTERM', () => process.exit(0)); console.log('READY'); setInterval(() => {}, 1000);");
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({ control, cwd: root, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, deadline: Date.now() + 30000, executable: process.execPath, args: [childFile], env: {} }));
  const guard = spawn(process.execPath, ["-e", REMOTE_GUARD, config], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(guard, "exit");
  try {
    const [ready] = await once(guard.stdout, "data");
    assert.match(String(ready), /READY/);
    await assert.rejects(readFile(path.join(control, "done")), /ENOENT/);
    await writeFile(path.join(control, "cancel"), "cancel");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(await readFile(path.join(control, "done"), "utf8"), "closed");
  } finally { guard.kill("SIGKILL"); }
}));

test("one supervisor deadline stops work before either child; legacy path remains explicit", async () => fixture(async (root, commands) => {
  const result = await supervisePlan(input, { ...options(root), timeoutMs: 0 }, commands, new AbortController().signal, async () => {});
  assert.equal(result.status, "failed");
  assert.equal(commands.launches.length, 0);
  assert.match(result.summary, /deadline/);
  let calls = 0;
  const runner = new PlanSupervisorRunner({ ...options(root), launchMaterial: TEST_MATERIAL }, { async run() { calls++; throw new Error("explicit legacy path"); } });
  await assert.rejects(runner.run(input), /explicit legacy/);
  assert.equal(calls, 1);
}));

test("adapter deadline cancels only its supervisor and waits for exit", async () => fixture(async root => {
  const sbx = await createPlanSbx(root, path.join(root, "launches"));
  const runner = new PlanSupervisorRunner({ ...options(root), sbxExecutable: sbx, timeoutMs: 1 }, {} as never);
  await assert.rejects(runner.run(input), /deadline/);
}));

test("remote guard observes noncooperative child exit after forced termination", { skip: process.platform === "win32" }, async () => fixture(async root => {
  const control = path.join(root, "control"); await mkdir(control);
  const childFile = path.join(root, "child.cjs");
  await writeFile(childFile, "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);");
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({ control, cwd: root, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, deadline: Date.now() + 30000, executable: process.execPath, args: [childFile], env: {} }));
  const guard = spawn(process.execPath, ["-e", REMOTE_GUARD, config], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(guard, "exit");
  try {
    await once(guard.stdout, "data"); // Synchronize before cancellation, no timing sleep.
    guard.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(await readFile(path.join(control, "done"), "utf8"), "closed");
  } finally { guard.kill("SIGKILL"); }
}));

test("remote guard enforces the phase deadline without a controller cancellation", { skip: process.platform === "win32" }, async () => fixture(async root => {
  const control = path.join(root, "control"); await mkdir(control);
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({ control, cwd: root, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, deadline: Date.now() - 1, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: {} }));
  const guard = spawn(process.execPath, ["-e", REMOTE_GUARD, config], { stdio: "ignore" });
  const [code] = await once(guard, "exit");
  assert.equal(code, 1);
  assert.equal(await readFile(path.join(control, "done"), "utf8"), "closed");
}));

test("staged Plan uses one profile for both fresh children and preserves clarification as terminal evidence", async () => fixture(async (root, commands) => {
  const staged = { ...input, escalationDigest: "e".repeat(64), profile: { provider: "chosen", model: "user-stage", thinking: "low" as const } };
  const r = await supervisePlan(staged, options(root), commands, new AbortController().signal, async () => {});
  assert.equal(r.status, "passed");
  for (const child of commands.launches) {
    assert.deepEqual(child.input.profile, staged.profile);
    assert.equal(child.config.args[child.config.args.indexOf("--model") + 1], "user-stage");
  }
  commands.requirement = { ...requirements(), openQuestions: ["which interface?"], readiness: "needs_clarification" };
  const clarification = await supervisePlan({ ...staged, attempt: 2 }, options(root), commands, new AbortController().signal, async () => {});
  assert.equal(clarification.details.supervision!.outcome, "needs_clarification");
  assert.equal(clarification.details.supervision!.children.length, 1);
}));

test("staged Plan never converts adapter or malformed-artifact failure into a retryable failed result", async () => fixture(async (root, commands) => {
  const staged = { ...input, escalationDigest: "e".repeat(64) };
  commands.requirement = "malformed";
  await assert.rejects(supervisePlan(staged, options(root), commands, new AbortController().signal, async () => {}), (error: any) => error.classification === "protocol");
  commands.fail = () => true;
  await assert.rejects(supervisePlan({ ...staged, attempt: 2 }, options(root), commands, new AbortController().signal, async () => {}), /injected command failure/);
}));


test("controller terminates staged Plan clarification without consuming a later stage", async () => fixture(async (root, commands) => {
  commands.requirement = { ...requirements(), openQuestions: ["which interface?"], readiness: "needs_clarification" };
  let state: PersonalRunState | undefined;
  let calls = 0;
  const controller = new PersonalMvpController({
    escalationPolicy: { plan: { stages: [{ ...input.profile, maxAttempts: 1 }, { ...input.profile, model: "later-stage", maxAttempts: 1 }] } },
    states: { async create(s) { validateState(s); state = s; }, async save(s) { validateState(s); state = s; }, async findActive() { return undefined; } },
    tickets: { async get() { return input.ticket; } },
    workspaces: { async prepare() { return { sandbox: input.sandbox, baseSha: head, head }; }, async currentHead() { return head; }, async assertClean() {}, async exportBundle() { throw new Error("unexpected publish"); } },
    phases: { async run(i) { calls++; return supervisePlan(i, options(root), commands, new AbortController().signal, async () => {}); } },
    publication: { async publish() { throw new Error("unexpected publish"); } },
  });
  await assert.rejects(controller.run({ ticketId: input.ticket.id, repository: input.repository, repositoryPath: "/tmp/repo", sourceRef: "HEAD", baseBranch: "main" }), /Plan needs clarification/);
  assert.equal(calls, 1);
  assert.equal(state!.attempts.plan, 1);
  assert.equal(state!.stagedTransitions!.at(-1)!.classification, "needs_clarification");
  assert.equal(state!.results.plan!.status, "failed");
}));
