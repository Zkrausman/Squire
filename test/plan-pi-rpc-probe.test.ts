import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { probePlanRpc } from "./support/plan-pi-rpc-probe.js";

const responseLine = `${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: true, data: { ok: true } })}\n`;

function childSpec(script: string): ProcessLaunch {
  return { command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {} };
}

function responseThen(scriptAfterResponse: string): ProcessLaunch {
  return childSpec(`process.stdout.write(${JSON.stringify(responseLine)});${scriptAfterResponse}`);
}

test("Plan RPC probe accepts a response only after parent-owned termination is observed", async () => {
  const result = await probePlanRpc(responseThen("process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);"));
  assert.deepEqual(result.state, { ok: true });
  assert.equal(result.errors, "");
});

test("Plan RPC probe rejects a successful response followed by a natural nonzero exit", async () => {
  await assert.rejects(
    probePlanRpc(responseThen("process.exit(7);")),
    /Plan RPC child exited before parent cleanup: code 7/u,
  );
});

test("Plan RPC probe preserves primary failure while reporting cleanup failure", async () => {
  const primary = responseThen("process.exit(9);");
  await assert.rejects(
    probePlanRpc(primary, { terminateChild: async () => { throw new Error("cleanup sentinel"); } }),
    error => {
      assert.ok(error instanceof AggregateError);
      const messages = error.errors.map(value => value instanceof Error ? value.message : String(value)).join("\n");
      assert.match(messages, /code 9/u);
      assert.match(messages, /cleanup sentinel/u);
      return true;
    },
  );
});
