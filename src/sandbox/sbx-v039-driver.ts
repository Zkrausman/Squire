import path from "node:path";
import type { SandboxSpecDocument } from "./domain.js";
import { assertReleaseSemantics, assertSpecSemantics, SandboxContractError } from "./contracts.js";
import { isResolvedSandboxRelease, type ResolvedSandboxRelease } from "./release-resolver.js";
import { assertExactSandboxObservation, assertSbxCommand, commandFingerprint, findExactSandbox, SbxCommandError, type SbxCommand, type SbxObservedSandbox, SbxV039CommandBuilder, parseSbxListOutput, type SbxCopyCommandInput } from "./sbx-command.js";
import { HostProcessSupervisor, parseHostProcessIdentity, type HostChildProcess, type HostProcessLedger, type SbxCommandResult } from "./host-process-supervisor.js";
import { assertDigestReference, assertSandboxName, assertSha256, canonicalJson, deriveBridgeName, isSafeSandboxNetworkHost, sha256Bytes } from "./identity.js";

export interface SbxCommandExecutor {
  run(command: SbxCommand, options?: { readonly timeoutMs?: number; readonly allowExitCodes?: readonly number[]; readonly signal?: AbortSignal; readonly onSpawn?: (process: HostChildProcess) => void | Promise<void> }): Promise<SbxCommandResult>;
  spawn?(command: SbxCommand, signal?: AbortSignal, onSpawn?: (process: HostChildProcess) => void | Promise<void>): Promise<HostChildProcess>;
}

export interface SbxPolicyObservation {
  readonly digest: string;
  readonly mode: "allow-all" | "allowlist" | "deny-all";
  readonly allowedHosts: readonly string[];
  readonly source: "host";
}

export interface SbxV039DriverOptions {
  readonly release: ResolvedSandboxRelease;
  readonly builder: SbxV039CommandBuilder;
  readonly executor?: SbxCommandExecutor;
  /** Required when the real host supervisor is used; test executors may omit it. */
  readonly processLedger?: HostProcessLedger;
  readonly observationRetries?: number;
}

export interface SbxExecHandle extends HostChildProcess {
  readonly sandboxName: string;
  readonly expectedSandboxId: string;
}

