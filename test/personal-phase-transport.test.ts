import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PhaseInputTransport, PHASE_GUARD, MAX_TRANSPORT_BYTES, checkTransportCommand, guardPayload, launchProtected, transportBinding } from "../src/personal/phase-input-transport.js";
import { NodeCommandRunner } from "../src/personal/command.js";
import { reportHash } from "../src/personal/report-evidence.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { captureLaunchMaterial } from "../src/personal/launch-material.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { supervisorEnvironment } from "../src/personal/plan-supervisor-runner.js";
import { persistWindowsPhaseInput } from "../src/personal/windows-launch.js";
import type { PhaseInput } from "../src/personal/types.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { createPlanSbx } from "./helpers/plan-sbx.js";
import { TEST_CONFIG_DIGEST, TEST_MATERIAL } from "./helpers/personal-launch.js";

const head = "a".repeat(40);
const canary = "PRIVATE_TRANSPORT_CANARY_";
const large = canary + "variable ticket feedback material \u00e9\n".repeat(30000);
const input: PhaseInput = { runId: "aidev-303-transport", phase: "implement", attempt: 1, originalTicketBaseSha: head, expectedHead: head, profile: { provider: "fixture", model: "fixture", thinking: "high" }, previousCumulative: [], previous: {}, feedback: [large], ticket: { id: "AIDEV-303", title: "fixture", description: large }, repository: "example/repo", baseBranch: "main", branch: "fixture", sandbox: "fixture" };
const binding = transportBinding(input);
async function fixture(fn: (root: string, transport: PhaseInputTransport) => Promise<void>) {
  const root = await launchTestRoot("squire-transport-");
  const transport = new PhaseInputTransport(root);
  try { await fn(root, transport); } finally { await transport.release(); await rm(root, { recursive: true, force: true }); }
}

test("protected manifest chunks large bytes, canonicalizes and creates fresh identities without overwriting failed evidence", async () => fixture(async (root, store) => {
  const data = { b: large, a: large };
  const first = await store.write(data, binding), second = await store.write(data, binding);
  assert.ok(first.byteLength > 1024 * 1024);
  assert.ok(first.chunks.length > 1);
  assert.notEqual(first.sha256, second.sha256);
  assert.notEqual(first.id, second.id);
  assert.ok(first.chunks.every(a => second.chunks.every(b => a.path !== b.path)));
  assert.deepEqual(JSON.parse((await store.read(first, binding)).toString()), data);
  await store.release(); // Independent reopen, including native Windows leases.
  assert.deepEqual(await store.read(first, binding), await store.read(second, binding));
  assert.ok((await readdir(path.join(root, "phase-transport"))).length >= first.chunks.length * 2 + 2);
}));

test("schema, length, digest and all launch bindings reject before any command; references cannot traverse or cross runs", async () => fixture(async (_root, store) => {
  const ref = await store.write({ data: large }, binding);
  for (const bad of [
    { ...ref, version: 2 }, { ...ref, extra: true }, { ...ref, byteLength: ref.byteLength - 1 }, { ...ref, sha256: "f".repeat(64) },
    ...["runId", "phase", "subphase", "attempt", "producer", "expectedHead", "originalTicketBaseSha", "profileDigest"].map(key => ({ ...ref, binding: { ...binding, [key]: key === "attempt" ? 2 : key === "phase" ? "review" : key === "subphase" ? "requirements" : "other" } })),
    { ...ref, chunks: [{ ...ref.chunks[0], path: path.join(path.dirname(ref.chunks[0]!.path), "..", "other", path.basename(ref.chunks[0]!.path)) }] },
    { ...ref, chunks: [{ ...ref.chunks[0], byteLength: 1 }] }, { ...ref, chunks: [{ ...ref.chunks[0], sha256: "0".repeat(64) }] },
  ]) await assert.rejects(store.read(bad as typeof ref, binding), /phase_transport/);
  await assert.rejects(store.read(ref, { ...binding, runId: "other-run" }), /phase_transport/);
  const other = { ...binding, runId: "other-run" };
  await assert.rejects(store.read({ ...ref, binding: other }, other), /phase_transport/);
  await assert.rejects(store.read({ ...ref, id: randomUUID() }, binding), /phase_transport/);
  assert.deepEqual(JSON.parse((await store.read(ref, binding)).toString()), { data: large });
}));

