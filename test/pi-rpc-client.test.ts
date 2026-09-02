import assert from "node:assert/strict"; import test from "node:test";
import { LfJsonlDecoder } from "../src/pi/lf-jsonl-decoder.js"; import { PiRpcClient } from "../src/pi/pi-rpc-client.js"; import { FakePiProcess } from "./support/fake-pi-process.js";
test("LF decoder handles chunked UTF-8, CRLF, EOF, and Unicode separators without false splits", () => { const decoder = new LfJsonlDecoder(); const text = '{"x":"😀\u2028ok\u2029"}\r\n{"y":2}\n{"z":3}'; const bytes = Buffer.from(text); const lines = [...decoder.push(bytes.subarray(0, 8)), ...decoder.push(bytes.subarray(8, 11)), ...decoder.push(bytes.subarray(11)), ...decoder.end()]; assert.deepEqual(lines.map(line => JSON.parse(line)), [{ x: "😀 ok " }, { y: 2 }, { z: 3 }]); });
test("decoder bounds lines and buffers", () => { assert.throws(() => new LfJsonlDecoder(3, 10).push("1234\n"), /line limit/); assert.throws(() => new LfJsonlDecoder(100, 3).push("1234"), /buffer limit/); });
test("RPC correlates deterministic IDs and prompt acceptance is distinct from settlement", async () => { const process = new FakePiProcess("one"); const client = new PiRpcClient(process, { commandTimeoutMs: 100 }); const prompt = client.prompt("go"); assert.match(process.writes[0] ?? "", /squire-00000001/); process.respondToLast("prompt"); await prompt; let settled = false; const waiting = client.waitForSettled(100).then(() => { settled = true; }); assert.equal(settled, false); process.send({ type: "agent_settled" }); await waiting; assert.equal(settled, true); });
test("correlated responses require closed shape, matching command, boolean success, and command data", async () => {
  const malformed = [
    (id: string) => ({ id, type: "response", command: "prompt", success: true, data: { model: null, sessionId: "s", sessionFile: "/x" } }),
    (id: string) => ({ id, type: "response", command: "get_state", success: "yes", data: { model: null, sessionId: "s", sessionFile: "/x" } }),
    (id: string) => ({ id, type: "response", command: "get_state", success: true, data: { model: null, sessionId: "s", sessionFile: "/x" }, attacker: true }),
    (id: string) => ({ id, type: "response", command: "get_state", success: false }),
    (id: string) => ({ id, type: "response", command: "get_state", success: true, data: { sessionId: "s" } })
  ];
  for (const make of malformed) { const process = new FakePiProcess("malformed-response"); const client = new PiRpcClient(process, { commandTimeoutMs: 100 }); const pending = client.getState(); const id = (JSON.parse(process.writes[0]!) as { id: string }).id; process.send(make(id)); await assert.rejects(pending, /response|get_state/); assert.ok(client.failure); assert.notEqual(process.exitCode, null); }
});

test("protocol corruption latches fail-stop state and terminates the generation", async () => { const process = new FakePiProcess("fail-stop"); const client = new PiRpcClient(process, { commandTimeoutMs: 100 }); const failed = new Promise<Error>(resolve => client.once("protocol_error", resolve)); process.stdout.push("{bad}\n"); const error = await failed; assert.match(error.message, /malformed JSON/); assert.notEqual(process.exitCode, null); await assert.rejects(client.getState(), /malformed JSON/); await assert.rejects(client.waitForSettled(), /malformed JSON/); assert.equal(process.writes.length, 0); });

test("malformed stdout, uncorrelated responses, stderr overflow, and premature exits fail", async () => { for (const action of ["bad", "uncorrelated", "stderr", "exit"] as const) { const process = new FakePiProcess(action); const client = new PiRpcClient(process, { commandTimeoutMs: 100, maxStderrBytes: 3 }); const error = new Promise<Error>(resolve => client.once("protocol_error", resolve)); if (action === "bad") process.stdout.push("{bad}\n"); if (action === "uncorrelated") process.send({ id: "wrong", type: "response", command: "x", success: true }); if (action === "stderr") process.stderr.push("1234"); if (action === "exit") process.kill("SIGTERM"); assert.ok(await error); } });

test("diagnostic RPC records and stderr remain observable without controller rewriting", () => {
  const process = new FakePiProcess("diagnostics");
  const client = new PiRpcClient(process);
  const events: unknown[] = [];
  const stderr: string[] = [];
  client.on("event", event => events.push(event));
  client.on("stderr", value => stderr.push(value));
  const warning = { type: "warning", message: "warning: multiline\\nkeep this" };
  const error = { type: "error", message: "error: action required\\nline two" };
  const extensionError = { type: "extension_error", extensionPath: "/trusted/footer.mjs", error: "full failure" };
  process.send(warning);
  process.send(error);
  process.send(extensionError);
  process.stderr.push("stderr line 1\\nstderr line 2\\n");
  assert.deepEqual(events, [warning, error, extensionError]);
  assert.deepEqual(stderr, ["stderr line 1\\nstderr line 2\\n"]);
  assert.equal(client.stderr, "stderr line 1\\nstderr line 2\\n");
});
