import assert from "node:assert/strict";
import { inspect } from "node:util";
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

test("Plan RPC redacts encoded secrets from primary, secondary, aggregate, and inspection paths", async () => {
  const secret = "Plan Encoded/Secret+246813579==";
  const forms = [secret, Buffer.from(secret, "utf8").toString("base64"), Buffer.from(secret, "utf8").toString("hex"), encodeURIComponent(secret)];
  const extensionLine = JSON.stringify({ type: "extension_error", extensionPath: "secret-extension.mjs", error: forms.join(" | ") });
  const script = `process.stdout.write(${JSON.stringify(responseLine)}); process.stdout.write(${JSON.stringify(extensionLine + "\n")}); process.exit(7);`;
  let thrown: unknown;
  try {
    await probePlanRpc({ ...childSpec(script), env: { OPENAI_API_KEY: secret } });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AggregateError);
  const surfaces = [
    thrown.message,
    JSON.stringify(thrown),
    inspect(thrown, { depth: 8, showHidden: true }),
    thrown.errors.map(error => error instanceof Error ? `${error.name}:${error.message}` : String(error)).join("\n"),
  ].join("\n");
  for (const form of forms) assert.equal(surfaces.includes(form), false, `Plan secret form leaked: ${form}`);
  assert.match(surfaces, /Plan extension failed to load/u);
  assert.ok(thrown.errors.length <= 17);
});

test("Plan RPC retains bounded UTF-8 tails and failure records under protocol flood", async () => {
  const lines = 5_000;
  const script = `process.stdout.write(${JSON.stringify(responseLine)}, () => { let index = 0; const write = () => { while (index < ${lines}) { if (!process.stdout.write(JSON.stringify({ type: "extension_error", error: "flood-" + index + "-€" }) + "\\\\n")) return process.stdout.once("drain", write); index += 1; } process.stderr.write("€".repeat(10000), () => process.exit(7)); }; write(); });`;
  let thrown: unknown;
  try { await probePlanRpc(childSpec(script)); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof AggregateError);
  assert.ok(thrown.errors.length <= 17, `failure records were not bounded: ${thrown.errors.length}`);
  const messages = thrown.errors.map(error => error instanceof Error ? error.message : String(error)).join("\n");
  assert.ok(Buffer.byteLength(messages, "utf8") <= 16 * 1024 + 512);
  assert.match(messages, /omitted \d+ secondary failure record/u);
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
