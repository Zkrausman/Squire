import test from "node:test";
import assert from "node:assert/strict";
import { scanJson, parseBoundedJson, canonicalJson } from "../src/personal/bounded-json.js";
import { rejectAmbiguousJson } from "../src/personal/report-correction.js";

test("bounded grammar agrees with JSON strings, Unicode, numbers and delimiters", () => {
  for (const value of [null, true, false, 1, -2, 0.1, 1e-7, 1e21, "text😀\ud800\udfff", { 'a"\\': ["\b\t\n\r", {}, []] }]) {
    const text = JSON.stringify(value); assert.deepEqual(parseBoundedJson(text, { canonicalNumbers: true }), value); assert.equal(scanJson(text).steps, text.length);
  }
  assert.equal(parseBoundedJson('"\\uD83D\\uDE00"'), "😀");
  assert.equal(parseBoundedJson('"\\uD800"'), "\ud800"); // JSON permits isolated UTF-16 units.
  assert.equal(canonicalJson({ z: 3, a: { z: [], a: "😀" } }), '{"a":{"a":"😀","z":[]},"z":3}');
});
test("rejects decoded duplicate keys including escapes, without confusing string content", () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":[{"a":1,"a":2}]}', '{"😀":1,"\\ud83d\\ude00":2}']) {
    assert.throws(() => scanJson(text), /duplicate/); assert.throws(() => rejectAmbiguousJson(text), /duplicate/);
  }
  assert.doesNotThrow(() => scanJson('{"x":[{"a":1},{"a":2}],"escaped":"a\\\":1,a\\\":2"}'));
});
test("malformed and truncated JSON fails closed at each grammar boundary", () => {
  for (const text of ["", " ", "[", "{", '{"x"}', '{x:1}', '{"x":}', '{"x":1,}', '[1,]', '[1 2]', '{}{}', '[}', '"', '"\\', '"\\q"', '"\\u12"', '"\\uZZZZ"', '"\n"', '+1', '01', '-01', '-','1.', '.1', '1e', '1e+', 'NaN', 'Infinity', 'truex', '\ufeff{}']) assert.throws(() => scanJson(text), text);
  for (const text of ['-0', '1.0', '1E3', '1e3', '9007199254740993', '1.00000000000000001', '1e999']) assert.throws(() => scanJson(text, { canonicalNumbers: true }), text);
  for (const text of ['0.1', '1e+21', '9007199254740992']) assert.throws(() => scanJson(text, { safeIntegers: true }));
});
test("byte, depth and item ceilings are checked deterministically", () => {
  assert.throws(() => scanJson('"😀"', { maxBytes: 5 }));
  assert.doesNotThrow(() => scanJson('"😀"', { maxBytes: 6 }));
  assert.throws(() => scanJson('[[[]]]', { maxDepth: 2 }));
  assert.throws(() => scanJson('[1,2]', { maxItems: 2 }));
  assert.throws(() => scanJson('[]', { maxDepth: 101 }));
  assert.throws(() => scanJson('['.repeat(10000)));
});
test("escaped-quote/backslash adversaries consume exactly one cursor step per code unit", { timeout: 5000 }, () => {
  for (const count of [1000, 10000, 100000, 500000]) {
    const text = JSON.stringify({ x: '\\"'.repeat(count), y: 123 });
    assert.equal(scanJson(text, { canonicalNumbers: true }).steps, text.length);
    assert.doesNotThrow(() => rejectAmbiguousJson(text));
    assert.throws(() => scanJson(text.slice(0, -2), { canonicalNumbers: true }));
    assert.throws(() => scanJson('"' + '\\"'.repeat(count)));
  }
});