export interface SandboxDriver {
  readonly release: ResolvedSandboxRelease;
  inspect(name: string, signal?: AbortSignal): Promise<SbxObservedSandbox | undefined>;
  create(spec: SandboxSpecDocument, bridgeHostPath: string, signal?: AbortSignal): Promise<SbxObservedSandbox>;
  start(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxObservedSandbox>;
  stop(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxObservedSandbox>;
  execWorker(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxExecHandle>;
  cpImport(input: SbxCopyCommandInput, signal?: AbortSignal): Promise<SbxCommandResult>;
  cpExport(input: SbxCopyCommandInput, signal?: AbortSignal): Promise<SbxCommandResult>;
  remove(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<void>;
  policy(signal?: AbortSignal): Promise<SbxPolicyObservation>;
}

/** Exact v0.39.0 adapter. It treats a successful subprocess as only a
 * transport event; every mutating operation is followed by exact identity
 * inspection before the result is accepted. */
export class SbxV039Driver implements SandboxDriver {
  readonly release: ResolvedSandboxRelease;
  readonly #builder: SbxV039CommandBuilder;
  readonly #executor: SbxCommandExecutor;
  readonly #observationRetries: number;
  constructor(options: SbxV039DriverOptions) {
    if (!options || typeof options !== "object") throw new SandboxContractError("sbx driver options are required");
    if (!isResolvedSandboxRelease(options.release)) throw new SandboxContractError("sbx driver requires a release verified by SandboxReleaseResolver");
    assertReleaseSemantics(options.release.release);
    if (options.release.release.promotion.state !== "validated") throw new SandboxContractError("sbx driver cannot use a blocked sandbox release");
    if (options.release.templateReference !== options.release.release.template.reference || options.release.resourceTuple.tupleId.length === 0 || !options.release.release.supportedResources.some(tuple => tuple.tupleId === options.release.resourceTuple.tupleId && canonicalJson(tuple) === canonicalJson(options.release.resourceTuple))) throw new SandboxContractError("sbx driver received an unverified resolved resource tuple");
    if (!options.builder || typeof options.builder.executable !== "string" || typeof options.builder.list !== "function" || typeof options.builder.create !== "function" || typeof options.builder.start !== "function" || typeof options.builder.stop !== "function" || typeof options.builder.execWorker !== "function" || typeof options.builder.cpImport !== "function" || typeof options.builder.cpExport !== "function" || typeof options.builder.remove !== "function" || typeof options.builder.policy !== "function") throw new SandboxContractError("sbx driver requires a closed command builder");
    if (options.executor !== undefined && (!options.executor || typeof options.executor !== "object" || typeof options.executor.run !== "function" || (options.executor.spawn !== undefined && typeof options.executor.spawn !== "function"))) throw new SandboxContractError("sbx driver requires a closed command executor");
    this.release = options.release;
    this.#builder = options.builder;
    this.#executor = options.executor ?? new HostProcessSupervisor({
      ...(options.processLedger ? { ledger: options.processLedger } : {}),
      verifyExecutable: async command => {
        if (command.executable !== this.release.sbxExecutable || command.executableSha256 !== this.release.release.sbxBinary.sha256) throw new SbxCommandError("sbx executable is not the promoted release identity");
      },
    });
    if (this.#builder.executable !== this.release.sbxExecutable || this.#builder.executableSha256 !== this.release.release.sbxBinary.sha256) throw new SandboxContractError("sbx command builder is not bound to the resolved release executable");
    this.#observationRetries = positiveInteger(options.observationRetries ?? 3, "sbx observation retry count");
    if (this.#observationRetries > 10) throw new SandboxContractError("sbx observation retry count exceeds its bound");
  }

  async inspect(name: string, signal?: AbortSignal): Promise<SbxObservedSandbox | undefined> {
    assertSandboxName(name);
    if (signal?.aborted) throw new SandboxContractError("sbx inspection was aborted");
    const result = await this.#run(this.#builder.list(), signal);
    return findExactSandbox(result.stdout, name);
  }

  async create(spec: SandboxSpecDocument, bridgeHostPath: string, signal?: AbortSignal): Promise<SbxObservedSandbox> {
    try { assertSpecSemantics(spec); } catch (error) { throw new SandboxContractError(error instanceof Error ? error.message : "sandbox create spec is invalid"); }
    const name = spec.sandboxName;
    if (typeof bridgeHostPath !== "string" || !path.isAbsolute(bridgeHostPath) || path.resolve(bridgeHostPath) !== bridgeHostPath || path.basename(bridgeHostPath) !== deriveBridgeName(spec.runId) || spec.bridge.name !== deriveBridgeName(spec.runId) || /[\u0000-\u001f\u007f\r\n]/u.test(bridgeHostPath)) throw new SandboxContractError("sandbox create bridge path is not the deterministic ticket bridge");
    if (spec.template.reference !== this.release.templateReference || canonicalJson(spec.resources) !== canonicalJson({ cpus: this.release.resourceTuple.cpus, memoryMiB: this.release.resourceTuple.memoryMiB, disk: this.release.resourceTuple.disk })) throw new SandboxContractError("sandbox create spec is not the resolved release tuple");
    if (spec.resources.disk.enforcement === "unsupported") throw new SandboxContractError("sandbox create is blocked for an unsupported disk tuple");
    const before = await this.inspect(name, signal);
    if (before) {
      if (before.templateDigest !== spec.template.digest) throw new SandboxContractError("deterministic sandbox name is occupied by a different template");
      if (before.status === "unknown" || !before.id || !before.vmId) throw new SandboxContractError("deterministic sandbox name has an unknown identity");
      throw new SandboxContractError("deterministic sandbox already exists; adoption requires the persisted exact identity");
    }
    await this.#run(this.#builder.create({ sandboxName: name, templateReference: spec.template.reference, resources: spec.resources, bridgeHostPath }), signal);
    const observed = await this.#observeExact(name, { templateDigest: spec.template.digest }, signal);
    if (observed.status !== "created" && observed.status !== "stopped" && observed.status !== "running") throw new SandboxContractError("sbx create did not produce a recognized sandbox state");
    if (observed.status === "running" && !observed.bootId) throw new SandboxContractError("sbx create returned a running sandbox without a boot identity");
    return observed;
  }

  async start(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxObservedSandbox> {
    assertExpectedObservation(expected);
    const current = await this.#requireExact(expected, signal);
    if (current.status === "running") return current;
    await this.#run(this.#builder.start(expected.name, expected.id), signal);
    const observed = await this.#observeExact(expected.name, { id: expected.id, templateDigest: expected.templateDigest, vmId: expected.vmId }, signal);
    if (observed.status !== "running") throw new SandboxContractError("sbx start did not produce a running exact sandbox");
    return observed;
  }

  async stop(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxObservedSandbox> {
    assertExpectedObservation(expected);
    const current = await this.#requireExact(expected, signal);
    if (current.status === "stopped" || current.status === "created") return current;
    await this.#run(this.#builder.stop(expected.name, expected.id), signal);
    const observed = await this.#observeExact(expected.name, { id: expected.id, templateDigest: expected.templateDigest, vmId: expected.vmId }, signal);
    if (observed.status !== "stopped" && observed.status !== "created") throw new SandboxContractError("sbx stop did not produce a stopped exact sandbox");
    return observed;
  }

  async execWorker(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxExecHandle> {
    assertExpectedObservation(expected);
    const current = await this.#requireExact(expected, signal);
    if (current.status !== "running") throw new SandboxContractError("trusted guest operations require a running exact sandbox");
    if (!this.#executor.spawn) throw new SandboxContractError("sbx executor does not expose a durable spawn operation");
    let child!: HostChildProcess;
    child = await this.#executor.spawn(this.#builder.execWorker(current.name, current.id), signal);
    if (!child || typeof child !== "object" || typeof child.identity !== "string" || typeof child.kill !== "function" || typeof child.waitForExit !== "function" || typeof child.pid !== "number" || typeof child.startTime !== "string" || child.exitCode !== null || !child.stdin || typeof child.stdin.write !== "function" || !child.stdout || typeof child.stdout.on !== "function" || !child.stderr || typeof child.stderr.on !== "function") throw new SandboxContractError("trusted guest worker did not return a live durable process handle");
    const childIdentity = parseHostProcessIdentity(child.identity);
    if (!/^sbx-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(child.commandId ?? "") || !childIdentity || child.executable !== this.release.sbxExecutable || child.executableDigest !== this.release.release.sbxBinary.sha256 || childIdentity.pid !== child.pid || childIdentity.startTime !== child.startTime || childIdentity.executableDigest !== child.executableDigest) { if (child.exitCode === null) child.kill("SIGKILL"); throw new SandboxContractError("trusted guest worker executable or durable identity differs from the promoted sbx release"); }
    try { await this.#requireExact(current, signal); }
    catch (error) { if (child.exitCode === null) child.kill("SIGKILL"); await child.waitForExit(2_000).catch(() => undefined); throw new SandboxContractError(`sandbox identity changed while starting the trusted guest worker: ${error instanceof Error ? error.message : String(error)}`); }
    return Object.assign(child, { sandboxName: current.name, expectedSandboxId: current.id }) as SbxExecHandle;
  }

  async cpImport(input: SbxCopyCommandInput, signal?: AbortSignal): Promise<SbxCommandResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SandboxContractError("sandbox copy input is required");
    assertSandboxName(input.sandboxName);
    assertRequiredCopyIdentity(input);
    await this.#requireCopyIdentity(input, signal);
    const result = await this.#run(this.#builder.cpImport(input), signal);
    await this.#requireCopyIdentity(input, signal);
    return result;
  }

  async cpExport(input: SbxCopyCommandInput, signal?: AbortSignal): Promise<SbxCommandResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SandboxContractError("sandbox copy input is required");
    assertSandboxName(input.sandboxName);
    assertRequiredCopyIdentity(input);
    await this.#requireCopyIdentity(input, signal);
    const result = await this.#run(this.#builder.cpExport(input), signal);
    await this.#requireCopyIdentity(input, signal);
    return result;
  }

  async remove(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<void> {
    assertExpectedObservation(expected);
    const current = await this.#requireExact(expected, signal);
    await this.#run(this.#builder.remove(current.name, current.id), signal);
    let last: SbxObservedSandbox | undefined;
    for (let attempt = 0; attempt < this.#observationRetries; attempt += 1) {
      if (signal?.aborted) throw new SandboxContractError("sbx removal observation was aborted");
      last = await this.inspect(current.name, signal);
      if (!last) return;
      if (!sameSandboxIdentity(last, expected)) throw new SandboxContractError("sandbox name was replaced during exact removal");
      await abortableDelay(10 * (attempt + 1), signal);
    }
    throw new SandboxContractError(`exact sandbox removal was not observed: ${last?.name ?? expected.name}`);
  }

  async policy(signal?: AbortSignal): Promise<SbxPolicyObservation> {
    const result = await this.#run(this.#builder.policy(), signal);
    const policy = parsePolicyOutput(result.stdout);
    if (policy.digest !== this.release.release.networkProfileDigest) throw new SandboxContractError("sbx network policy differs from the promoted release profile");
    return policy;
  }

  async #requireCopyIdentity(input: SbxCopyCommandInput, signal?: AbortSignal): Promise<SbxObservedSandbox> {
    const observed = await this.inspect(input.sandboxName, signal);
    const exact = assertExactSandboxObservation(observed, { name: input.sandboxName, ...(input.expectedSandboxId !== undefined ? { id: input.expectedSandboxId } : {}), ...(input.expectedTemplateDigest !== undefined ? { templateDigest: input.expectedTemplateDigest } : {}) });
    if (exact.status === "unknown" || exact.status === "running" && !exact.bootId || input.expectedBootId !== undefined && exact.bootId !== input.expectedBootId) throw new SandboxContractError("sandbox copy requires a known exact VM/boot identity");
    return exact;
  }

  async #requireExact(expected: SbxObservedSandbox, signal?: AbortSignal): Promise<SbxObservedSandbox> {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new SandboxContractError("sandbox expected identity is required");
    assertSandboxName(expected.name);
    assertDigestReference(expected.templateDigest, "sandbox template digest");
    const observed = assertExactSandboxObservation(await this.inspect(expected.name, signal), expected);
    if (observed.status === "unknown" || (observed.status === "running" && !observed.bootId) || (expected.vmId !== undefined && (typeof expected.vmId !== "string" || expected.vmId.length === 0 || expected.vmId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(expected.vmId) || observed.vmId !== expected.vmId)) || (expected.bootId !== undefined && (typeof expected.bootId !== "string" || expected.bootId.length === 0 || expected.bootId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(expected.bootId) || observed.bootId !== expected.bootId))) throw new SandboxContractError("sandbox operation requires a known exact VM/boot identity");
    return observed;
  }

  async #observeExact(name: string, identity: { readonly id?: string; readonly templateDigest?: string; readonly vmId?: string }, signal?: AbortSignal): Promise<SbxObservedSandbox> {
    let observed: SbxObservedSandbox | undefined;
    for (let attempt = 0; attempt < this.#observationRetries; attempt += 1) {
      if (signal?.aborted) throw new SandboxContractError("sbx identity observation was aborted");
      observed = await this.inspect(name, signal);
      if (observed && (identity.id === undefined || observed.id === identity.id) && (identity.templateDigest === undefined || observed.templateDigest === identity.templateDigest) && (identity.vmId === undefined || observed.vmId === identity.vmId)) return observed;
      await abortableDelay(10 * (attempt + 1), signal);
    }
    if (!observed) throw new SandboxContractError("expected sandbox identity is absent after sbx operation");
    throw new SandboxContractError("sbx operation returned a substituted sandbox identity");
  }

  async #run(command: SbxCommand, signal?: AbortSignal): Promise<SbxCommandResult> {
    try { assertSbxCommand(command); } catch (error) { throw error instanceof SbxCommandError ? error : new SandboxContractError(error instanceof Error ? error.message : "sbx command is invalid"); }
    const result = await this.#executor.run(command, { timeoutMs: this.#builder.timeoutMs, ...(signal ? { signal } : {}) });
    assertSbxCommandResult(result, command, this.#builder.maxOutputBytes);
    return result;
  }
}

export { SbxV039Driver as SbxV039DriverAdapter };
export type SbxV039DriverPort = SandboxDriver;

export function parsePolicyOutput(output: string): SbxPolicyObservation {
  if (Buffer.byteLength(output, "utf8") > 1024 * 1024 || /[\u0000-\u001f\u007f]/u.test(output.replace(/\n/gu, ""))) throw new SbxCommandError("sbx policy output is malformed or unbounded");
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new SbxCommandError("sbx policy output is not strict JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SbxCommandError("sbx policy output is not an object");
  const record = value as Record<string, unknown>;
  if (Buffer.from(canonicalJson(record), "utf8").equals(Buffer.from(output.trim(), "utf8")) === false) throw new SbxCommandError("sbx policy output is not canonically serialized");
  if (Object.keys(record).sort().join("\0") !== ["allowedHosts", "digest", "mode"].sort().join("\0") || typeof record["digest"] !== "string" || typeof record["mode"] !== "string" || !Array.isArray(record["allowedHosts"])) throw new SbxCommandError("sbx policy output contains unexpected fields");
  const digest = record["digest"];
  const mode = record["mode"];
  const allowedHosts = record["allowedHosts"];
  if (!["allow-all", "allowlist", "deny-all"].includes(mode) || allowedHosts.length > 128 || new Set(allowedHosts).size !== allowedHosts.length || allowedHosts.some(host => typeof host !== "string" || !isSafeSandboxNetworkHost(host)) || (mode !== "allowlist" && allowedHosts.length !== 0)) throw new SbxCommandError("sbx policy output is not a closed policy");
  assertSha256(digest);
  const expected = sha256Bytes(Buffer.from(canonicalJson({ mode, allowedHosts }), "utf8"));
  if (digest !== expected) throw new SbxCommandError("sbx policy digest does not match effective rules");
  return { digest, mode: mode as SbxPolicyObservation["mode"], allowedHosts: Object.freeze([...allowedHosts] as string[]), source: "host" };
}

function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new SandboxContractError(`${label} must be positive`); return value; }
function assertExpectedObservation(value: unknown): asserts value is SbxObservedSandbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxContractError("sandbox expected identity is malformed");
  const record = value as Record<string, unknown>;
  const expected = Object.hasOwn(record, "bootId") ? ["bootId", "id", "name", "status", "templateDigest", "vmId"] : ["id", "name", "status", "templateDigest", "vmId"];
  if (Object.keys(record).sort().join("\0") !== expected.sort().join("\0") || typeof record["name"] !== "string" || typeof record["id"] !== "string" || typeof record["vmId"] !== "string" || typeof record["templateDigest"] !== "string" || !["created", "running", "stopped", "unknown"].includes(record["status"] as string)) throw new SandboxContractError("sandbox expected identity is malformed");
  assertSandboxName(record["name"]); assertDigestReference(record["templateDigest"]); assertIdentityText(record["id"]); assertIdentityText(record["vmId"]);
  if (record["status"] === "running") { if (typeof record["bootId"] !== "string") throw new SandboxContractError("running sandbox expected identity lacks its boot identity"); assertIdentityText(record["bootId"]); }
  else if (Object.hasOwn(record, "bootId")) throw new SandboxContractError("non-running sandbox expected identity must not carry a boot identity");
}
function assertIdentityText(value: unknown): asserts value is string { if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new SandboxContractError("sandbox identity text is invalid"); }
function assertRequiredCopyIdentity(input: SbxCopyCommandInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.expectedSandboxId !== "string" || input.expectedSandboxId.length === 0 || typeof input.expectedTemplateDigest !== "string") throw new SandboxContractError("sandbox copy requires the exact sandbox and template identities");
  assertIdentityText(input.expectedSandboxId);
  assertDigestReference(input.expectedTemplateDigest, "expected sandbox template digest");
  if (input.expectedBootId !== undefined) assertIdentityText(input.expectedBootId);
}
function sameSandboxIdentity(left: SbxObservedSandbox, right: SbxObservedSandbox): boolean {
  // Status and boot identity are mutable during a legitimate stop/remove
  // transition. Name, sandbox ID, template digest, and VM ID are the
  // immutable resource identity used to detect replacement.
  return left.name === right.name && left.id === right.id && left.templateDigest === right.templateDigest && left.vmId === right.vmId;
}
function assertSbxCommandResult(value: SbxCommandResult, command: SbxCommand, maxOutputBytes: number): void {
  const identity = value && typeof value === "object" ? parseHostProcessIdentity(value.processIdentity) : undefined;
  if (!value || typeof value !== "object" || Object.keys(value).sort().join("\0") !== ["argv", "commandFingerprint", "commandId", "executable", "exitCode", "processIdentity", "signal", "stderr", "stdout"].sort().join("\0") || typeof value.commandId !== "string" || !/^sbx-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.commandId) || value.commandFingerprint !== commandFingerprint(command) || !Array.isArray(value.argv) || canonicalJson(value.argv) !== canonicalJson(command.argv) || value.executable !== command.executable || !identity || identity.executableDigest !== command.executableSha256 || value.exitCode !== 0 || value.signal !== null || typeof value.stdout !== "string" || typeof value.stderr !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.stdout) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.stderr) || Buffer.byteLength(value.stdout, "utf8") + Buffer.byteLength(value.stderr, "utf8") > maxOutputBytes) throw new SandboxContractError("sbx command result is not the exact bounded durable result");
}
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new SandboxContractError("sbx observation delay was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new SandboxContractError("sbx observation delay was aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
void parseSbxListOutput;
