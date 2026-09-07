import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { probePlanRpc } from "./support/plan-pi-rpc-probe.js";

const responseLine = `${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: true, data: { ok: true } })}\n`;
const malformedResponseLine = `${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: false, error: "primary RPC failure" })}\n`;
const extensionErrorLine = `${JSON.stringify({ type: "extension_error", extensionPath: "termination-extension.mjs", event: "session_start", error: "termination failure" })}\n`;

function childSpec(script: string): ProcessLaunch {
  return { command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {} };
}

function responseThen(scriptAfterResponse: string): ProcessLaunch {
  return childSpec(`process.stdout.write(${JSON.stringify(responseLine)});${scriptAfterResponse}`);
}

function gracefulChild(onEnd: string): ProcessLaunch {
  return childSpec(`process.stdout.write(${JSON.stringify(responseLine)});process.stdin.resume();process.stdin.on('end',()=>{${onEnd}});`);
}

test("Plan RPC child uses the exact controller runtime and allowlisted environment", async () => {
  const script = `const data = { node: process.execPath, path: process.env.PATH, home: process.env.HOME ?? null, secret: process.env.OPENAI_API_KEY ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, ambientPi: process.env.PI_AMBIENT_BAD ?? null }; process.stdout.write(JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: true, data }) + "\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`;
  const hostilePath = "/tmp/aidev242-hostile-plan-path";
  const result = await probePlanRpc({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: { PATH: hostilePath, OPENAI_API_KEY: "plan-secret-must-not-cross", NODE_OPTIONS: "--require=/tmp/no-such-hook", PI_AMBIENT_BAD: "plan-pi-must-not-cross" } });
  assert.equal(result.state["node"], process.execPath);
  assert.match(String(result.state["path"]), new RegExp(`${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}`));
  assert.doesNotMatch(String(result.state["path"]), new RegExp(hostilePath));
  assert.equal(result.state["home"], null);
  assert.equal(result.state["secret"], null);
  assert.equal(result.state["nodeOptions"], null);
  assert.equal(result.state["ambientPi"], null);
});

test("Plan RPC probe requires controller EOF teardown and an observed zero exit", async () => {
  const result = await probePlanRpc(gracefulChild("process.exit(0);"));
  assert.deepEqual(result.state, { ok: true });
  assert.equal(result.errors, "");
});

test("Plan RPC probe rejects a successful response followed by a spontaneous nonzero exit", async () => {
  await assert.rejects(
    probePlanRpc(responseThen("process.exit(7);")),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code 7/u);
      return true;
    },
  );
});

test("Plan RPC probe rejects termination-time extension failure and nonzero exit", async () => {
  await assert.rejects(
    probePlanRpc(gracefulChild(`process.stdout.write(${JSON.stringify(extensionErrorLine)},()=>process.exit(143));`)),
    error => {
      assert.ok(error instanceof AggregateError);
      const messages = error.errors.map(value => value instanceof Error ? value.message : String(value)).join("\n");
      assert.match(messages, /Plan extension failed to load/u);
      assert.match(messages, /code 143/u);
      return true;
    },
  );
});

test("Plan RPC probe preserves malformed RPC as primary and reports real exit failure", async () => {
  const malformed = childSpec(`process.stdout.write(${JSON.stringify(malformedResponseLine)});process.exit(7);`);
  await assert.rejects(
    probePlanRpc(malformed),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /Plan RPC get_state failed/u);
      const messages = error.errors.map(value => value instanceof Error ? value.message : String(value)).join("\n");
      assert.match(messages, /code 7/u);
      return true;
    },
  );
});

test("Plan RPC probe preserves startup failure and reports its real exit diagnostic", async () => {
  await assert.rejects(
    probePlanRpc({ command: "/tmp/aidev242-no-such-plan-rpc-child", args: [], cwd: process.cwd(), env: {} }),
    error => {
      assert.ok(error instanceof AggregateError);
      const messages = error.errors.map(value => value instanceof Error ? value.message : String(value)).join("\n");
      assert.match(messages, /ENOENT/u);
      assert.match(messages, /exit was not observed before the absolute deadline/u);
      return true;
    },
  );
});