for (const fault of ["replacement", "symlink", "truncation", "permissions"] as const) test(`delivered artifact ${fault} fails closed (native sharing may reject the mutation itself)`, async () => fixture(async (root, store) => {
  const ref = await store.write({ data: large }, binding), file = ref.chunks[0]!.path;
  await store.release();
  let changed = false;
  try {
    if (fault === "replacement" || fault === "symlink") {
      const other = path.join(root, "saved"); await copyFile(file, other); await unlink(file);
      if (fault === "replacement") await copyFile(other, file); else await symlink(other, file);
    } else if (fault === "truncation") { await chmod(file, 0o600); await writeFile(file, "partial"); }
    else if (process.platform === "win32") {
      const { grant } = await import("./helpers/windows-launch.js"); await grant(file, "S-1-1-0", "Read");
    } else await chmod(file, 0o644);
    changed = true;
  } catch (error) { if (process.platform !== "win32") throw error; }
  if (changed) await assert.rejects(store.read(ref, binding), /phase_transport/);
  // On Windows, symlink creation may lack privilege; incomplete replacement
  // still must not become a readable reference.
  else if (fault === "symlink") await assert.rejects(store.read(ref, binding));
}));

test("capacity/unsupported input rejects before preparation, Pi, repository mutation or publication", async () => fixture(async (root) => {
  let spawned = 0, exported = 0, published = 0;
  const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: [], commands: { async run() { spawned++; throw new Error("must not spawn"); } } });
  const controller = new PersonalMvpController({ phases: runner,
    states: { async create() {}, async save() {}, async findActive() { return undefined; } },
    tickets: { async get() { return input.ticket; } },
    workspaces: { async prepare() { return { sandbox: "fixture", baseSha: head, head }; }, async currentHead() { return head; }, async assertClean() {}, async exportBundle() { exported++; throw new Error("must not export"); } },
    publication: { async publish() { published++; throw new Error("must not publish"); } },
  });
  await assert.rejects(controller.run({ ticketId: input.ticket.id, repository: input.repository, repositoryPath: root, sourceRef: "HEAD", baseBranch: "main" }), /phase_transport/);
  assert.equal(spawned + exported + published, 0);
  const commands = new NodeCommandRunner();
  for (const request of [
    { command: "sbx", args: ["x".repeat(33000)], stdin: Buffer.alloc(0) },
    { command: "sbx", args: [], stdin: Buffer.alloc(MAX_TRANSPORT_BYTES + 1) },
    { command: "sbx", args: [], stdin: Buffer.alloc(0), env: { DATA: "x".repeat(33000) } },
  ]) assert.throws(() => checkTransportCommand(commands, request), /phase_transport/);
}));

test("replacement during preparation revalidates immediately before invocation and retains failed bytes", async () => fixture(async (root, store) => {
  let calls = 0;
  const commands = { byteInput: true as const, async run() { calls++; return { stdout: "", stderr: "" }; } };
  const payload = guardPayload(binding, { cwd: "/ticket/workspace", uid: 1000, gid: 1000, deadline: Date.now() + 60000, executable: "pi", env: {}, args: [] }, "policy", JSON.stringify(input));
  await assert.rejects(launchProtected(commands, store, binding, payload, "sbx", "fixture", {}, 60000, undefined, async () => {
    // Windows denies replacement while the producer lease is retained. A
    // failed mutation itself aborts preparation; neither path may invoke Pi.
    const names = await readdir(path.join(root, "phase-transport"));
    const file = path.join(root, "phase-transport", names[0]!);
    await rename(file, file + ".failed"); await writeFile(file, "substitute");
  }));
  assert.equal(calls, 0);
  assert.ok((await readdir(path.join(root, "phase-transport"))).length >= 2);
}));

