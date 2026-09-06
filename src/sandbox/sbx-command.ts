import { createHash } from "node:crypto";
import path from "node:path";
import { hostPathBasename, isCanonicalHostPath, hostPathPlatform } from "./host-platform.js";
import type { SandboxResourceSpec } from "./domain.js";
import { assertCanonicalSandboxPath, assertDigestReference, assertDiskBudget, assertSandboxName, assertSha256, assertTemplateReference, canonicalJson, SHA256_PATTERN, BRIDGE_NAME_PATTERN } from "./identity.js";

export const SBX_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const SBX_COMMAND_TIMEOUT_MS = 30_000;

export type SbxCommandKind = "version" | "help" | "create" | "list" | "start" | "exec-worker" | "cp-import" | "cp-export" | "stop" | "remove" | "policy";

export interface SbxCommand {
  readonly kind: SbxCommandKind;
  readonly executable: string;
  readonly executableSha256: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly targetName?: string;
  readonly expectedIdentity?: string;
  readonly expectedTemplateDigest?: string;
  readonly expectedBootId?: string;
}

export interface SbxCommandBuilderOptions {
  readonly executable: string;
  readonly executableSha256: string;
  readonly cwd: string;
  /** Explicit controller environment; ambient process.env is never accepted. */
  readonly environment: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface SbxCreateCommandInput {
  readonly sandboxName: string;
  readonly templateReference: string;
  readonly resources: SandboxResourceSpec;
  readonly bridgeHostPath: string;
}

export interface SbxCopyCommandInput {
  readonly sandboxName: string;
  readonly hostPath: string;
  readonly sandboxPath: string;
  /** Required expected identity used by the driver before and after cp. */
  readonly expectedSandboxId: string;
  readonly expectedTemplateDigest: string;
  /** Optional boot binding used by running transfer operations. */
  readonly expectedBootId?: string;
}

export interface SbxObservedSandbox {
  readonly name: string;
  readonly id: string;
  readonly status: "created" | "running" | "stopped" | "unknown";
  readonly templateDigest: string;
  readonly vmId: string;
  readonly bootId?: string;
}

export class SbxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SbxCommandError";
  }
}

