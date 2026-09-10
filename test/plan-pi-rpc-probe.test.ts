import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { BoundedFailureAccumulator, BoundedRedactor } from "./support/pi-child-support.js";
import { probePlanRpc } from "./support/plan-pi-rpc-probe.js";

const planRpcFixtureChild = fileURLToPath(new URL("./support/plan-pi-rpc-fixture-child.js", import.meta.url));
type PlanRpcFixtureMode = "environment" | "graceful-exit" | "spontaneous-exit" | "extension-failure" | "malformed-exit" | "redaction" | "flood" | "late-primary";

function childSpec(mode: PlanRpcFixtureMode, data?: string): ProcessLaunch {
  return { command: process.execPath, args: [planRpcFixtureChild, mode, ...(data === undefined ? [] : [data])], cwd: process.cwd(), env: {} };
}

function responseThen(mode: "spontaneous-exit"): ProcessLaunch {
  return childSpec(mode);
}

function gracefulChild(mode: "graceful-exit" | "extension-failure"): ProcessLaunch {
  return childSpec(mode);
}

test("Plan RPC child uses the exact controller runtime and allowlisted environment", async () => {
  const hostilePath = "/tmp/aidev242-hostile-plan-path";
  const result = await probePlanRpc({ ...childSpec("environment"), env: { PATH: hostilePath, OPENAI_API_KEY: "plan-secret-must-not-cross", NODE_OPTIONS: "--require=/tmp/no-such-hook", PI_AMBIENT_BAD: "plan-pi-must-not-cross" } });
  assert.equal(result.state["node"], process.execPath);
  assert.match(String(result.state["path"]), new RegExp(`${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}`));
  assert.doesNotMatch(String(result.state["path"]), new RegExp(hostilePath));
  assert.equal(result.state["home"], null);
  assert.equal(result.state["secret"], null);
  assert.equal(result.state["nodeOptions"], null);
  assert.equal(result.state["ambientPi"], null);
});

test("Plan RPC probe requires controller EOF teardown and an observed zero exit", async () => {
  const result = await probePlanRpc(gracefulChild("graceful-exit"));
  assert.deepEqual(result.state, { ok: true });
  assert.equal(result.errors, "");
});

test("Plan RPC probe rejects a successful response followed by a spontaneous nonzero exit", async () => {
  await assert.rejects(
    probePlanRpc(responseThen("spontaneous-exit")),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code 7/u);
      return true;
    },
  );
});

test("Plan RPC probe rejects termination-time extension failure and nonzero exit", async () => {
  await assert.rejects(
    probePlanRpc(gracefulChild("extension-failure")),
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
  await assert.rejects(
    probePlanRpc(childSpec("malformed-exit")),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /Plan RPC get_state failed/u);
      const messages = error.errors.map(value => value instanceof Error ? value.message : String(value)).join("\n");
      assert.match(messages, /code 7/u);
      return true;
    },
  );
});

test("Pi redaction preserves lifecycle paths while retaining npm configuration secrets", () => {
  const registry = "https://user:registry-secret@registry.example";
  const redactor = new BoundedRedactor({
    npm_config_registry: registry,
    npm_command: "test",
    npm_lifecycle_event: "test",
    npm_lifecycle_script: "npm test",
  });

  assert.equal(redactor.redact("/ticket/runtime/tmp/test"), "/ticket/runtime/tmp/test");
  const rendered = redactor.redact(`registry response: ${registry}`);
  assert.equal(rendered.includes(registry), false, "npm registry credentials must be redacted without an assignment");
  assert.match(rendered, /<redacted>/u);
});

test("Plan RPC redacts encoded secrets from primary, secondary, aggregate, and inspection paths", async () => {
  const secret = "Plan Encoded/Secret+246813579==";
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const percent = encodeURIComponent(secret);
  const mixedCase = (value: string): string => [...value].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()).join("");
  const forms = [secret, Buffer.from(secret, "utf8").toString("base64"), hex, percent, mixedCase(hex), mixedCase(percent)];
  let thrown: unknown;
  try {
    await probePlanRpc({ ...childSpec("redaction", secret), env: { OPENAI_API_KEY: secret } });
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
  let thrown: unknown;
  try { await probePlanRpc(childSpec("flood")); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof AggregateError);
  assert.ok(thrown.errors.length <= 17, `failure records were not bounded: ${thrown.errors.length}`);
  const messages = thrown.errors.map(error => error instanceof Error ? error.message : String(error)).join("\n");
  assert.ok(Buffer.byteLength(messages, "utf8") <= 16 * 1024 + 512);
  assert.match(messages, /omitted \d+ secondary failure record/u);
});

test("Plan RPC late primary keeps aggregate metadata, stacks, and causes within the total byte budget", async () => {
  let thrown: unknown;
  try { await probePlanRpc(childSpec("late-primary")); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof AggregateError);
  assert.match(String(thrown.errors[0]), /Plan RPC get_state failed/u);
  const publicBytes = [
    thrown.name,
    thrown.message,
    thrown.stack ?? "",
    ...thrown.errors.flatMap(error => error instanceof Error ? [error.name, error.message, error.stack ?? ""] : [String(error)]),
  ].reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  assert.ok(publicBytes <= BoundedFailureAccumulator.MAX_BYTES, `aggregate public bytes exceeded budget: ${publicBytes}`);
  assert.ok(thrown.errors.length <= BoundedFailureAccumulator.MAX_RECORDS + 1);
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
