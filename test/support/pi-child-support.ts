import path from "node:path";
import type { ProcessLaunch } from "../../src/pi/pi-process.js";

export const PI_CHILD_STDERR_LIMIT_BYTES = 8_192;
export const PI_CHILD_OUTPUT_LIMIT_BYTES = 65_536;
export const PI_CHILD_DIAGNOSTIC_LIMIT_BYTES = 16_384;

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
const SENSITIVE_ASSIGNMENT = /((?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PROXY|CERT|SESSION|SSH|NODE_OPTIONS|NODE_PATH)[A-Z0-9_]*|api[-_]?key|access[-_]?token|bearer|password)\s*["']?\s*[:=]\s*["']?)([^\s,"'}]+)/giu;

export interface PreparedPiChildLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

/** A byte-bounded tail that copies incoming chunks so a large source chunk is not retained. */
export class BoundedTail {
  #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(readonly limitBytes: number) {}

  append(value: string | Buffer): void {
    const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (incoming.length >= this.limitBytes) {
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
    }
  }

  get byteLength(): number { return this.#bytes; }

  toString(): string { return Buffer.concat(this.#chunks, this.#bytes).toString("utf8"); }
}

export function truncateUtf8(value: string, limitBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limitBytes) return value;
  const suffix = Buffer.from("…[truncated]", "utf8");
  const bodyLimit = Math.max(0, limitBytes - suffix.length);
  return `${encoded.subarray(0, bodyLimit).toString("utf8")}${suffix.toString("utf8")}`;
}

export function collectSensitiveValues(...records: ReadonlyArray<Readonly<Record<string, string | undefined>>>): string[] {
  const values = new Set<string>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!SENSITIVE_NAME.test(key) || value === undefined || value.length < 4) continue;
      values.add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length).slice(0, 64);
}

export function redactText(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = value;
  for (const secret of sensitiveValues) redacted = redacted.replaceAll(secret, "<redacted>");
  redacted = redacted.replace(SENSITIVE_ASSIGNMENT, "$1<redacted>");
  redacted = redacted.replace(/(Bearer\s+)[^\s,;]+/giu, "$1<redacted>");
  return redacted;
}

function runtimePath(): string {
  const runtimeDirectory = path.dirname(process.execPath);
  if (process.platform === "win32") return runtimeDirectory;
  return [runtimeDirectory, "/usr/bin", "/bin"].join(path.delimiter);
}

/**
 * Build a child environment from controller-owned values only. In particular,
 * ambient process.env and a caller-supplied PATH are never copied.
 */
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

function isJavaScriptEntryPoint(command: string): boolean {
  return /\.(?:c|m)?js$/iu.test(command);
}

/** Invoke JavaScript Pi entry points with the exact controller Node runtime. */
export function preparePiChildLaunch(spec: ProcessLaunch): PreparedPiChildLaunch {
  const environment = buildPiChildEnvironment(spec.env);
  if (!isJavaScriptEntryPoint(spec.command) || spec.command === process.execPath) {
    return { command: spec.command, args: [...spec.args], environment };
  }
  return { command: process.execPath, args: [spec.command, ...spec.args], environment };
}