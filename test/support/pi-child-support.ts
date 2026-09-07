import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ProcessLaunch } from "../../src/pi/pi-process.js";

export const PI_CHILD_STDERR_LIMIT_BYTES = 8_192;
export const PI_CHILD_OUTPUT_LIMIT_BYTES = 65_536;
export const PI_CHILD_DIAGNOSTIC_LIMIT_BYTES = 16_384;

const REDACTION_PATTERN_BUDGET_BYTES = 256 * 1024;
const MAX_PATTERN_BYTES = 4_096;
const STREAM_CHUNK_BYTES = 8_192;
const MAX_SAFE_ARGUMENTS = 64;
const CONTROLLED_ENV_KEYS = [
  "HOME",
  "WIKI_HOME",
  "TERM",
  "PI_CODING_AGENT_DIR",
  "PI_SKIP_VERSION_CHECK",
  "SQUIRE_PLAN_FILESYSTEM_POLICY_SHA256",
  "SQUIRE_PLAN_WORKSPACE_ROOT",
  "SQUIRE_PLAN_WIKI_ROOT",
  "SQUIRE_TICKET_ROOT",
  "SQUIRE_PLAN_RUN_ID",
  "SQUIRE_PLAN_HANDOFF_ID",
  "SQUIRE_PLAN_ATTEMPT",
  "SQUIRE_PLAN_SESSION_ID",
  "SQUIRE_PLAN_INPUT_HEAD",
  "SQUIRE_PLAN_INPUT_PATH",
  "SQUIRE_PLAN_INPUT_SHA256",
  "SQUIRE_PLAN_TICKET_IDENTIFIER",
  "SQUIRE_PLAN_COMPLETED_AT",
  "SQUIRE_PLAN_ALLOWED_VALIDATION_COMMAND_IDS",
  "SQUIRE_PLAN_REQUIRED_VALIDATION_COMMAND_IDS",
] as const;

const SENSITIVE_NAME = /(?:key|token|secret|password|credential|authorization|cookie|proxy|cert|session|ssh|npm|node_options|node_path|extra_ca)/iu;
const SENSITIVE_ASSIGNMENT = /((?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PROXY|CERT|SESSION|SSH|NODE_OPTIONS|NODE_PATH)[A-Z0-9_]*|api[-_]?key|access[-_]?token|password)\s*["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gu;

export interface PreparedPiChildLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

function utf8ByteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

function utf8Prefix(value: string, limitBytes: number): string {
  if (limitBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limitBytes) return value;
  let start = 0;
  let result = encoded.subarray(0, limitBytes).toString("utf8");
  while (utf8ByteLength(result) > limitBytes && start < limitBytes) {
    start += 1;
    result = encoded.subarray(start, limitBytes).toString("utf8");
  }
  return result;
}

function utf8Suffix(value: string, limitBytes: number): string {
  if (limitBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limitBytes) return value;
  let start = Math.max(0, encoded.length - limitBytes);
  let result = encoded.subarray(start).toString("utf8");
  while (utf8ByteLength(result) > limitBytes && start < encoded.length) {
    start += 1;
    result = encoded.subarray(start).toString("utf8");
  }
  return result;
}

export function truncateUtf8(value: string, limitBytes: number): string {
  const suffix = "…[truncated]";
  if (utf8ByteLength(value) <= limitBytes) return value;
  return `${utf8Prefix(value, Math.max(0, limitBytes - utf8ByteLength(suffix)))}${suffix}`;
}

function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const base64Url = bytes.toString("base64url");
  const encodedUrl = encodeURIComponent(value);
  return [
    value,
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    base64,
    base64.replace(/=+$/u, ""),
    base64Url,
    encodedUrl,
    encodedUrl.replace(/%[0-9A-F]{2}/gu, match => match.toLowerCase()),
    encodedUrl.replace(/%20/gu, "+"),
  ];
}

/**
 * A bounded, fail-closed redaction set. If the known-secret set cannot fit its
 * fixed budget, rendering returns a marker rather than silently dropping a
 * value and risking a leak.
 */
export class BoundedRedactor {
  readonly #patterns: readonly string[];
  readonly #overflow: boolean;
  readonly #maxPatternChars: number;

