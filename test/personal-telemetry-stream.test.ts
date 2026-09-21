import assert from "node:assert/strict";
import test from "node:test";
import { decimalUnits, decimalText, parseUsageStream, terminalReport, MAX_STREAM_BYTES } from "../src/personal/telemetry-stream.js";
import { piEvents, piJson, jsonLines, fixtureProfile as profile, fixtureSession as id } from "./helpers/pi-json.js";
const parse = (events: unknown[]) => parseUsageStream(jsonLines(events), id, profile, true);
const usage = (events: any[]) => events[6].message.usage;

test("pinned Pi assistant message_end accounting, cache classes and exact decimal sums", () => {
  const parsed = parse(piEvents("PRIVATE RESPONSE"));
  assert.deepEqual(parsed.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.equal(parsed.recordedCost, "0.1"); assert.equal(parsed.costSource, "pi-recorded");
  assert.equal(parsed.messages, 1); assert.deepEqual(parsed.diagnostics, []);
  assert.equal(terminalReport(piJson("report")), "report");
  assert.equal(decimalText(decimalUnits("0.1") + decimalUnits("0.2")), "0.3");
});
test("absent/invalid cost and missing token dimensions are unknown, never zero/guessed", () => {
  for (const bad of [undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -1 }, { secret: "credential-command" }]) {
    const e = piEvents("private"); usage(e).cost = bad;
    const parsed = parse(e); assert.equal(parsed.tokens.input, 10); assert.equal(parsed.recordedCost, null); assert.equal(parsed.costSource, "unknown"); assert.ok(parsed.diagnostics.length);
  }
  const e = piEvents("private"); delete usage(e).cacheWrite; delete usage(e).totalTokens;
  assert.equal(parse(e).tokens.cacheWrite, null); assert.equal(parse(e).tokens.input, 10);
});
for (const [label, mutate] of Object.entries<Record<string, (e: any[]) => void>[string]>({
  "negative": e => { usage(e).input = -1; }, "fraction": e => { usage(e).output = 1.5; },
  "overflow": e => { usage(e).cacheRead = Number.MAX_SAFE_INTEGER + 1; },
  "infinite": e => { usage(e).input = Infinity; }, "string": e => { usage(e).input = "SECRET"; },
  "usage unknown field": e => { usage(e).SECRET = "env=secret"; },
  "mismatched total": e => { usage(e).totalTokens = 2; },
  "invalid subset": e => { usage(e).reasoning = 21; },
  "provider mismatch": e => { e[6].message.provider = "SECRET_PROVIDER"; },
  "model mismatch": e => { e[6].message.model = "/private/source"; },
  "api mismatch": e => { e[6].message.api = "fake"; },
  "session mismatch": e => { e[0].id = "SECRET_SESSION"; },
  "header extra": e => { e[0].secret = "SECRET"; },
  "assistant schema": e => { e[6].message.secret = "SECRET"; },
  "unfinished message": e => { e[6].message.stopReason = "pending"; },
  "interrupted": e => { e[6].message.stopReason = "aborted"; },
  "out of order": e => { [e[5], e[6]] = [e[6], e[5]]; },
  "duplicate end": e => { e.splice(7, 0, e[6]); },
  "missing end": e => { e.pop(); },
  "agent mismatch": e => { e[8].messages = []; },
  "post-final usage": e => { e.push(e[6]); },
})) test(`untrusted ${label} fails closed with allowlisted diagnostics, no content`, () => {
  const e = piEvents("SECRET_RESPONSE"); mutate(e);
  const parsed = parse(e); assert.equal(parsed.tokens.input, null); assert.equal(parsed.recordedCost, null); assert.ok(parsed.diagnostics.length);
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|private|env=/u);
});

test("duplicate message identity across valid turns cannot double charge", () => {
  const e = piEvents("report"); const message = e[6].message;
  e.splice(8, 0, { type: "turn_start" }, { type: "message_start", message }, { type: "message_end", message }, { type: "turn_end", message, toolResults: [] });
  e.at(-1).messages.push(message);
  assert.deepEqual(parse(e).diagnostics, ["duplicate_message"]);
});
test("tool-loop repeats in turn_end/agent_end and streaming updates are not extra usage records", () => {
  const e = piEvents("report"); const first = { ...structuredClone(e[6].message), stopReason: "toolUse", responseId: "response-tool" };
  e.splice(5, 0, { type: "message_start", message: { ...first, usage: {} } }, { type: "message_update", usage: { input: 999999 }, assistantMessageEvent: { type: "text_delta", delta: "SECRET" } }, { type: "message_end", message: first }, { type: "turn_end", message: first, toolResults: [] }, { type: "turn_start" });
  e.at(-1).messages.splice(1, 0, first);
  const parsed = parse(e); assert.equal(parsed.tokens.input, 20); assert.equal(parsed.messages, 2); assert.equal(parsed.recordedCost, "0.2");
});
test("malformed, unsupported, oversized, partial bytes and transcript-shaped input are never accounting", () => {
  for (const bytes of [Buffer.from("{SECRET\n"), Buffer.from([255, 10]), piJson("report").subarray(0, -1), Buffer.from('report text'), Buffer.from('{"type":"message","message":{"usage":{"input":1}}}\n'), Buffer.alloc(MAX_STREAM_BYTES + 1)]) {
    assert.equal(parseUsageStream(bytes, id, profile, true).tokens.input, null);
  }
  assert.deepEqual(parseUsageStream(piJson("report"), id, { ...profile, provider: "unsupported" }, true).diagnostics, ["unsupported_provider"]);
  assert.equal(parseUsageStream(piJson("report"), id, profile, false).tokens.input, null);
});
test("bad accounting does not change independently established final report", () => {
  const e = piEvents('{"status":"passed"}'); usage(e).input = -1;
  assert.equal(parse(e).tokens.input, null); assert.equal(terminalReport(jsonLines(e)), '{"status":"passed"}');
  const e2 = piEvents("last"); e2.splice(6, 0, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first" }] } });
  assert.equal(terminalReport(jsonLines(e2)), "last");
});

test("noncanonical numbers cannot hide fractional/negative/rounded accounting or duplicate JSON members", () => {
  for (const number of ["10.000000000000000000001", "-0", "1e999", "100000000000000000000000001"]) {
    const bytes = Buffer.from(piJson("PRIVATE").toString().replaceAll('"input":10', `"input":${number}`));
    assert.equal(parseUsageStream(bytes, id, profile, true).tokens.input, null);
  }
  const duplicate = Buffer.from(piJson("PRIVATE").toString().replaceAll('"input":10', '"input":99,"input":10'));
  assert.equal(parseUsageStream(duplicate, id, profile, true).tokens.input, null);
  assert.deepEqual(parseUsageStream(piJson("PRIVATE"), id, { ...profile, provider: "constructor" }, true).diagnostics, ["unsupported_provider"]);
});

test("current stream canonical-number validation is linear over escaped-quote adversaries", { timeout: 10000 }, () => {
  const bytes = piJson('\\"'.repeat(100000));
  assert.equal(parseUsageStream(bytes, id, profile, true).recordedCost, "0.1");
  const rounded = Buffer.from(bytes.toString().replace('"input":10', '"input":10.00000000000000001'));
  assert.deepEqual(parseUsageStream(rounded, id, profile, true).diagnostics, ["invalid_stream"]);
  const duplicate = Buffer.from(bytes.toString().replace('"input":10', '"input":10,"\\u0069nput":10'));
  assert.deepEqual(parseUsageStream(duplicate, id, profile, true).diagnostics, ["invalid_stream"]);
});