/** Closed argv vocabulary for the documented v0.39.0 lifecycle surface. */
export class SbxV039CommandBuilder {
  readonly #options: Omit<SbxCommandBuilderOptions, "maxOutputBytes" | "timeoutMs"> & { readonly maxOutputBytes: number; readonly timeoutMs: number };
  readonly #environment: Readonly<Record<string, string>>;
  constructor(options: SbxCommandBuilderOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["cwd", "environment", "executable", "executableSha256", "maxOutputBytes", "timeoutMs"].includes(key))) throw new SbxCommandError("sbx command builder options are required and closed");
    const hostPlatform = hostPathPlatform(typeof options.executable === "string" ? options.executable : "");
    if (typeof options.executable !== "string" || !isCanonicalHostPath(options.executable, false, hostPlatform)) throw new SbxCommandError("sbx executable must be an absolute clean non-root path");
    assertSha256(options.executableSha256, "sbx executable digest");
    if (typeof options.cwd !== "string" || !isCanonicalHostPath(options.cwd, true, hostPlatform)) throw new SbxCommandError("sbx command cwd must be an absolute clean path");
    const maxOutputBytes = options.maxOutputBytes ?? SBX_COMMAND_MAX_OUTPUT_BYTES;
    const timeoutMs = options.timeoutMs ?? SBX_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > SBX_COMMAND_MAX_OUTPUT_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new SbxCommandError("sbx command bounds are invalid");
    this.#options = Object.freeze({ ...options, maxOutputBytes, timeoutMs });
    this.#environment = buildSbxEnvironment(options.environment, hostPlatform === "win32" ? "win32" : process.platform);
  }

  get executable(): string { return this.#options.executable; }
  get executableSha256(): string { return this.#options.executableSha256; }
  get cwd(): string { return this.#options.cwd; }
  get environment(): Readonly<Record<string, string>> { return this.#environment; }
  get timeoutMs(): number { return this.#options.timeoutMs!; }
  get maxOutputBytes(): number { return this.#options.maxOutputBytes!; }

  version(): SbxCommand { return this.#command("version", ["--version"]); }
  help(): SbxCommand { return this.#command("help", ["--help"]); }

  /** v0.39.0 create form: options precede the fixed shell template and one
   * primary workspace. No agent, workspace, env, port, kit, or clone value is
   * caller-selectable through this adapter. */
  create(input: SbxCreateCommandInput): SbxCommand {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join("\0") !== "bridgeHostPath\0resources\0sandboxName\0templateReference") throw new SbxCommandError("sbx create input is required and closed");
    assertSandboxName(input.sandboxName);
    assertTemplateReference(input.templateReference);
    assertHostControllerPath(input.bridgeHostPath, "sandbox bridge host path");
    if (!BRIDGE_NAME_PATTERN.test(hostPathBasename(input.bridgeHostPath))) throw new SbxCommandError("sandbox bridge host path is not the deterministic bridge identity");
    assertCreateResources(input.resources);
    const argv = [
      "create",
      "--name", input.sandboxName,
      "--template", input.templateReference,
      "--cpus", String(input.resources.cpus),
      "--memory", `${input.resources.memoryMiB}m`,
      "--",
      "shell",
      input.bridgeHostPath,
    ];
    return this.#command("create", argv, input.sandboxName);
  }

  /** The JSON format is the only accepted inspection surface. */
  list(): SbxCommand { return this.#command("list", ["ls", "--format", "json"]); }
  start(sandboxName: string, expectedIdentity: string): SbxCommand { return this.#targetCommand("start", "start", sandboxName, expectedIdentity); }
  stop(sandboxName: string, expectedIdentity: string): SbxCommand { return this.#targetCommand("stop", "stop", sandboxName, expectedIdentity); }
  /** Fresh controller-principal execution of the immutable guest worker. */
  execWorker(sandboxName: string, expectedIdentity: string): SbxCommand {
    assertSandboxName(sandboxName);
    assertIdentityText(expectedIdentity);
    return this.#command("exec-worker", ["exec", "-i", sandboxName, "--", "/opt/squire/bin/squirectl"], sandboxName, expectedIdentity);
  }
  cpImport(input: SbxCopyCommandInput): SbxCommand {
    if (!input || typeof input !== "object" || Array.isArray(input) || !["expectedSandboxId\0expectedTemplateDigest\0hostPath\0sandboxName\0sandboxPath", "expectedBootId\0expectedSandboxId\0expectedTemplateDigest\0hostPath\0sandboxName\0sandboxPath"].includes(Object.keys(input).sort().join("\0"))) throw new SbxCommandError("sbx copy input is required and closed");
    assertSandboxName(input.sandboxName);
    assertOptionalCopyIdentity(input);
    assertHostStagingPath(input.hostPath);
    assertSandboxImportPath(input.sandboxPath);
    return this.#command("cp-import", ["cp", input.hostPath, `${input.sandboxName}:${input.sandboxPath}`], input.sandboxName, input.expectedSandboxId, input.expectedTemplateDigest, input.expectedBootId);
  }
  cpExport(input: SbxCopyCommandInput): SbxCommand {
    if (!input || typeof input !== "object" || Array.isArray(input) || !["expectedSandboxId\0expectedTemplateDigest\0hostPath\0sandboxName\0sandboxPath", "expectedBootId\0expectedSandboxId\0expectedTemplateDigest\0hostPath\0sandboxName\0sandboxPath"].includes(Object.keys(input).sort().join("\0"))) throw new SbxCommandError("sbx copy input is required and closed");
    assertSandboxName(input.sandboxName);
    assertOptionalCopyIdentity(input);
    assertSandboxExportPath(input.sandboxPath);
    assertHostStagingPath(input.hostPath);
    return this.#command("cp-export", ["cp", `${input.sandboxName}:${input.sandboxPath}`, input.hostPath], input.sandboxName, input.expectedSandboxId, input.expectedTemplateDigest, input.expectedBootId);
  }
  remove(sandboxName: string, expectedIdentity: string): SbxCommand {
    assertSandboxName(sandboxName);
    assertIdentityText(expectedIdentity);
    return this.#command("remove", ["rm", "--force", "--", sandboxName], sandboxName, expectedIdentity);
  }
  policy(): SbxCommand { return this.#command("policy", ["policy", "ls", "--format", "json"]); }

  #targetCommand(kind: "start" | "stop", command: string, sandboxName: string, expectedIdentity: string): SbxCommand {
    assertSandboxName(sandboxName);
    assertIdentityText(expectedIdentity);
    return this.#command(kind, [command, "--", sandboxName], sandboxName, expectedIdentity);
  }

  #command(kind: SbxCommandKind, argv: readonly string[], targetName?: string, expectedIdentity?: string, expectedTemplateDigest?: string, expectedBootId?: string): SbxCommand {
    validateArgv(argv);
    if (expectedTemplateDigest !== undefined) assertDigestReference(expectedTemplateDigest, "expected sandbox template digest");
    if (expectedBootId !== undefined) assertIdentityText(expectedBootId);
    return Object.freeze({ kind, executable: this.#options.executable, executableSha256: this.#options.executableSha256, argv: Object.freeze([...argv]), cwd: this.#options.cwd, environment: this.#environment, ...(targetName ? { targetName } : {}), ...(expectedIdentity ? { expectedIdentity } : {}), ...(expectedTemplateDigest ? { expectedTemplateDigest } : {}), ...(expectedBootId ? { expectedBootId } : {}) });
  }
}

export function buildSbxEnvironment(source: Readonly<Record<string, string | undefined>>, platform = process.platform): Readonly<Record<string, string>> {
  const allowed = platform === "win32"
    ? ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "PATH", "LANG", "LC_ALL", "MSYS_NO_PATHCONV", "MSYS2_ARG_CONV_EXCL"]
    : ["PATH", "LANG", "LC_ALL", "HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"];
  const result: Record<string, string> = {};
  const allowedSet = new Set(allowed);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new SbxCommandError("sbx environment must be an explicit object");
  for (const key of Object.keys(source)) if (!allowedSet.has(key)) throw new SbxCommandError(`sbx environment contains an unallowlisted key: ${key}`);
  for (const key of allowed) {
    const value = Object.hasOwn(source, key) ? source[key] : undefined;
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new SbxCommandError(`sbx environment value is invalid: ${key}`);
      result[key] = value;
    }
  }
  if (platform === "win32") {
    result["MSYS_NO_PATHCONV"] = "1";
    result["MSYS2_ARG_CONV_EXCL"] = "*";
  }
  if (!Object.hasOwn(result, "PATH") || !result["PATH"]) throw new SbxCommandError("sbx environment requires an explicit PATH");
  return Object.freeze(result);
}

export function parseSbxVersionOutput(output: string): string {
  assertBoundedOutput(output);
  const clean = output.trim();
  if (!/^sbx(?:\s+version)?\s+0\.39\.0$/u.test(clean) && clean !== "0.39.0") throw new SbxCommandError("sbx version output is not the exact supported v0.39.0 identity");
  return "0.39.0";
}

export function parseSbxListOutput(output: string): readonly SbxObservedSandbox[] {
  assertBoundedOutput(output);
  if (/[\u001b\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(output)) throw new SbxCommandError("sbx inspection output contains control or ANSI data");
  let parsed: unknown;
  const clean = output.trim();
  try { parsed = JSON.parse(clean); } catch (error) { throw new SbxCommandError(`sbx inspection output is not strict JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (clean !== canonicalJson(parsed)) throw new SbxCommandError("sbx inspection output is not canonically serialized");
  const records = Array.isArray(parsed) ? parsed : undefined;
  if (!records || records.length > 100_000) throw new SbxCommandError("sbx inspection output must be a bounded sandbox array");
  const seen = new Set<string>(); const seenIds = new Set<string>(); const seenVmIds = new Set<string>();
  const result: SbxObservedSandbox[] = [];
  for (const record of records) {
    if (!isRecord(record)) throw new SbxCommandError("sbx inspection record is not an object");
    const keys = Object.keys(record).sort();
    const baseKeys = ["id", "name", "status", "templateDigest", "vmId"].sort();
    const allowed = ["bootId", ...baseKeys].sort();
    if (keys.join("\0") !== baseKeys.join("\0") && keys.join("\0") !== allowed.join("\0")) throw new SbxCommandError("sbx inspection record fields are not closed");
    if (typeof record["name"] !== "string" || typeof record["id"] !== "string" || typeof record["templateDigest"] !== "string" || typeof record["vmId"] !== "string" || typeof record["status"] !== "string" || !["created", "running", "stopped", "unknown"].includes(record["status"])) throw new SbxCommandError("sbx inspection record is malformed");
    const name = record["name"];
    const id = record["id"];
    const templateDigest = record["templateDigest"];
    const vmId = record["vmId"];
    const status = record["status"];
    assertSandboxName(name);
    assertDigestReference(templateDigest);
    assertIdentityText(id); assertIdentityText(vmId);
    if (seen.has(name)) throw new SbxCommandError("sbx inspection contains duplicate sandbox names");
    if (Object.hasOwn(record, "bootId")) { assertIdentityText(record["bootId"] as string); if (status !== "running") throw new SbxCommandError("sbx inspection returned a boot identity for a non-running sandbox"); }
    if (seenIds.has(id) || seenVmIds.has(vmId)) throw new SbxCommandError("sbx inspection contains duplicate sandbox or VM identities");
    seen.add(name); seenIds.add(id); seenVmIds.add(vmId);
    result.push(Object.freeze({ name, id, status: status as SbxObservedSandbox["status"], templateDigest, vmId, ...(typeof record["bootId"] === "string" ? { bootId: record["bootId"] } : {}) }));
  }
  return Object.freeze(result);
}

export function findExactSandbox(output: string, name: string): SbxObservedSandbox | undefined {
  assertSandboxName(name);
  const records = parseSbxListOutput(output);
  const matches = records.filter(record => record.name === name);
  if (matches.length > 1) throw new SbxCommandError("sbx inspection returned duplicate exact identities");
  return matches[0];
}

export function assertExactSandboxObservation(observed: SbxObservedSandbox | undefined, expected: { readonly name: string; readonly templateDigest?: string; readonly id?: string }): SbxObservedSandbox {
  assertSandboxName(expected.name);
  if (expected.templateDigest !== undefined) assertDigestReference(expected.templateDigest);
  if (expected.id !== undefined) assertIdentityText(expected.id);
  if (observed) assertObservedSandboxValue(observed);
  if (!observed || observed.name !== expected.name) throw new SbxCommandError("sbx command did not return the expected sandbox identity");
  if (expected.templateDigest !== undefined && observed.templateDigest !== expected.templateDigest) throw new SbxCommandError("sbx sandbox template identity differs from the expected release");
  if (expected.id !== undefined && observed.id !== expected.id) throw new SbxCommandError("sbx sandbox ID differs from the expected identity");
  return observed;
}

export function commandFingerprint(command: SbxCommand): string {
  return createHash("sha256").update(canonicalJson({ kind: command.kind, argv: command.argv, executable: command.executable, executableSha256: command.executableSha256, cwd: command.cwd, environment: command.environment, ...(command.targetName ? { targetName: command.targetName } : {}), ...(command.expectedIdentity ? { expectedIdentity: command.expectedIdentity } : {}), ...(command.expectedTemplateDigest ? { expectedTemplateDigest: command.expectedTemplateDigest } : {}), ...(command.expectedBootId ? { expectedBootId: command.expectedBootId } : {}) }), "utf8").digest("hex");
}

export function assertSbxCommand(value: unknown): asserts value is SbxCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SbxCommandError("sbx command is not an object");
  const command = value as Record<string, unknown>;
  const keys = Object.keys(command).sort().join("\0");
  const baseKeys = ["argv", "cwd", "environment", "executable", "executableSha256", "kind"].sort().join("\0");
  const targetKeys = ["argv", "cwd", "environment", "executable", "executableSha256", "expectedIdentity", "kind", "targetName"].sort().join("\0");
  const copyTargetKeys = ["argv", "cwd", "environment", "executable", "executableSha256", "expectedIdentity", "expectedTemplateDigest", "kind", "targetName"].sort().join("\0");
  const copyBootTargetKeys = ["argv", "cwd", "environment", "executable", "executableSha256", "expectedBootId", "expectedIdentity", "expectedTemplateDigest", "kind", "targetName"].sort().join("\0");
  const namedKeys = ["argv", "cwd", "environment", "executable", "executableSha256", "kind", "targetName"].sort().join("\0");
  const kind = command["kind"];
  if ((keys !== baseKeys && keys !== namedKeys && keys !== targetKeys && keys !== copyTargetKeys && keys !== copyBootTargetKeys) || typeof kind !== "string" || !["version", "help", "create", "list", "start", "exec-worker", "cp-import", "cp-export", "stop", "remove", "policy"].includes(kind)) throw new SbxCommandError("sbx command fields are not closed");
  const executable = command["executable"];
  const executableSha256 = command["executableSha256"];
  const cwd = command["cwd"];
  const environmentValue = command["environment"];
  const hostPlatform = hostPathPlatform(typeof executable === "string" ? executable : "");
  if (typeof executable !== "string" || !isCanonicalHostPath(executable, false, hostPlatform) || typeof executableSha256 !== "string") throw new SbxCommandError("sbx command executable identity is invalid");
  assertSha256(executableSha256, "sbx executable digest");
  if (typeof cwd !== "string" || !isCanonicalHostPath(cwd, true, hostPlatform) || !isRecord(environmentValue)) throw new SbxCommandError("sbx command cwd or environment is invalid");
  const environment = buildSbxEnvironment(environmentValue as Record<string, string | undefined>, hostPlatform === "win32" ? "win32" : process.platform);
  if (canonicalJson(environment) !== canonicalJson(environmentValue)) throw new SbxCommandError("sbx command environment is not the canonical allowlist");
  const argvValue = command["argv"];
  if (!Array.isArray(argvValue)) throw new SbxCommandError("sbx argv is not an array");
  validateArgv(argvValue);
  const argv = argvValue as readonly string[];
  switch (kind) {
    case "version": if (argv.length !== 1 || argv[0] !== "--version") throw new SbxCommandError("sbx version argv is not exact"); break;
    case "help": if (argv.length !== 1 || argv[0] !== "--help") throw new SbxCommandError("sbx help argv is not exact"); break;
    case "list": if (argv.length !== 3 || argv[0] !== "ls" || argv[1] !== "--format" || argv[2] !== "json") throw new SbxCommandError("sbx list argv is not exact"); break;
    case "policy": if (argv.length !== 4 || argv[0] !== "policy" || argv[1] !== "ls" || argv[2] !== "--format" || argv[3] !== "json") throw new SbxCommandError("sbx policy argv is not exact"); break;
    case "start": case "stop": if (argv.length !== 3 || argv[0] !== kind || argv[1] !== "--" || typeof argv[2] !== "string" || command["targetName"] !== argv[2]) throw new SbxCommandError(`sbx ${kind} argv is not exact`); assertSandboxName(argv[2]); break;
    case "remove": if (argv.length !== 4 || argv[0] !== "rm" || argv[1] !== "--force" || argv[2] !== "--" || command["targetName"] !== argv[3]) throw new SbxCommandError("sbx remove argv is not exact"); assertSandboxName(argv[3]!); break;
    case "exec-worker": if (argv.length !== 5 || argv[0] !== "exec" || argv[1] !== "-i" || argv[3] !== "--" || argv[4] !== "/opt/squire/bin/squirectl" || command["targetName"] !== argv[2]) throw new SbxCommandError("sbx worker argv is not exact"); assertSandboxName(argv[2]!); break;
    case "cp-import": case "cp-export": {
      if (argv.length !== 3 || argv[0] !== "cp") throw new SbxCommandError("sbx copy argv is not exact");
      const target = command["targetName"];
      if (keys !== copyTargetKeys && keys !== copyBootTargetKeys || typeof command["expectedTemplateDigest"] !== "string") throw new SbxCommandError("sbx copy template identity is missing");
      assertDigestReference(command["expectedTemplateDigest"], "expected sandbox template digest");
      if (typeof target !== "string") throw new SbxCommandError("sbx copy target identity is missing");
      assertSandboxName(target);
      const prefix = `${target}:`;
      if (kind === "cp-import") { if (!argv[2]!.startsWith(prefix)) throw new SbxCommandError("sbx import destination identity is invalid"); assertHostStagingPath(argv[1]!); assertSandboxImportPath(argv[2]!.slice(prefix.length)); }
      else { if (!argv[1]!.startsWith(prefix)) throw new SbxCommandError("sbx export source identity is invalid"); assertSandboxExportPath(argv[1]!.slice(prefix.length)); assertHostStagingPath(argv[2]!); }
      break;
    }
    case "create": if (argv.length !== 12 || argv[0] !== "create" || argv[1] !== "--name" || argv[3] !== "--template" || argv[5] !== "--cpus" || argv[7] !== "--memory" || argv[9] !== "--" || argv[10] !== "shell" || command["targetName"] !== argv[2]) throw new SbxCommandError("sbx create argv is not exact"); assertSandboxName(argv[2]!); assertTemplateReference(argv[4]!); if (!/^\d{1,3}$/u.test(argv[6]!) || String(Number(argv[6])) !== argv[6] || Number(argv[6]) < 1 || Number(argv[6]) > 256 || !/^\d{1,7}m$/u.test(argv[8]!) || String(Number.parseInt(argv[8]!, 10)) !== argv[8]!.slice(0, -1) || Number.parseInt(argv[8]!, 10) < 128 || Number.parseInt(argv[8]!, 10) > 1_048_576 || !pathClean(argv[11]!) || !BRIDGE_NAME_PATTERN.test(hostPathBasename(argv[11]!))) throw new SbxCommandError("sbx create option identity is invalid"); break;
  }
  if (keys === copyTargetKeys || keys === copyBootTargetKeys) { const target = command["targetName"]; const expected = command["expectedIdentity"]; if (kind !== "cp-import" && kind !== "cp-export") throw new SbxCommandError("copy identity fields are only valid for cp commands"); if (typeof target !== "string") throw new SbxCommandError("sbx target identity is missing"); assertSandboxName(target); if (typeof expected !== "string") throw new SbxCommandError("sbx expected identity is missing"); assertIdentityText(expected); if (keys === copyBootTargetKeys) { if (typeof command["expectedBootId"] !== "string") throw new SbxCommandError("sbx expected boot identity is missing"); assertIdentityText(command["expectedBootId"]); } }
  else if (keys === targetKeys) { const target = command["targetName"]; const expected = command["expectedIdentity"]; if (!["start", "stop", "exec-worker", "remove"].includes(kind)) throw new SbxCommandError("target identity fields are invalid for this sbx command"); if (typeof target !== "string") throw new SbxCommandError("sbx target identity is missing"); assertSandboxName(target); if (typeof expected !== "string") throw new SbxCommandError("sbx expected identity is missing"); assertIdentityText(expected); }
  else if (keys === namedKeys) { const target = command["targetName"]; if (kind !== "create") throw new SbxCommandError("targeted sbx command lacks an expected identity"); if (typeof target !== "string") throw new SbxCommandError("target identity is missing"); assertSandboxName(target); }
  else if (command["targetName"] !== undefined || command["expectedIdentity"] !== undefined || command["expectedTemplateDigest"] !== undefined || command["expectedBootId"] !== undefined) throw new SbxCommandError("sbx command has an unexpected target identity");
}

export function validateArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 128) throw new SbxCommandError("sbx argv must be bounded and non-empty");
  let bytes = 0;
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > 2048 || /[\u0000-\u001f\u007f]/u.test(arg)) throw new SbxCommandError("sbx argv contains an invalid token");
    bytes += Buffer.byteLength(arg, "utf8") + 1;
  }
  if (bytes > 256 * 1024) throw new SbxCommandError("sbx argv exceeds its bounded byte size");
}

function assertCreateResources(resources: SandboxResourceSpec): void {
  if (!resources || typeof resources !== "object" || Array.isArray(resources) || Object.keys(resources).sort().join("\0") !== "cpus\0disk\0memoryMiB" || !resources.disk || typeof resources.disk !== "object" || Array.isArray(resources.disk)) throw new SbxCommandError("sbx resource tuple is invalid");
  if (!Number.isSafeInteger(resources.cpus) || resources.cpus < 1 || resources.cpus > 256) throw new SbxCommandError("sbx CPU option is invalid");
  if (!Number.isSafeInteger(resources.memoryMiB) || resources.memoryMiB < 128 || resources.memoryMiB > 1_048_576) throw new SbxCommandError("sbx memory option is invalid");
  try { assertDiskBudget(resources.disk); } catch (error) { throw new SbxCommandError(error instanceof Error ? error.message : "sbx disk option is invalid"); }
  if (resources.disk.enforcement === "unsupported") throw new SbxCommandError("unsupported disk tuple cannot be passed to sbx create");
  if (resources.disk.enforcement === "native") throw new SbxCommandError("native disk tuple has no proven v0.39.0 create argument in this adapter");
}

function assertHostControllerPath(value: string, label: string): void {
  if (!isCanonicalHostPath(value, false, hostPathPlatform(value))) throw new SbxCommandError(`${label} is not a canonical absolute path`);
}

function assertHostStagingPath(value: string): void {
  assertHostControllerPath(value, "host staging path");
}

function assertOptionalCopyIdentity(input: SbxCopyCommandInput): void {
  assertIdentityText(input.expectedSandboxId);
  assertDigestReference(input.expectedTemplateDigest, "expected sandbox template digest");
  if (input.expectedBootId !== undefined) assertIdentityText(input.expectedBootId);
}

function assertSandboxImportPath(value: string): void {
  assertCanonicalSandboxPath(value, "sandbox import path");
  if (!value.startsWith("/ticket/import/")) throw new SbxCommandError("sandbox cp import destination is outside /ticket/import");
}

function assertSandboxExportPath(value: string): void {
  assertCanonicalSandboxPath(value, "sandbox export path");
  if (!value.startsWith("/ticket/artifacts/") && !value.startsWith("/ticket/evidence/") && !value.startsWith("/ticket/sessions/")) throw new SbxCommandError("sandbox cp export source is outside the closed retained roots");
}

function assertIdentityText(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) throw new SbxCommandError("sbx identity contains unsafe text");
}

function assertBoundedOutput(output: string): void {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > SBX_COMMAND_MAX_OUTPUT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(output)) throw new SbxCommandError("sbx output exceeds its bounded limit or contains control data");
}
function pathClean(value: unknown, allowRoot = false): value is string {
  return isCanonicalHostPath(value, allowRoot, typeof value === "string" ? hostPathPlatform(value) : process.platform);
}

function assertObservedSandboxValue(value: SbxObservedSandbox): void {
  if (!isRecord(value)) throw new SbxCommandError("sbx sandbox observation is not an object");
  const record = value as Record<string, unknown>;
  const keys = Object.hasOwn(record, "bootId") ? ["bootId", "id", "name", "status", "templateDigest", "vmId"] : ["id", "name", "status", "templateDigest", "vmId"];
  if (Object.keys(record).sort().join("\0") !== keys.sort().join("\0") || typeof record["name"] !== "string" || typeof record["id"] !== "string" || typeof record["vmId"] !== "string" || typeof record["templateDigest"] !== "string" || typeof record["status"] !== "string" || !["created", "running", "stopped", "unknown"].includes(record["status"] as string)) throw new SbxCommandError("sbx sandbox observation is malformed");
  assertSandboxName(record["name"]); assertIdentityText(record["id"]); assertIdentityText(record["vmId"]); assertDigestReference(record["templateDigest"]);
  if (Object.hasOwn(record, "bootId")) { if (record["status"] !== "running" || typeof record["bootId"] !== "string") throw new SbxCommandError("sbx sandbox boot identity is malformed"); assertIdentityText(record["bootId"]); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

void SHA256_PATTERN;
