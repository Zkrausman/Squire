/** Bounded forward-only JSON parser. No regex tokenization or speculative scans.
 * Each UTF-16 code unit is consumed once; decoding strings adds linear work. */
export interface JsonLimits { maxBytes?: number; maxDepth?: number; maxItems?: number; canonicalNumbers?: boolean; }
export interface JsonScan { value: unknown; steps: number; items: number; }
export class JsonScanError extends Error {
  constructor(message: string, readonly steps: number, readonly items: number) { super(message); }
}
export function scanJson(input: string | Buffer, limits: JsonLimits = {}): JsonScan {
  const maxBytes = limits.maxBytes ?? 8 * 1024 * 1024;
  const maxDepth = limits.maxDepth ?? 100, maxItems = limits.maxItems ?? 200_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 100 || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 200_000) throw new Error("invalid JSON limits");
  if (Buffer.byteLength(input) > maxBytes) throw new Error("JSON byte bound");
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  let pos = 0, items = 0;
  const fail = (message = "invalid bounded JSON"): never => { throw new JsonScanError(message, pos, items); };
  const take = (): string => { if (pos >= text.length) return fail(); return text[pos++]!; };
  const white = () => { while (text[pos] === " " || text[pos] === "\n" || text[pos] === "\r" || text[pos] === "\t") take(); };
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const string = (): string => {
    const start = pos;
    if (take() !== '"') fail();
    while (true) {
      const c = take();
      if (c === '"') break;
      if (c.charCodeAt(0) < 32) fail();
      if (c === "\\") {
        const e = take();
        if (e === "u") for (let j = 0; j < 4; j++) { const h = take(); if (!(digit(h) || h >= "a" && h <= "f" || h >= "A" && h <= "F")) fail(); }
        else if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(e)) fail();
      }
    }
    const result = JSON.parse(text.slice(start, pos)) as string;
    for (let j = 0; j < result.length; j++) {
      const c = result.charCodeAt(j);
      if (c >= 0xd800 && c <= 0xdbff) { const next = result.charCodeAt(++j); if (!(next >= 0xdc00 && next <= 0xdfff)) fail(); }
      else if (c >= 0xdc00 && c <= 0xdfff) fail();
    }
    return result;
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth || ++items > maxItems) fail();
    white();
    if (text[pos] === '"') return string();
    if (text[pos] === "{" || text[pos] === "[") {
      const object = take() === "{";
      const end = object ? "}" : "]";
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = [], keys = new Set<string>();
      white();
      if (text[pos] === end) { take(); return object ? result : array; }
      while (true) {
        white();
        if (object) {
          const key = string();
          if (keys.has(key)) fail("duplicate JSON member makes provenance ambiguous");
          keys.add(key); white(); if (take() !== ":") fail();
          result[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        white(); const next = take();
        if (next === end) break;
        if (next !== ",") fail();
      }
      return object ? result : array;
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text[pos] === literal[0]) { for (const c of literal) if (take() !== c) fail(); return result; }
    }
    const start = pos;
    if (text[pos] === "-") take();
    if (text[pos] === "0") take();
    else { if (!digit(text[pos]) || text[pos] === "0") fail(); while (digit(text[pos])) take(); }
    if (text[pos] === ".") { take(); if (!digit(text[pos])) fail(); while (digit(text[pos])) take(); }
    if (text[pos] === "e" || text[pos] === "E") { take(); if (text[pos] === "+" || text[pos] === "-") take(); if (!digit(text[pos])) fail(); while (digit(text[pos])) take(); }
    const lexeme = text.slice(start, pos), number = Number(lexeme);
    if (!Number.isFinite(number) || (limits.canonicalNumbers && JSON.stringify(number) !== lexeme)) fail();
    return number;
  };
  const result = value(0); white(); if (pos !== text.length) fail();
  return { value: result, steps: pos, items };
}
export function parseBoundedJson(input: string | Buffer, limits: JsonLimits = {}): unknown { return scanJson(input, limits).value; }
/** Canonical manifest numbers are safe integers; fractional fields use decimal strings. */
export function canonicalJson(value: unknown): string {
  let items = 0, bytes = 0;
  const charge = (n: number) => { bytes += n; if (bytes > 8 * 1024 * 1024) throw new Error("canonical JSON byte bound"); };
  const scalar = (text: string) => { charge(Buffer.byteLength(text)); return text; };
  const encode = (v: unknown, depth: number): string => {
    if (depth > 100 || ++items > 200_000) throw new Error("canonical JSON bound");
    if (v === null || typeof v === "boolean") return scalar(JSON.stringify(v));
    if (typeof v === "string") { const text = JSON.stringify(v); scanJson(text); return scalar(text); }
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0)) return scalar(String(v));
    if (Array.isArray(v)) {
      if (Object.getOwnPropertySymbols(v).length || Object.keys(v).length !== v.length || !Object.keys(v).every((k, i) => k === String(i))) throw new Error("non-JSON array");
      charge(2 + Math.max(0, v.length - 1));
      return `[${v.map(x => encode(x, depth + 1)).join(",")}]`;
    }
    if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      if (Object.getOwnPropertySymbols(v).length || Object.values(Object.getOwnPropertyDescriptors(v)).some(d => !Object.hasOwn(d, "value") || !d.enumerable)) throw new Error("non-JSON object");
      charge(2 + Math.max(0, Object.keys(v).length - 1) + Object.keys(v).length);
      return `{${Object.keys(v).sort().map(k => `${encode(k, depth + 1)}:${encode((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
    }
    throw new Error("unsupported canonical JSON value");
  };
  const text = encode(value, 0);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("canonical JSON byte bound");
  return text;
}
