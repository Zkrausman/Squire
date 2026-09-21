import assert from "node:assert/strict";
import test from "node:test";
import { parsePiUsage, terminalPiReport, MAX_STREAM_BYTES } from "../src/personal/pi-telemetry-parser.js";
import { piJsonEvents, piJsonStream } from "./helpers/pi-json.js";
const profile = { provider: "openai-codex", model: "fixture", thinking: "medium" } as const;
const encode = (events: any[]) => Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n");
const make = () => piJsonEvents('{"result":"fixture"}', profile);
function mutateMessage(change: (message: any) => void): Buffer {
  const events = make();
  // Same final object appears in message_end, turn_end, agent_end, as in Pi.
  change(events[4].message);
  return encode(events);
}
test("Pi JSON v3 final message usage counts each assistant once, never replay/update costs", () => {
  const parsed = parsePiUsage(encode(make()), profile);
  assert.deepEqual(parsed.tokens, { input: 10, output: 2, cacheRead: 30, cacheWrite: 4 });
  assert.equal(parsed.records, 1);
  assert.equal(parsed.providerCost, null, "Pi's calculated cost is NOT provider-reported billing");
  assert.deepEqual(parsed.diagnostics, ["cost_not_provider_reported"]);
  assert.equal(terminalPiReport(encode(make())).toString(), '{"result":"fixture"}');
  for (const p of [{ ...profile, provider: "anthropic" }, { ...profile, provider: "openai" }]) assert.ok(parsePiUsage(Buffer.from(piJsonStream("{}", p)), p).tokens);
});
test("streamed partial usage is ignored; finalized multi-turn messages reconcile exactly", () => {
  const events = make();
  const update = structuredClone(events[3].message); update.usage.input = 999999;
  events.splice(4, 0, { type: "message_update", message: update, assistantMessageEvent: { type: "text_delta", delta: "private" } });
  assert.equal(parsePiUsage(encode(events), profile).tokens?.input, 10);
  const first = make(), second = make();
  second[3].message.timestamp++; second[4].message.timestamp++;
  first[4].message.stopReason = "toolUse";
  first.splice(6, 1, ...second.slice(2, 6), { type: "agent_end", messages: [first[4].message, second[4].message] });
  assert.equal(parsePiUsage(encode(first), profile).tokens?.input, 20);
});
for (const [name, change] of [
  ["negative", (m: any) => { m.usage.input = -1; }],
  ["fractional", (m: any) => { m.usage.output = 1.5; }],
  ["overflow", (m: any) => { m.usage.cacheRead = Number.MAX_SAFE_INTEGER + 1; }],
  ["bounded", (m: any) => { m.usage.cacheWrite = 1_000_000_000_001; }],
  ["numeric string", (m: any) => { m.usage.output = "2"; }],
  ["mismatched total", (m: any) => { m.usage.totalTokens++; }],
  ["missing field", (m: any) => { delete m.usage.cacheWrite; }],
  ["extra field", (m: any) => { m.usage.secret = "CREDENTIAL SENTINEL"; }],
  ["missing usage", (m: any) => { delete m.usage; }],
  ["malformed cost", (m: any) => { m.usage.cost.input = -1; }],
  ["negative cost total", (m: any) => { m.usage.cost.total = -1; }],
  ["model mismatch", (m: any) => { m.model = "other"; }],
  ["provider mismatch", (m: any) => { m.provider = "other"; }],
  ["API mismatch", (m: any) => { m.api = "other"; }],
  ["aborted", (m: any) => { m.stopReason = "aborted"; }],
  ["error", (m: any) => { m.stopReason = "error"; }],
  ["bad identity", (m: any) => { m.timestamp++; }],
] as const) test(`usage fails closed: ${name}`, () => {
  const result = parsePiUsage(mutateMessage(change), profile);
  assert.equal(result.tokens, null);
  assert.equal(result.providerCost, null);
  assert.ok(result.diagnostics.length > 1);
  assert.ok(!JSON.stringify(result).includes("CREDENTIAL"));
});
test("missing cost does not discard authoritative tokens or fabricate money", () => {
  const result = parsePiUsage(mutateMessage(m => { delete m.usage.cost; }), profile);
  assert.equal(result.tokens?.input, 10); assert.equal(result.providerCost, null);
});
for (const [name, change] of [
  ["duplicate final message", (e: any[]) => e.splice(5, 0, e[4])],
  ["duplicate terminal", (e: any[]) => e.push(e.at(-1))],
  ["reordered", (e: any[]) => { [e[3], e[4]] = [e[4], e[3]]; }],
  ["missing endpoint", (e: any[]) => e.pop()],
  ["missing header", (e: any[]) => e.shift()],
  ["resumed header", (e: any[]) => { e[0].parentSession = "/private"; }],
  ["malformed session id", (e: any[]) => { e[0].id = "secret"; }],
  ["unknown event", (e: any[]) => e.splice(2, 0, { type: "usage", value: "secret" })],
  ["contradictory terminal", (e: any[]) => { e[6].messages = []; }],
] as const) test(`stream ordering/finality fails closed: ${name}`, () => {
  const events = make(); change(events);
  assert.equal(parsePiUsage(encode(events), profile).tokens, null);
});
test("duplicate JSON members, invalid UTF8, invalid JSON, exponent overflow and oversized streams are bounded", () => {
  const raw = encode(make());
  for (const bytes of [Buffer.concat([Buffer.from([255]), raw]), Buffer.from("not-json\n" + raw.toString()), Buffer.from(raw.toString().replace('"input":10', '"input":5,"\\u0069nput":10')), Buffer.from(raw.toString().replaceAll('"input":10', '"input":1e309')), raw.subarray(0, raw.length - 1), Buffer.alloc(MAX_STREAM_BYTES + 1)]) assert.equal(parsePiUsage(bytes, profile).tokens, null);
  assert.deepEqual(parsePiUsage(undefined, profile).diagnostics, ["missing_stream"]);
});
test("accounting faults never change the independently extracted terminal phase report", () => {
  const raw = mutateMessage(m => { m.usage.input = -5; });
  for (const bytes of [raw, Buffer.from(raw.toString().replaceAll('"input":-5', '"input":1,"input":-5')), Buffer.concat([Buffer.from([255, 10]), raw]), Buffer.from("malformed usage line\n" + raw.toString())]) {
    assert.equal(parsePiUsage(bytes, profile).tokens, null);
    assert.equal(terminalPiReport(bytes).toString(), '{"result":"fixture"}');
  }
});
test("unsupported providers are explicit and event private content cannot enter parsed usage", () => {
  const secret = "prompt response ticket source ENV=secret /credential/auth.json token-command\u001b[31m";
  const events = make();
  events[4].message.content = [{ type: "text", text: secret }];
  events[4].message.responseId = secret;
  events[4].message.diagnostics = [{ private: secret }];
  events[0].cwd = secret;
  assert.ok(!JSON.stringify(parsePiUsage(encode(events), profile)).includes("secret"));
  const other = { ...profile, provider: "unsupported" };
  const result = parsePiUsage(Buffer.from(piJsonStream(secret, other)), other);
  assert.equal(result.tokens, null); assert.ok(result.diagnostics.includes("unsupported_provider"));
});

test("a contradictory completion cannot reuse a prior message timestamp or response identity", () => {
  for (const identity of ["timestamp", "responseId"] as const) {
    const first = make(), second = make();
    second[4].message.content = [{ type: "text", text: "changed content" }];
    if (identity === "responseId") {
      first[4].message.responseId = "response-1"; second[4].message.responseId = "response-1";
      second[3].message.timestamp++; second[4].message.timestamp++;
    }
    first.splice(6, 1, ...second.slice(2, 6), { type: "agent_end", messages: [first[4].message, second[4].message] });
    const result = parsePiUsage(encode(first), profile);
    assert.equal(result.tokens, null); assert.ok(result.diagnostics.includes("duplicate_message"));
  }
});
