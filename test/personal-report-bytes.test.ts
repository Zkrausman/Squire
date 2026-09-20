import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandExecutionError, NodeCommandRunner } from "../src/personal/command.js";
import { createReportEvidence, decodeReport, verifyReportEvidence } from "../src/personal/report-evidence.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { InvalidPhaseHandoff } from "../src/personal/report-correction.js";
import type { PhaseInput } from "../src/personal/types.js";
import { launchTestRoot } from "./helpers/windows-launch.js";

const bytes = Buffer.from([0x20, 0x0d, 0x0a, 0xc3, 0xa9, 0xff, 0, 0x20]);
test("command success and failure preserve exact stdout transport including invalid UTF-8", async () => {
  const commands = new NodeCommandRunner();
  for (const exit of [0, 1]) {
    const request = { command: process.execPath, args: ["-e", `process.stdout.write(Buffer.from('${bytes.toString("hex")}', 'hex'));process.exitCode=${exit}`] };
    if (!exit) assert.deepEqual((await commands.run(request)).stdoutBytes, bytes);
    else await assert.rejects(commands.run(request), error => {
      assert.ok(error instanceof CommandExecutionError);
      assert.deepEqual(error.stdoutBytes, bytes);
      return true;
    });
  }
});

test("byte bounds retain available partial bytes without accepting overflow", async () => {
  const commands = new NodeCommandRunner();
  await assert.rejects(commands.run({ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(8192, 255))"], maxOutputBytes: 128 }), error => {
    assert.ok(error instanceof CommandExecutionError);
    assert.ok(Buffer.isBuffer(error.stdoutBytes));
    assert.equal(error.stdoutBytes.length, 128);
    assert.ok(error.stdoutBytes.every(byte => byte === 255));
    return true;
  });
});

test("shared storage preserves non-text bytes before rejecting decoding", async () => {
  const root = await launchTestRoot("squire-report-bytes-");
  const evidence = createReportEvidence(path.join(root, "reports"));
  try {
    const ref = await evidence.write(bytes);
    assert.deepEqual(await verifyReportEvidence(evidence, ref), bytes);
    assert.throws(() => decodeReport(bytes), /encoded data/);
    assert.equal(decodeReport(Buffer.from("\ufeff{}\r\n ")), "\ufeff{}\r\n ");
    assert.deepEqual(await readFile(ref.path), bytes);
  } finally { await evidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

test("runner preserves invalid encoding before parsing and rejects string-only evidence transport", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-report-transport-"));
  const input = { phase: "implement", attempt: 1, runId: "aidev-306-fixture", sandbox: "fixture", expectedHead: "a".repeat(40), originalTicketBaseSha: "a".repeat(40), profile: { provider: "fake", model: "fake", thinking: "low" } } as PhaseInput;
  try {
    for (const transport of [true, false]) {
      const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: [], commands: { byteInput: true, async run() { return { stdout: bytes.toString("utf8"), stderr: "", ...(transport ? { stdoutBytes: bytes } : {}) }; } } });
      await assert.rejects(runner.run(input), asyncError => {
        if (transport) assert.ok(asyncError instanceof InvalidPhaseHandoff);
        else assert.match(String(asyncError), /exact stdout bytes/);
        return true;
      });
      if (!transport) await assert.rejects(runner.prepareReportCorrection(), /byte-capable command transport/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