  constructor(...records: ReadonlyArray<Readonly<Record<string, string | undefined>>>) {
    const patterns = new Set<string>();
    let bytes = 0;
    let overflow = false;
    let maxPatternChars = 1;
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (!SENSITIVE_NAME.test(key) || value === undefined || value.length < 4) continue;
        for (const form of encodedForms(value)) {
          const formBytes = utf8ByteLength(form);
          if (formBytes > MAX_PATTERN_BYTES || bytes + formBytes > REDACTION_PATTERN_BUDGET_BYTES) {
            overflow = true;
            continue;
          }
          if (patterns.has(form)) continue;
          patterns.add(form);
          bytes += formBytes;
          maxPatternChars = Math.max(maxPatternChars, form.length);
        }
      }
    }
    this.#patterns = [...patterns].sort((left, right) => right.length - left.length);
    this.#overflow = overflow;
    this.#maxPatternChars = Math.min(MAX_PATTERN_BYTES, maxPatternChars);
  }

  get overflow(): boolean { return this.#overflow; }
  get maxPatternChars(): number { return this.#maxPatternChars; }

  redact(value: string): string {
    if (this.#overflow) return "<redaction-set-overflow>";
    let redacted = value;
    for (const pattern of this.#patterns) redacted = redacted.replaceAll(pattern, "<redacted>");
    redacted = redacted.replace(SENSITIVE_ASSIGNMENT, "$1<redacted>");
    redacted = redacted.replace(/(Bearer\s+)[^\s,;]+/giu, "$1<redacted>");
    return redacted;
  }

  /** Render only the portion that cannot become a known secret on a later chunk. */
  preview(value: string): { value: string; withheld: boolean } {
    if (this.#overflow) return { value: "", withheld: value.length > 0 };
    let withheldChars = 0;
    for (const pattern of this.#patterns) {
      const maximum = Math.min(pattern.length - 1, value.length);
      for (let length = maximum; length > withheldChars; length -= 1) {
        if (value.endsWith(pattern.slice(0, length))) {
          withheldChars = length;
          break;
        }
      }
    }
    return { value: this.redact(value.slice(0, value.length - withheldChars)), withheld: withheldChars > 0 };
  }

  /** Find a known encoded secret that would cross a prospective emit boundary. */
  crossingStart(value: string, boundary: number): number | undefined {
    if (this.#overflow) return 0;
    let earliest: number | undefined;
    for (const pattern of this.#patterns) {
      let start = value.indexOf(pattern);
      while (start >= 0) {
        if (start < boundary && start + pattern.length > boundary && (earliest === undefined || start < earliest)) earliest = start;
        start = value.indexOf(pattern, start + 1);
      }
    }
    return earliest;
  }
}

class ByteTail {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #droppedBytes = 0;

  constructor(readonly limitBytes: number) {}

  append(value: string): void {
    const incoming = Buffer.from(value, "utf8");
    if (incoming.length === 0) return;
    if (incoming.length >= this.limitBytes) {
      this.#droppedBytes += this.#bytes + incoming.length - this.limitBytes;
      this.#chunks = [Buffer.from(incoming.subarray(incoming.length - this.limitBytes))];
      this.#bytes = this.limitBytes;
      return;
    }
    this.#chunks.push(Buffer.from(incoming));
    this.#bytes += incoming.length;
    while (this.#bytes > this.limitBytes && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      const remove = Math.min(first.length, this.#bytes - this.limitBytes);
      if (remove === first.length) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(remove);
      this.#bytes -= remove;
      this.#droppedBytes += remove;
    }
  }

  get droppedBytes(): number { return this.#droppedBytes; }
  get bytes(): number { return this.#bytes; }
  toString(): string { return Buffer.concat(this.#chunks, this.#bytes).toString("utf8"); }
}

/** One streaming accumulator for bounded, encoded-secret-redacted text. */
export class BoundedRedactionAccumulator {
  readonly #tail: ByteTail;
  readonly #decoder = new StringDecoder("utf8");
  readonly #redactor: BoundedRedactor;
  readonly #holdChars: number;
  #pending = "";
  #finished = false;
  #chunks = 0;
  #totalInputBytes = 0;

  constructor(readonly limitBytes: number, redactor: BoundedRedactor) {
    this.#tail = new ByteTail(limitBytes);
    this.#redactor = redactor;
    this.#holdChars = Math.max(1, redactor.maxPatternChars - 1);
  }

  append(value: string | Buffer): void {
    if (this.#finished) throw new Error("bounded redaction accumulator is already finished");
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    this.#totalInputBytes += input.length;
    this.#chunks += 1;
    for (let offset = 0; offset < input.length; offset += STREAM_CHUNK_BYTES) {
      const text = this.#decoder.write(input.subarray(offset, Math.min(input.length, offset + STREAM_CHUNK_BYTES)));
      if (text) this.#appendDecoded(text);
    }
  }

  #appendDecoded(text: string): void {
    if (this.#redactor.overflow) return;
    this.#pending += text;
    const boundary = Math.max(0, this.#pending.length - this.#holdChars);
    if (boundary <= 0) return;
    const crossing = this.#redactor.crossingStart(this.#pending, boundary);
    const emitUntil = crossing === undefined ? boundary : crossing;
    if (emitUntil <= 0) return;
    this.#tail.append(this.#redactor.redact(this.#pending.slice(0, emitUntil)));
    this.#pending = this.#pending.slice(emitUntil);
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    const remainder = this.#decoder.end();
    this.#pending += remainder;
    if (this.#redactor.overflow) return;
    if (this.#pending) this.#tail.append(this.#redactor.redact(this.#pending));
    this.#pending = "";
  }

  get totalInputBytes(): number { return this.#totalInputBytes; }
  get droppedBytes(): number { return this.#tail.droppedBytes; }
  get retainedBytes(): number { return this.#tail.bytes; }
  get chunkCount(): number { return this.#chunks; }
  get truncated(): boolean { return this.#redactor.overflow || this.#tail.droppedBytes > 0; }

  #render(extra = "", pendingWithheld = false): string {
    const tail = `${this.#tail.toString()}${extra}`;
    const extraDroppedBytes = Math.max(0, utf8ByteLength(tail) - this.limitBytes);
    const droppedBytes = this.#tail.droppedBytes + extraDroppedBytes;
    const needsMarker = this.truncated || pendingWithheld || extraDroppedBytes > 0;
    if (!needsMarker) return utf8Suffix(tail, this.limitBytes);
    const marker = this.#redactor.overflow
      ? `…[redaction-set-overflow inputBytes=${this.#totalInputBytes} droppedBytes=${droppedBytes} chunks=${this.#chunks}]`
      : pendingWithheld && droppedBytes === 0
        ? `…[pending-redaction inputBytes=${this.#totalInputBytes} chunks=${this.#chunks}]`
        : `…[truncated inputBytes=${this.#totalInputBytes} droppedBytes=${droppedBytes} chunks=${this.#chunks}]`;
    const available = Math.max(0, this.limitBytes - utf8ByteLength(marker));
    return `${marker}${utf8Suffix(tail, available)}`;
  }

  /** A bounded live view that does not close the accumulator or decoder. */
  snapshot(): string {
    const preview = this.#redactor.preview(this.#pending);
    return this.#render(preview.value, preview.withheld);
  }

  text(): string {
    this.finish();
    return this.#render();
  }
}

export function sanitizeError(error: unknown, redactor: BoundedRedactor, limitBytes = 4_096): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const safe = new Error(truncateUtf8(redactor.redact(source.message), limitBytes));
  safe.name = truncateUtf8(redactor.redact(source.name), 128);
  const code = (source as NodeJS.ErrnoException).code;
  if (typeof code === "string") Object.defineProperty(safe, "code", { value: code, enumerable: true });
  return Object.freeze(safe);
}

export type FailureCategory = "protocol" | "startup" | "lifecycle" | "cleanup";
export type SanitizedFailureRecord = Readonly<{ error: Error; category: FailureCategory }>;

/**
 * Fixed-record/fixed-byte failure retention for Plan and other child probes.
 * The first protocol/startup failure remains primary; secondary causes are
 * sanitized before storage and overflow becomes an explicit summary record.
 */
export class BoundedFailureAccumulator {
  static readonly MAX_RECORDS = 16;
  static readonly MAX_BYTES = 16 * 1024;
  readonly #records: SanitizedFailureRecord[] = [];
  #bytes = 0;
  #droppedRecords = 0;
  #droppedBytes = 0;

  add(value: unknown, category: FailureCategory, redactor: BoundedRedactor): Error {
    const error = sanitizeError(value, redactor);
    const bytes = utf8ByteLength(error.message);
    const isPrimary = category === "protocol" || category === "startup";
    const primaryIndex = this.#records.findIndex(record => record.category === "protocol" || record.category === "startup");
    if (isPrimary && primaryIndex === -1 && (this.#records.length >= BoundedFailureAccumulator.MAX_RECORDS || this.#bytes + bytes > BoundedFailureAccumulator.MAX_BYTES)) {
      const removed = this.#records.pop();
      if (removed) {
        this.#bytes -= utf8ByteLength(removed.error.message);
        this.#droppedBytes += utf8ByteLength(removed.error.message);
      }
      this.#records.unshift({ error, category });
      this.#bytes += bytes;
      this.#droppedRecords += 1;
      return error;
    }
    if (this.#records.length >= BoundedFailureAccumulator.MAX_RECORDS || this.#bytes + bytes > BoundedFailureAccumulator.MAX_BYTES) {
      this.#droppedRecords += 1;
      this.#droppedBytes += bytes;
      return error;
    }
    this.#records.push({ error, category });
    this.#bytes += bytes;
    return error;
  }

  get length(): number { return this.#records.length; }
  get droppedRecords(): number { return this.#droppedRecords; }
  get droppedBytes(): number { return this.#droppedBytes; }
  hasAny(): boolean { return this.#records.length > 0 || this.#droppedRecords > 0; }
  hasCategory(category: FailureCategory): boolean { return this.#records.some(record => record.category === category); }

  toError(): Error | undefined {
    if (!this.hasAny()) return undefined;
    const primaryIndex = this.#records.findIndex(record => record.category === "protocol" || record.category === "startup");
    const ordered = primaryIndex < 0
      ? [...this.#records]
      : [this.#records[primaryIndex]!, ...this.#records.slice(0, primaryIndex), ...this.#records.slice(primaryIndex + 1)];
    const errors = ordered.map(record => record.error);
    if (this.#droppedRecords > 0) {
      errors.push(Object.freeze(new Error(`Plan RPC omitted ${this.#droppedRecords} secondary failure record(s) and ${this.#droppedBytes} failure byte(s) after the bounded diagnostic budget`)));
    }
    if (errors.length === 1) return errors[0]!;
    return new AggregateError(errors, "Plan RPC probe failed with primary and bounded secondary diagnostics");
  }
}

export function sanitizeLaunch(spec: ProcessLaunch, environment: Readonly<Record<string, string>>, redactor: BoundedRedactor): ProcessLaunch {
  return Object.freeze({
    command: truncateUtf8(redactor.redact(spec.command), 512),
    args: Object.freeze([
      ...spec.args.slice(0, MAX_SAFE_ARGUMENTS).map(value => truncateUtf8(redactor.redact(value), 512)),
      ...(spec.args.length > MAX_SAFE_ARGUMENTS ? [`<${spec.args.length - MAX_SAFE_ARGUMENTS} arguments omitted>`] : []),
    ]),
    // cwd is controller-owned location metadata, not an ambient credential;
    // retain its exact value for lifecycle assertions. Diagnostic rendering
    // still passes the complete snapshot through the redactor before exposure.
    cwd: truncateUtf8(spec.cwd, 512),
    env: Object.freeze(Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, truncateUtf8(redactor.redact(value), 512)]))),
  });
}

function runtimePath(): string {
  const runtimeDirectory = path.dirname(process.execPath);
  if (process.platform === "win32") return runtimeDirectory;
  return [runtimeDirectory, "/usr/bin", "/bin"].join(path.delimiter);
}

/** Build a child environment from controller-owned values only. */
export function buildPiChildEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: runtimePath(),
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PI_OFFLINE: "1",
  };
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = overrides[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isJavaScriptEntryPoint(command: string): boolean { return /\.(?:c|m)?js$/iu.test(command); }

/** Invoke JavaScript Pi entry points with the exact controller Node runtime. */
export function preparePiChildLaunch(spec: ProcessLaunch): PreparedPiChildLaunch {
  const environment = buildPiChildEnvironment(spec.env);
  if (!isJavaScriptEntryPoint(spec.command) || spec.command === process.execPath) {
    return { command: spec.command, args: [...spec.args], environment };
  }
  return { command: process.execPath, args: [spec.command, ...spec.args], environment };
}