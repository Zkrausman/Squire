import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NodeCommandRunner, CommandExecutionError } from "../src/personal/command.js";
import { terminalPiReport, parsePiUsage } from "../src/personal/pi-telemetry-parser.js";
import { TelemetryLedger, buildRunTelemetry } from "../src/personal/telemetry.js";
import type { PhaseInput, PersonalRunState } from "../src/personal/types.js";
import { piJsonStream, piThresholdCompactionEvents } from "./helpers/pi-json.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
const profile = { provider: "openai-codex", model: "fixture", thinking: "medium" } as const;
const commands = new NodeCommandRunner();

test("bounded Pi transport drains overflow without killing paid work; keeps exact prefix and terminal event", async () => {
  const stream = piJsonStream("phase-result", profile);
  const spec = { command: process.execPath, args: ["-e", `process.stdout.write('x'.repeat(100000)+'\u005cn');process.stderr.write('PRIVATE SECRET'.repeat(10000));process.stdout.write(${JSON.stringify(stream)});`], capture: "pi-json" as const, maxOutputBytes: 4096 };
  const output = await commands.run(spec);
  assert.equal(output.stdoutTruncated, true);
  assert.deepEqual(output.stdoutBytes, Buffer.from("x".repeat(4096)));
  assert.equal(terminalPiReport(output.terminalEventBytes!).toString(), "phase-result");
  assert.equal(output.stdout, ""); assert.equal(output.stderr, "");
});
test("small Pi transport retains all exact raw bytes and does not reconstruct the terminal event", async () => {
  const raw = Buffer.from(piJsonStream("hello\r\n🙂", profile));
  const output = await commands.run({ command: process.execPath, args: ["-e", `const b=Buffer.from('${raw.toString("base64")}','base64');for (let i=0;i<b.length;i++) process.stdout.write(b.subarray(i,i+1));`], capture: "pi-json", maxOutputBytes: 4096 });
  assert.deepEqual(output.stdoutBytes, raw);
  assert.equal(output.stdoutTruncated, false);
  assert.equal(output.terminalEventBytes!.toString(), raw.toString().trimEnd().split("\n").at(-1) + "\n");
  assert.equal(terminalPiReport(output.terminalEventBytes!).toString(), "hello\r\n🙂");
});
test("Pi transport execution failure preserves bytes but no raw stdout/stderr in errors", async () => {
  const raw = "PRIVATE SECRET\u001b[31m\n";
  await assert.rejects(commands.run({ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(raw)});process.stderr.write('CREDENTIAL');process.exitCode=1;`], capture: "pi-json" }), error => {
    assert.ok(error instanceof CommandExecutionError);
    assert.deepEqual(error.stdoutBytes, Buffer.from(raw));
    assert.ok(!String(error).includes("PRIVATE")); assert.ok(!String(error).includes("CREDENTIAL"));
    assert.equal(error.stdout, ""); return true;
  });
  await assert.rejects(commands.run({ command: path.join(process.cwd(), "no-such-executable"), args: [], capture: "pi-json" }), error => error instanceof CommandExecutionError && error.classification === "infrastructure");
});
test("incomplete trailing event cannot reuse a prior terminal event", async () => {
  const stream = piJsonStream("finished", profile);
  const output = await commands.run({ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(stream + "truncated")});`], capture: "pi-json" });
  assert.deepEqual(output.terminalEventBytes, Buffer.alloc(0));
});
test("Plan launch IPC preserves an interrupted child even without close IPC; duplicate closures rejected", async () => {
  const root = await launchTestRoot("squire-telemetry-ipc-");
  const child = new TelemetryLedger(path.join(root, "child"));
  const controller = new TelemetryLedger(path.join(root, "controller"));
  const input: PhaseInput = { runId: "aidev-299-planipc1", phase: "plan", attempt: 1, expectedHead: "a".repeat(40), originalTicketBaseSha: "a".repeat(40), previousCumulative: [], profile, ticket: { id: "AIDEV-299", title: "fixture", description: "fixture" }, repository: "example/repo", baseBranch: "main", branch: "fixture", sandbox: "fixture", previous: {}, feedback: [] };
  try {
    const row = await child.begin(input, randomUUID(), "requirements");
    controller.accept(structuredClone(row), input);
    assert.equal(controller.rows()[0]!.endedAt, null);
    assert.equal(controller.rows()[0]!.outcome, "interrupted");
    const state = { runId: input.runId, version: 2, status: "interrupted", startedAt: row.startedAt, endedAt: row.startedAt, planExecution: "supervised-v1", attempts: { plan: 1, implement: 0, review: 0, test: 0, retro: 0 }, profiles: { plan: profile }, results: {} } as PersonalRunState;
    const interrupted = buildRunTelemetry(state, controller.rows());
    assert.equal(interrupted.sessions.length, 1); assert.equal(interrupted.totals.durationComplete, false); assert.equal(interrupted.totals.tokensComplete, false);
    await child.finish(row, Buffer.from(piJsonStream("fixture", profile)), "passed");
    controller.accept(structuredClone(row), input);
    assert.equal(controller.rows().length, 1); assert.equal(controller.rows()[0]!.tokens?.input, 10);
    assert.throws(() => controller.accept(row, input), /duplicate/);
    assert.throws(() => controller.accept({ ...row, runId: "aidev-299-forged123" }, input), /binding/);
    const persisted = await readdir(path.join(root, "child"));
    assert.ok(persisted.length >= 3);
    assert.ok((await Promise.all(persisted.map(n => readFile(path.join(root, "child", n), "utf8")))).some(t => t.includes('"event":"launch"')));
  } finally { await child.release(); await controller.release(); await rm(root, { recursive: true, force: true }); }
});

