/** Bounded JSON grammar scanner. The cursor only advances: no token-search regex,
 * backtracking, or repeated suffix scans. JSON.parse only decodes validated tokens.
 * Unpaired surrogates are valid JSON strings (and are preserved as such).
 */
export interface JsonLimits {
  maxBytes?: number; maxDepth?: number; maxItems?: number;
  canonicalNumbers?: boolean; safeIntegers?: boolean;
}
export function scanJson(text: string, options: JsonLimits = {}): { steps: number; items: number } {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const maxDepth = options.maxDepth ?? 100;
  const maxItems = options.maxItems ?? 200_000;
  if (![maxBytes, maxDepth, maxItems].every(n => Number.isSafeInteger(n) && n > 0) || maxDepth > 100) throw new Error("invalid JSON limits");
  if (text.length > maxBytes || Buffer.byteLength(text) > maxBytes) throw new Error("JSON byte bound exceeded");
  let i = 0, items = 0;
  const fail = (): never => { throw new Error("invalid or ambiguous bounded JSON"); };
  const advance = () => { i++; };
  const space = () => { while (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t") advance(); };
  const digit = () => i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57;
  function string(): string {
    const start = i; if (text[i] !== '"') fail(); advance();
    while (i < text.length) {
      const c = text.charCodeAt(i); advance();
      if (c === 34) return text.slice(start, i);
      if (c < 32) fail();
      if (c === 92) {
        const escape = text[i]; advance();
        if (escape === "u") {
          for (let j = 0; j < 4; j++) {
            const h = text.charCodeAt(i);
            if (!((h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102))) fail();
            advance();
          }
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) fail();
      }
    }
    return fail();
  }
  function number() {
    const start = i;
    if (text[i] === "-") advance();
    if (text[i] === "0") advance();
    else { if (!digit() || text[i] === "0") fail(); while (digit()) advance(); }
    if (text[i] === ".") { advance(); if (!digit()) fail(); while (digit()) advance(); }
    if (text[i] === "e" || text[i] === "E") { advance(); if (text[i] === "+" || text[i] === "-") advance(); if (!digit()) fail(); while (digit()) advance(); }
    const token = text.slice(start, i), n = Number(token);
    if (options.canonicalNumbers && JSON.stringify(n) !== token) fail();
    if (options.safeIntegers && (!Number.isSafeInteger(n) || JSON.stringify(n) !== token)) fail();
  }
  function value(depth: number): void {
    if (++items > maxItems) fail();
    space(); const c = text[i];
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      if (depth >= maxDepth) fail(); advance(); space();
      const object = c === "{", end = object ? "}" : "]", keys = new Set<string>();
      if (text[i] === end) { advance(); return; }
      while (true) {
        if (object) {
          const key = JSON.parse(string()) as string;
          if (keys.has(key)) throw new Error("duplicate JSON member makes provenance ambiguous");
          keys.add(key); space(); if (text[i] !== ":") fail(); advance();
        }
        value(depth + 1); space();
        if (text[i] === end) { advance(); return; }
        if (text[i] !== ",") fail(); advance(); space();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) { i += literal.length; return; }
    }
    number();
  }
  value(0); space(); if (i !== text.length) fail();
  // Each successful advance consumes exactly one code unit. Token decoding and
  // numeric conversion cover disjoint spans; total auxiliary work is O(bytes).
  return { steps: i, items };
}
export function parseBoundedJson(text: string, options: JsonLimits = {}): unknown {
  scanJson(text, options); return JSON.parse(text) as unknown;
}
/** Intended for bounded, schema-validated JSON values, never arbitrary objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("not canonical JSON data");
}
