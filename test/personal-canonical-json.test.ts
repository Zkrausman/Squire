import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, parseBoundedJson, scanJson, JsonScanError } from "../src/personal/canonical-json.js";
import { rejectAmbiguousJson } from "../src/personal/report-correction.js";

test("bounded scanner consumes escaped quotes and backslashes once, including adversarial suffixes", () => {
  for (const length of [1000, 10_000, 100_000, 500_000]) {
    const text = JSON.stringify({ value: ('\\"\\\\').repeat(length) });
    const result = scanJson(text);
    assert.equal(result.steps, text.length); assert.equal(result.items, 2);
    rejectAmbiguousJson(text);
    for (const malformed of [text.slice(0, -2), '"' + '\\"'.repeat(length), '"' + '\\\\'.repeat(length)]) {
      assert.throws(() => scanJson(malformed), (error: unknown) => {
        assert.ok(error instanceof JsonScanError); assert.ok(error.steps <= malformed.length); return true;
      });
    }
  }
});
test("scanner grammar, decoded duplicate keys, Unicode, numbers and bounded errors", () => {
  const invalid = ['{"x":1,"\\u0078":2}', '{"outer":{"x":1,"x":2}}', '[1,]', '{"a":1,}', '[true false]', '{"a" 1}', '"\\u123"', '"\\x"', '"\n"', '"\\ud800"', '"\\udc00"', '"\\ud800x"', '01', '-', '1.', '.1', '1e', '1e+', '+1', 'NaN', 'Infinity', '1e999', 'true null', '\ufeff{}', '{', '[', 'nul'];
  for (const value of invalid) assert.throws(() => parseBoundedJson(value), value);
  for (const value of ['1.0', '-0', '1E2', '1e02', '9007199254740993', '1.0000000000000001']) assert.throws(() => parseBoundedJson(value, { canonicalNumbers: true }), value);
  for (const value of ['0', '-1', '0.1', '1e-7', '1e+21', 'true', 'null', '[{},[],false]', '{"a":1,"b":{"a":2}}', '"\\ud83d\\ude00"', '"😀"']) assert.doesNotThrow(() => parseBoundedJson(value, { canonicalNumbers: true }));
  for (const limits of [{ maxBytes: Infinity }, { maxDepth: 101 }, { maxItems: 0 }]) assert.throws(() => parseBoundedJson("{}", limits));
  assert.throws(() => parseBoundedJson(Buffer.from([0xff])));
  assert.throws(() => parseBoundedJson('[0,1]', { maxItems: 2 }));
  assert.throws(() => parseBoundedJson('[[[0]]]', { maxDepth: 2 }));
  assert.throws(() => parseBoundedJson('"😀"', { maxBytes: 5 }));
  assert.equal(scanJson(' \n[1, 2]\t').steps, 9);
});
test("canonical bytes sort all keys lexically, preserve arrays and reject non-JSON/nonsafe fields", () => {
  assert.equal(canonicalJson({ z: [2, 1], "2": "b", "10": "a", a: { b: 2, a: 1 } }), '{"10":"a","2":"b","a":{"a":1,"b":2},"z":[2,1]}');
  for (const value of [1.5, NaN, Infinity, -0, 9007199254740992, 1n, undefined, { x: undefined }, new Date(), '\ud800', Array(2), { [Symbol('private')]: 1 }]) assert.throws(() => canonicalJson(value));
  assert.equal(canonicalJson(parseBoundedJson('{"__proto__":{"polluted":true}}')), '{"__proto__":{"polluted":true}}');
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});