for (const overflow of [false, true]) test(`post-agent_end compaction survives ${overflow ? "overflow" : "normal"} transport with exact report bytes`, async () => {
  const stream = piJsonStream('{"status":"passed"}', profile);
  const tail = piThresholdCompactionEvents().map(e => JSON.stringify(e)).join("\n") + "\n";
  const raw = (overflow ? "x".repeat(5000) + "\n" : "") + stream + tail;
  const output = await commands.run({ command: process.execPath, args: ["-e", `const b=Buffer.from(${JSON.stringify(raw)});for(let i=0;i<b.length;i+=13)process.stdout.write(b.subarray(i,i+13));`], capture: "pi-json", maxOutputBytes: 4096 });
  assert.deepEqual(output.stdoutBytes, Buffer.from(raw).subarray(0, 4096));
  assert.equal(output.stdoutTruncated, overflow);
  assert.equal(output.terminalEventBytes!.toString(), stream.trimEnd().split("\n").at(-1) + "\n");
  assert.equal(terminalPiReport(output.terminalEventBytes!).toString(), '{"status":"passed"}');
  const usage = parsePiUsage(output.stdoutBytes, profile);
  assert.equal(usage.tokens, null);
  if (!overflow) assert.ok(usage.diagnostics.includes("unsupported_compaction"));
  assert.ok(!JSON.stringify(usage).includes("PRIVATE"));
});

test("overflow cannot fall back to an obsolete terminal in the accounting prefix", async () => {
  const stream = piJsonStream("obsolete", profile);
  for (const tail of [
    "truncated", '{"type":"unknown"}\n',
    JSON.stringify(piThresholdCompactionEvents()[0]) + "\n",
    "x".repeat(10000) + "\n",
  ]) {
    const output = await commands.run({ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(stream + tail)});`], capture: "pi-json", maxOutputBytes: Buffer.byteLength(stream) });
    assert.equal(output.stdoutTruncated, true);
    assert.equal(terminalPiReport(output.stdoutBytes!).toString(), "obsolete");
    assert.deepEqual(output.terminalEventBytes, Buffer.alloc(0));
    assert.throws(() => terminalPiReport(output.terminalEventBytes ?? output.stdoutBytes!));
  }
});