test("Windows/Linux actual child argv and environment stay bounded for every production route with oversized effective policy and cumulative/correction input", async () => fixture(async (root) => {
  const prompts = path.join(root, "prompts");
  const policy = canary + "captured system layer\n".repeat(5000);
  const put = async (file: string, data: string) => {
    if (process.platform === "win32") persistWindowsPhaseInput(file, data);
    else { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, data, { mode: 0o600 }); }
  };
  await put(path.join(prompts, "layer.md"), policy);
  await put(path.join(prompts, "manifest.json"), JSON.stringify({ version: 1, id: "large", phases: Object.fromEntries(["plan", "implement", "review", "test", "retro"].map(p => [p, "layer.md"])), subphases: { requirements: "layer.md", "implementation-design": "layer.md" } }));
  await put(path.join(root, "repository", "seed"), "fixture repository");
  const material = await captureLaunchMaterial({ config: { ...TEST_MATERIAL.config, repository: { ...TEST_MATERIAL.config.repository, path: path.join(root, "repository") }, promptPolicy: { version: 1, id: "large", root: prompts, plan: [] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
  const supervised = await captureLaunchMaterial({ config: { ...material.config, promptPolicy: { ...material.config.promptPolicy!, plan: ["requirements", "implementation-design"] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
  const record = path.join(root, "launches.jsonl"), sbx = await createPlanSbx(root, record);
  const options = { stagingRoot: root, commands: new NodeCommandRunner(), sbxExecutable: sbx, testCommands: [large], launchMaterial: material };
  const runner = new SandboxPiPhaseRunner(options);
  const secret = process.env["SQUIRE_TRANSPORT_TEST_SECRET"]; process.env["SQUIRE_TRANSPORT_TEST_SECRET"] = canary;
  try {
    for (const phase of ["plan", "implement", "review", "test", "retro"] as const) assert.equal((await runner.run({ ...input, phase })).status, "passed");
    // The controller dispatches remediation and staged attempts through the
    // same runner. Accumulated original-baseline evidence must remain intact.
    for (const attempt of [2, 3]) await runner.run({ ...input, attempt, feedback: [large, large], escalationDigest: "e".repeat(64), previousCumulative: [{ summary: large }] as never });
    assert.equal((await new SandboxPiPhaseRunner({ ...options, launchMaterial: supervised }).run({ ...input, phase: "plan" })).status, "passed");
    const evidence = await runner.reportEvidence.write(large);
    const original = { raw: large, evidence, sessionId: randomUUID(), sessionFile: "/ticket/sessions/implement/1.jsonl", timestamp: new Date().toISOString() };
    for (const correctionAttempt of [1, 2]) await runner.correctReport({ input, original, latest: original, diagnostic: large, diagnostics: [], correctionAttempt, producerId: randomUUID(), deadline: performance.now() + 60000 });
  } finally {
    if (secret === undefined) delete process.env["SQUIRE_TRANSPORT_TEST_SECRET"]; else process.env["SQUIRE_TRANSPORT_TEST_SECRET"] = secret;
    await runner.reportEvidence.release?.();
  }
  const launches = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(launches.length, 11);
  assert.equal(new Set(launches.map(l => l.transportId)).size, launches.length);
  for (const l of launches) {
    assert.ok(l.bytes > 1024 * 1024);
    assert.equal(l.sha256, l.wireArgs.at(-1));
    for (const metadata of [l.actualArgv, l.environment, l.actualCommandLine]) assert.ok(!JSON.stringify(metadata).includes(canary));
    assert.ok(!JSON.stringify(l.actualArgv).includes("phase-transport"));
    assert.ok(JSON.stringify(l.wireArgs).length < 24000);
    if (process.platform === "win32") assert.ok(l.actualCommandLine.length < 24000);
    if (l.correction) { assert.equal(l.data.original.raw, large); assert.equal(l.data.diagnostic, large); assert.ok(l.args.includes("--no-tools")); }
    else { assert.equal(l.data.ticket.description, large); assert.ok(l.prompt.includes(policy)); }
    assert.equal(l.environment.SQUIRE_TRANSPORT_TEST_SECRET, undefined);
  }
}));

const canRoot = process.platform === "linux" && (process.getuid?.() === 0 || spawnSync("sudo", ["-n", "true"]).status === 0);
test("real root guard publishes immutable prompt and Pi consumes exact oversized stdin; actual Pi argv/environment contain only selectors", { skip: !canRoot }, async () => fixture(async root => {
  if (process.getuid?.() === 0) await chmod(root, 0o755);
  const childFile = path.join(root, "pi.cjs");
  await writeFile(childFile, `const fs=require('node:fs'),crypto=require('node:crypto');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const args=process.argv;const prompt=args[args.indexOf('--system-prompt')+1];const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{let writable=true;try{fs.writeFileSync(prompt,'altered');}catch{writable=false;}console.log(JSON.stringify({argv:args,env:process.env,data:hash(Buffer.concat(chunks)),prompt:hash(fs.readFileSync(prompt)),writable}));});`);
  for (const phase of ["plan", "implement", "review", "test", "retro"] as const) {
    const phaseInput = { ...input, phase };
    const p = guardPayload(transportBinding(phaseInput), { cwd: root, uid: process.getuid!() || 1000, gid: process.getgid!() || 1000, deadline: Date.now() + 30000, executable: process.execPath, env: {}, args: [childFile, "--provider", input.profile.provider, "--model", input.profile.model, "--thinking", input.profile.thinking] }, large, JSON.stringify(phaseInput));
    const bytes = Buffer.from(JSON.stringify(p));
    const args = ["-e", PHASE_GUARD, reportHash(bytes)];
    const child = process.getuid!() === 0 ? spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] }) : spawn("sudo", ["-n", process.execPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close"); let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; }); child.stdin.end(bytes);
    try {
      const [code] = await closed; assert.equal(code, 0, stderr);
      const result = JSON.parse(stdout);
      assert.equal(result.data, reportHash(Buffer.from(p.data))); assert.equal(result.prompt, reportHash(Buffer.from(large))); assert.equal(result.writable, false);
      assert.ok(!JSON.stringify([result.argv, result.env]).includes(canary));
    } finally { spawnSync("sudo", ["-n", "rm", "-rf", `/run/squire-input-${p.id}`]); }
  }
}));

test("remote digest/schema/data binding mismatch stops before Pi marker and any workspace write", async () => fixture(async root => {
  const marker = path.join(root, "invoked");
  const payload = guardPayload(binding, { cwd: root, uid: 1000, gid: 1000, deadline: Date.now() + 30000, executable: process.execPath, env: {}, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'mutated')`] }, "policy", JSON.stringify(input));
  for (const [value, digest] of [
    [payload, "f".repeat(64)], [{ ...payload, version: 2 }, undefined], [{ ...payload, dataBytes: 1 }, undefined],
    [{ ...payload, binding: { ...binding, runId: "cross-run" } }, undefined], [{ ...payload, binding: { ...binding, expectedHead: "b".repeat(40) } }, undefined],
    [{ ...payload, binding: { ...binding, phase: "review" } }, undefined],
  ] as const) {
    const bytes = Buffer.from(JSON.stringify(value));
    await assert.rejects(new NodeCommandRunner().run({ command: process.execPath, args: ["-e", PHASE_GUARD, digest ?? reportHash(bytes)], stdin: bytes, env: supervisorEnvironment(), sanitized: true }), /phase_transport/);
    await assert.rejects(readFile(marker), /ENOENT/);
  }
}));
