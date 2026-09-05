import { EventEmitter } from "node:events";
import { ROLES, type Role } from "../control/domain.js";
import type { ProcessLaunch } from "../pi/pi-process.js";
import type { PiProcess, PiProcessFactory, ProcessIdentityResolver } from "../pi/pi-process.js";
import type { SbxExecHandle, SandboxDriver } from "./sbx-v039-driver.js";
import { isResolvedSandboxRelease, type ResolvedSandboxRelease } from "./release-resolver.js";
import { assertReleaseSemantics } from "./contracts.js";
import type { SbxObservedSandbox } from "./sbx-command.js";
import { GuestOperationClient, type GuestBinding } from "./guest-protocol.js";
import { assertCanonicalSandboxPath, assertSandboxName, assertSandboxRunId, assertSha256, canonicalJson, deriveSandboxName, sha256Bytes } from "./identity.js";
import type { SandboxProcessIdentity } from "./domain.js";

const ROLE_UID = 1001;
const MAX_RPC_LINE_BYTES = 256 * 1024;
const ALLOWED_ENVIRONMENT = new Set(["HOME", "WIKI_HOME", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);
const SUPPORTED_RPC_TYPES = new Set(["get_state", "get_entries", "prompt", "clear_queue", "abort_retry", "abort"]);

export interface SandboxPiProcessFactoryOptions {
  readonly driver: SandboxDriver;
  readonly sandbox: SbxObservedSandbox;
  readonly release: ResolvedSandboxRelease;
  readonly runId: string;
  readonly role: Role;
  readonly generation: number;
  readonly helperDigest: string;
  /** Exact run-resolved Pi executable; required so a role cannot choose a
   * different interpreter or runtime payload. */
  readonly piExecutable: string;
  readonly operationTimeoutMs?: number;
}

export interface SandboxPiProcessFactoryPort extends PiProcessFactory {
  readonly sandbox: SbxObservedSandbox;
  readonly role: Role;
  readonly generation: number;
}

export class SandboxPiProcessError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxPiProcessError"; }
}

/** Maps the existing PiProcess port onto a fresh controller-principal guest
 * worker. Pi stdin/stdout are never host process pipes and an outer worker exit
 * never counts as inner Pi exit. */
export class SandboxPiProcessFactory implements SandboxPiProcessFactoryPort {
  readonly #options: SandboxPiProcessFactoryOptions;
  constructor(options: SandboxPiProcessFactoryOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options) || !options.driver || typeof options.driver.execWorker !== "function" || !options.sandbox || typeof options.sandbox !== "object" || !options.release || typeof options.release !== "object") throw new SandboxPiProcessError("sandbox Pi factory options are required");
    assertSandboxRunId(options.runId); assertSandboxObservation(options.sandbox); if (!ROLES.includes(options.role)) throw new SandboxPiProcessError("sandbox Pi role is not allowlisted"); assertSandboxName(options.sandbox.name); assertSha256(options.helperDigest, "guest helper digest"); if (!isResolvedSandboxRelease(options.release) || !isResolvedSandboxRelease(options.driver.release)) throw new SandboxPiProcessError("sandbox Pi factory requires resolver-verified driver and release identities");
    if (!options.release.release.template.helperDigests.includes(options.helperDigest)) throw new SandboxPiProcessError("guest helper digest is not in the promoted template identity");
    if (options.sandbox.name !== deriveSandboxName(options.runId) || typeof options.sandbox.id !== "string" || typeof options.sandbox.vmId !== "string" || !safeIdentity(options.sandbox.id) || !safeIdentity(options.sandbox.vmId) || assertDigestReferenceSafe(options.sandbox.templateDigest) === false) throw new SandboxPiProcessError("sandbox Pi factory sandbox identity is invalid");
    try { assertCanonicalSandboxPath(options.piExecutable, "sandbox Pi executable"); } catch (error) { throw new SandboxPiProcessError(error instanceof Error ? error.message : "sandbox Pi executable is not a canonical ticket path"); }
    if (!options.piExecutable.startsWith("/ticket/runtime/")) throw new SandboxPiProcessError("sandbox Pi executable is outside the fixed runtime root");
    if (!options.sandbox.id || !options.sandbox.vmId || /[\u0000-\u001f\u007f\r\n]/u.test(`${options.sandbox.id}${options.sandbox.vmId}${options.sandbox.bootId ?? ""}`) || options.sandbox.status !== "running" || !options.sandbox.bootId) throw new SandboxPiProcessError("sandbox Pi factory requires an attested running sandbox with a boot ID");
    try { assertReleaseSemantics(options.release.release); } catch (error) { throw new SandboxPiProcessError(error instanceof Error ? error.message : "sandbox Pi factory release is invalid"); }
    if (options.release.release.promotion.state !== "validated") throw new SandboxPiProcessError("sandbox Pi factory cannot use a blocked sandbox release");
    if (options.release.templateReference !== options.driver.release.templateReference || options.release.sbxExecutable !== options.driver.release.sbxExecutable || options.release.release.sbxBinary.sha256 !== options.driver.release.release.sbxBinary.sha256 || options.release.release.releaseId !== options.driver.release.release.releaseId || canonicalJson(options.release.resourceTuple) !== canonicalJson(options.driver.release.resourceTuple) || options.release.release.template.digest !== options.sandbox.templateDigest || options.release.release.template.reference !== options.release.templateReference) throw new SandboxPiProcessError("sandbox Pi factory release identity is substituted");
    if (options.generation < 1 || options.generation > 2_147_483_647 || !Number.isSafeInteger(options.generation)) throw new SandboxPiProcessError("sandbox Pi generation is invalid");
    this.#options = deepFreeze({ ...options, sandbox: { ...options.sandbox } });
  }
  get sandbox(): SbxObservedSandbox { return this.#options.sandbox; }
  get role(): Role { return this.#options.role; }
  get generation(): number { return this.#options.generation; }

  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<SandboxPiProcess> {
    const launch = withSandboxEnvironment(spec);
    validatePiLaunch(launch, this.#options.role, this.#options.piExecutable, this.#options.runId);
    if (signal?.aborted) throw new SandboxPiProcessError("sandbox Pi spawn was aborted");
    let worker: SbxExecHandle | undefined;
    let channel: GuestOperationClient | undefined;
    let process: SandboxPiProcess | undefined;
    let allocation: SandboxProcessIdentity | undefined;
    try {
      worker = await this.#options.driver.execWorker(this.#options.sandbox, signal);
      const binding = this.#binding(worker);
      channel = new GuestOperationClient(worker, binding, { maxFrameBytes: 256 * 1024, maxOutputBytes: 8 * 1024 * 1024 });
      if (channel.binding.releaseId !== this.#options.release.release.releaseId || channel.binding.helperDigest !== this.#options.helperDigest) throw new SandboxPiProcessError("guest worker channel release or helper identity is substituted");
      const rawAllocation = await channel!.invoke("spawn-process", {
        role: this.#options.role,
        generation: this.#options.generation,
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        environment: launch.env,
        argvDigest: argvDigest(launch),
      }, signal);
      allocation = parseAllocation(rawAllocation, this.#options, launch);
      process = new SandboxPiProcess(worker!, channel!, this.#options.runId, allocation, this.#options.operationTimeoutMs ?? 5_000, this.#options.release.release.releaseId, this.#options.helperDigest);
      onSpawn?.(process);
      return process;
    } catch (error) {
      try {
        if (allocation && worker && worker.exitCode === null) {
          // Cleanup is controller-owned and must still run after the caller's
          // cancellation signal has fired; passing that aborted signal would
          // leave the inner role allocation live behind a dead worker.
          await channel?.invoke("signal-process", { allocation, signal: "SIGKILL" });
          await channel?.invoke("reap-process", { allocation });
        }
      } catch { /* The exact cleanup failure remains a fail-closed caller error. */ }
      channel?.close();
      if (worker && worker.exitCode === null) worker.kill("SIGTERM");
      throw error instanceof SandboxPiProcessError ? error : new SandboxPiProcessError(error instanceof Error ? error.message : String(error));
    }
  }

  #binding(worker: SbxExecHandle): GuestBinding {
    if (worker.sandboxName !== this.#options.sandbox.name || worker.expectedSandboxId !== this.#options.sandbox.id || !this.#options.sandbox.bootId) throw new SandboxPiProcessError("guest worker sandbox identity differs from the factory identity");
    return { runId: this.#options.runId, sandboxName: this.#options.sandbox.name, bootId: this.#options.sandbox.bootId, operationGeneration: this.#options.generation, releaseId: this.#options.release.release.releaseId, helperDigest: this.#options.helperDigest };
  }
}

export class SandboxPiProcess extends EventEmitter implements PiProcess {
  readonly identity: string;
  readonly stdin: { write(data: string): boolean };
  readonly stdout: PiStream;
  readonly stderr: PiStream;
  readonly runId: string;
  readonly allocation: SandboxProcessIdentity;
  exitCode: number | null = null;
  #exitSignal: string | null = null;
  #input = "";
  #chain = Promise.resolve();
  #outputBytes = 0;
  #closed = false;
  #supervisorLost = false;
  readonly #worker: SbxExecHandle;
  readonly #channel: GuestOperationClient;
  readonly #timeoutMs: number;
  constructor(worker: SbxExecHandle, channel: GuestOperationClient, runId: string, allocation: SandboxProcessIdentity, timeoutMs: number, expectedReleaseId: string, expectedHelperDigest: string) {
    super();
    assertSandboxRunId(runId);
    if (!worker || typeof worker !== "object" || typeof worker.on !== "function" || typeof worker.kill !== "function" || worker.sandboxName !== allocation.sandboxName || worker.expectedSandboxId !== allocation.sandboxId || worker.exitCode !== null && !Number.isSafeInteger(worker.exitCode) || worker.exitCode !== null) throw new SandboxPiProcessError("Pi process worker identity is not exact");
    const binding = channel && channel.binding;
    if (!channel || typeof channel.invoke !== "function" || !binding || binding.runId !== runId || binding.sandboxName !== allocation.sandboxName || binding.bootId !== allocation.bootId || binding.operationGeneration !== allocation.generation || binding.releaseId !== expectedReleaseId || binding.helperDigest !== expectedHelperDigest) throw new SandboxPiProcessError("Pi process guest channel identity is not exact");
    assertAllocationIdentity(allocation);
    if (!sameAllocation(allocation as unknown as Record<string, unknown>, allocation) || allocation.uid !== ROLE_UID) throw new SandboxPiProcessError("Pi process allocation identity is malformed");
    this.#worker = worker; this.#channel = channel; this.runId = runId; this.allocation = deepFreeze({ ...allocation }); this.#timeoutMs = bounded(timeoutMs, 300_000, "Pi operation timeout");
    this.stdout = new PiStream(); this.stderr = new PiStream();
    this.identity = `sandbox-pi:${allocation.sandboxName}:${allocation.sandboxId}:${allocation.bootId}:${allocation.allocationId}:${allocation.generation}:${allocation.pid}:${allocation.procStartTime}:${allocation.uid}:${allocation.argvDigest}`;
    this.stdin = { write: data => this.#write(data) };
    worker.on("exit", () => { this.#supervisorLost = true; this.emit("supervisor_lost"); });
  }
  get exitSignal(): string | null { return this.#exitSignal; }
  get supervisorLost(): boolean { return this.#supervisorLost; }
  kill(signal: "SIGTERM" | "SIGKILL"): boolean {
    if (this.exitCode !== null || this.#closed) return false;
    this.#chain = this.#chain.then(async () => {
      try {
        const result = await this.#channel.invoke("signal-process", { allocation: this.#identityPayload(), signal });
        if (!isRecord(result) || result["accepted"] !== true) throw new SandboxPiProcessError("guest supervisor did not accept the exact process signal");
      } catch (error) { this.#latch(error instanceof Error ? error : new SandboxPiProcessError(String(error))); }
    });
    return true;
  }
  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exitCode !== null) return;
    const timeout = bounded(timeoutMs, 300_000, "Pi exit timeout"); const deadline = Date.now() + timeout;
    while (this.exitCode === null && Date.now() < deadline) {
      if (this.#supervisorLost) throw new SandboxPiProcessError("outer guest worker exited without proof that the inner Pi exited");
      try {
        const result = await this.#channel.invoke("reap-process", { allocation: this.#identityPayload() });
        this.observeResolvedExit(result);
      } catch (error) { this.#latch(error instanceof Error ? error : new SandboxPiProcessError(String(error))); throw this.#failure ?? error; }
      if (this.exitCode !== null) return;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    if (this.exitCode === null) throw new SandboxPiProcessError("inner Pi exit was not observed within the bounded timeout");
  }
  #write(data: string): boolean {
    if (this.#closed || this.exitCode !== null || typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_RPC_LINE_BYTES) return false;
    this.#input += data;
    if (Buffer.byteLength(this.#input, "utf8") > MAX_RPC_LINE_BYTES * 2) { this.#latch(new SandboxPiProcessError("Pi RPC input buffer exceeded its bound")); return false; }
    for (;;) {
      const newline = this.#input.indexOf("\n"); if (newline < 0) break;
      const line = this.#input.slice(0, newline); this.#input = this.#input.slice(newline + 1);
      if (line.length === 0) continue;
      this.#chain = this.#chain.then(() => this.#rpcLine(line)).catch(error => { this.#latch(error instanceof Error ? error : new SandboxPiProcessError(String(error))); });
    }
    return true;
  }
  async #rpcLine(line: string): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line)) throw new SandboxPiProcessError("Pi RPC line is malformed or unbounded");
    let request: unknown; try { request = JSON.parse(line); } catch { throw new SandboxPiProcessError("Pi RPC line is not JSON"); }
    validateRpcRequest(request);
    const result = await this.#channel.invoke("pi-rpc", { allocation: this.#identityPayload(), request });
    if (!isRecord(result) || !Object.hasOwn(result, "lines") || Object.keys(result).some(key => key !== "lines" && key !== "stderr") || !Array.isArray(result["lines"]) || result["lines"].length > 4096 || result["lines"].some(item => typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_RPC_LINE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item))) throw new SandboxPiProcessError("guest Pi RPC bridge response is malformed");
    const outputBytes = result["lines"].reduce((total, output) => total + Buffer.byteLength(`${output}\n`, "utf8"), 0) + (result["stderr"] === undefined ? 0 : typeof result["stderr"] === "string" ? Buffer.byteLength(result["stderr"], "utf8") : Number.POSITIVE_INFINITY);
    if (!Number.isSafeInteger(outputBytes) || outputBytes > 8 * 1024 * 1024 || this.#outputBytes > 8 * 1024 * 1024 - outputBytes) throw new SandboxPiProcessError("guest Pi RPC output exceeded its bounded limit");
    this.#outputBytes += outputBytes;
    for (const output of result["lines"]) this.stdout.push(`${output}\n`);
    if (result["stderr"] !== undefined) { if (typeof result["stderr"] !== "string" || Buffer.byteLength(result["stderr"], "utf8") > MAX_RPC_LINE_BYTES) throw new SandboxPiProcessError("guest Pi stderr response is malformed"); this.stderr.push(result["stderr"]); }
  }
  observeResolvedExit(value: unknown): void {
    if (!isRecord(value) || typeof value["state"] !== "string" || !["running", "exited", "unknown"].includes(value["state"])) throw new SandboxPiProcessError("guest process reaper response is malformed");
    const state = value["state"];
    const expectedKeys = state === "exited" ? ["allocation", "exitCode", "exitSignal", "state"] : ["allocation", "state"];
    if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") || !isRecord(value["allocation"]) || !sameAllocation(value["allocation"], this.allocation)) throw new SandboxPiProcessError("guest process reaper returned a substituted process identity");
    if (value["state"] === "exited") {
      if (typeof value["exitCode"] !== "number" || !Number.isSafeInteger(value["exitCode"]) || value["exitCode"] < 0 || value["exitCode"] > 255 || (value["exitSignal"] !== null && (typeof value["exitSignal"] !== "string" || value["exitSignal"].length > 32 || /[\u0000-\u001f\u007f]/u.test(value["exitSignal"])))) throw new SandboxPiProcessError("guest process exit observation is malformed");
      this.exitCode = value["exitCode"]; this.#exitSignal = value["exitSignal"];
      this.#closed = true; this.#channel.close(); if (this.#worker.exitCode === null) this.#worker.kill("SIGTERM"); this.stdout.end(); this.stderr.end(); this.emit("exit", this.exitCode, this.#exitSignal);
    } else if (value["state"] === "unknown") throw new SandboxPiProcessError("guest process identity is unknown");
  }
  #identityPayload(): SandboxProcessIdentity { return this.allocation; }
  #failure: Error | undefined;
  #latch(error: Error): void { if (this.#failure) return; this.#failure = error; this.#closed = true; this.#channel.close(); if (this.#worker.exitCode === null) this.#worker.kill("SIGTERM"); this.emit("protocol_error", error); }
}

export class SandboxProcessIdentityResolver implements ProcessIdentityResolver {
  readonly #options: Omit<SandboxPiProcessFactoryOptions, "generation" | "role">;
  constructor(options: Omit<SandboxPiProcessFactoryOptions, "generation" | "role">) { if (!options || typeof options !== "object" || Array.isArray(options) || !options.driver || !options.sandbox || typeof options.sandbox !== "object" || !options.release || typeof options.release !== "object") throw new SandboxPiProcessError("sandbox process identity resolver options are required"); assertSandboxRunId(options.runId); assertSandboxObservation(options.sandbox); assertSandboxName(options.sandbox.name); assertSha256(options.helperDigest, "guest helper digest"); if (!isResolvedSandboxRelease(options.release) || !options.release.release.template.helperDigests.includes(options.helperDigest) || options.release.release.promotion.state !== "validated" || options.release.templateReference !== options.driver.release.templateReference || options.release.sbxExecutable !== options.driver.release.sbxExecutable || options.release.release.sbxBinary.sha256 !== options.driver.release.release.sbxBinary.sha256 || options.release.release.releaseId !== options.driver.release.release.releaseId || canonicalJson(options.release.resourceTuple) !== canonicalJson(options.driver.release.resourceTuple) || options.release.release.template.digest !== options.sandbox.templateDigest || !options.sandbox.bootId) throw new SandboxPiProcessError("process identity resolver release or boot identity is substituted"); this.#options = deepFreeze({ ...options, sandbox: { ...options.sandbox } }); }
  async resolve(processIdentity: string, signal?: AbortSignal): Promise<PiProcess | undefined> {
    let allocation: SandboxProcessIdentity;
    try { allocation = parsePublicIdentity(processIdentity); }
    catch { return undefined; }
    if (allocation.sandboxId !== this.#options.sandbox.id || allocation.sandboxName !== this.#options.sandbox.name || allocation.bootId !== this.#options.sandbox.bootId) return undefined;
    let worker: SbxExecHandle | undefined;
    let channel: GuestOperationClient | undefined;
    try {
      worker = await this.#options.driver.execWorker(this.#options.sandbox, signal);
      if (worker.sandboxName !== this.#options.sandbox.name || worker.expectedSandboxId !== this.#options.sandbox.id) throw new SandboxPiProcessError("resolved guest worker identity differs from the sandbox boot");
      const binding: GuestBinding = { runId: this.#options.runId, sandboxName: this.#options.sandbox.name, bootId: this.#options.sandbox.bootId!, operationGeneration: allocation.generation, releaseId: this.#options.release.release.releaseId, helperDigest: this.#options.helperDigest };
      channel = new GuestOperationClient(worker, binding);
      const result = await channel.invoke("reap-process", { allocation, mode: "resolve" }, signal);
      if (!isRecord(result)) throw new SandboxPiProcessError("process identity resolution response is malformed");
      if (result["state"] === "absent") { channel.close(); if (worker.exitCode === null) worker.kill("SIGTERM"); return undefined; }
      if (result["state"] !== "running" && result["state"] !== "exited") throw new SandboxPiProcessError("process identity resolution is unknown");
      if (!isRecord(result["allocation"]) || !sameAllocation(result["allocation"], allocation)) throw new SandboxPiProcessError("process identity resolution returned a substituted allocation");
      if (channel.binding.releaseId !== this.#options.release.release.releaseId || channel.binding.helperDigest !== this.#options.helperDigest) throw new SandboxPiProcessError("resolved guest worker channel release or helper identity is substituted");
      const process = new SandboxPiProcess(worker, channel, this.#options.runId, allocation, 5_000, this.#options.release.release.releaseId, this.#options.helperDigest);
      if (result["state"] === "exited") process.observeResolvedExit(result);
      return process;
    } catch (error) {
      channel?.close();
      if (worker && worker.exitCode === null) worker.kill("SIGTERM");
      throw error;
    }
  }
}

export interface RoleAttachmentDescriptorInput { readonly runId: string; readonly role: Role; readonly process: SandboxPiProcess; readonly sessionId: string; readonly sessionFile: string; }
export function roleAttachmentDescriptor(input: RoleAttachmentDescriptorInput) {
  if (!input || typeof input !== "object" || !(input.process instanceof SandboxPiProcess)) throw new SandboxPiProcessError("role attachment input is required");
  assertSandboxRunId(input.runId);
  if (!ROLES.includes(input.role) || input.process.runId !== input.runId || input.process.exitCode !== null) throw new SandboxPiProcessError("cannot attach a process outside the exact live role identity");
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0 || input.sessionId.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(input.sessionId)) throw new SandboxPiProcessError("role session identity is invalid");
  if (!isCanonicalSessionFile(input.sessionFile, input.role)) throw new SandboxPiProcessError("role session file is not exact and role-bound");
  return Object.freeze({ runId: input.runId, role: input.role, sandboxName: input.process.allocation.sandboxName, sandboxId: input.process.allocation.sandboxId, bootId: input.process.allocation.bootId, allocationId: input.process.allocation.allocationId, generation: input.process.allocation.generation, sessionId: input.sessionId, sessionFile: input.sessionFile, runnerCommand: Object.freeze(["sandbox-pi", input.role, input.process.identity]) });
}

function validatePiLaunch(spec: ProcessLaunch, role: Role, expectedPiExecutable: string, runId: string): void {
  if (!ROLES.includes(role)) throw new SandboxPiProcessError("Pi role is not allowlisted");
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || Object.keys(spec).sort().join("\0") !== "args\0command\0cwd\0env" || typeof spec.command !== "string" || spec.command !== expectedPiExecutable || spec.cwd !== "/ticket/workspace" || !Array.isArray(spec.args) || spec.args.length === 0 || spec.args.length > 128 || spec.args.some(arg => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 4096 || /[\u0000\u007f]/u.test(arg))) throw new SandboxPiProcessError("Pi launch is outside the fixed sandbox path/argv contract");
  const args = spec.args;
  if (args.length < 22 || args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--provider" || args[4] !== "--model" || args[6] !== "--thinking" || args[8] !== "--append-system-prompt" || args[10] !== "--name" || args[11] !== `Squire ${role}` || args.some(item => ["--continue", "--resume", "--fork", "--clone"].some(forbidden => item === forbidden || item.startsWith(`${forbidden}=`))) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(args[3]!) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(args[5]!) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(args[7]!) || typeof args[9] !== "string" || Buffer.byteLength(args[9], "utf8") > 64 * 1024 || /[\u0000\u007f]/u.test(args[9])) throw new SandboxPiProcessError("Pi launch arguments are not the exact trusted RPC form");
  const sessionFlag = args[12]; const sessionValue = args[13];
  if (sessionFlag === "--session" ? !isCanonicalSessionFile(sessionValue!, role) : sessionFlag === "--session-dir" ? sessionValue !== `/ticket/sessions/${role}` : false) throw new SandboxPiProcessError("Pi session path is not exact and role-bound");
  const tail = args.slice(14);
  const fixedTail = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"];
  if (tail.length < fixedTail.length + 4 || fixedTail.some((flag, index) => tail[index] !== flag) || (tail.length - fixedTail.length) % 2 !== 0) throw new SandboxPiProcessError("Pi launch does not disable discovered project resources");
  const extensions = tail.slice(fixedTail.length);
  if (extensions.length !== 4 || extensions[0] !== "--extension" || extensions[2] !== "--extension" || extensions[1] === extensions[3]) throw new SandboxPiProcessError("Pi launch trusted extensions are not the exact ordered pair");
  for (const extension of [extensions[1], extensions[3]]) { try { assertCanonicalSandboxPath(extension!, "Pi trusted extension"); } catch (error) { throw new SandboxPiProcessError(error instanceof Error ? error.message : "Pi trusted extension is not canonical"); } if (!extension!.startsWith("/ticket/runtime/")) throw new SandboxPiProcessError("Pi trusted extension is outside the run runtime"); }
  if (!spec.env || Object.keys(spec.env).some(key => !ALLOWED_ENVIRONMENT.has(key) || key.startsWith("SSH_") || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|GITHUB|LINEAR|NPM|AWS|REGISTRY|DELIVERY)/iu.test(key)) || Object.values(spec.env).some(value => typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) || !Object.hasOwn(spec.env, "PI_SKIP_VERSION_CHECK") || !Object.hasOwn(spec.env, "DOCKER_HOST") || !Object.hasOwn(spec.env, "TMPDIR") || !Object.hasOwn(spec.env, "HOME") || !Object.hasOwn(spec.env, "WIKI_HOME") || !Object.hasOwn(spec.env, "PI_CODING_AGENT_DIR") || spec.env["PI_SKIP_VERSION_CHECK"] !== "1" || spec.env["DOCKER_HOST"] !== "unix:///ticket/docker/run/docker.sock" || spec.env["TMPDIR"] !== "/ticket/tmp" || spec.env["HOME"] !== `/ticket/runtime/${runId}/home` || spec.env["WIKI_HOME"] !== `/ticket/runtime/${runId}/wiki-home` || spec.env["PI_CODING_AGENT_DIR"] !== `/ticket/runtime/${runId}/pi-agent` || ["HTTP_PROXY", "HTTPS_PROXY"].some(key => Object.hasOwn(spec.env, key) && !/^squire-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(spec.env[key]!)) || (Object.hasOwn(spec.env, "NO_PROXY") && !/^squire-no-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(spec.env["NO_PROXY"]!))) throw new SandboxPiProcessError("Pi role environment is not the closed ticket-scoped allowlist");
}

function parseAllocation(value: unknown, options: SandboxPiProcessFactoryOptions, spec: ProcessLaunch): SandboxProcessIdentity {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["allocationId", "argvDigest", "bootId", "generation", "pid", "procStartTime", "sandboxId", "sandboxName", "uid"].sort().join("\0") || typeof value["sandboxName"] !== "string" || typeof value["sandboxId"] !== "string" || typeof value["bootId"] !== "string" || typeof value["allocationId"] !== "string" || typeof value["generation"] !== "number" || typeof value["pid"] !== "number" || typeof value["procStartTime"] !== "string" || typeof value["uid"] !== "number" || typeof value["argvDigest"] !== "string" || !Number.isSafeInteger(value["generation"]) || value["generation"] !== options.generation || !Number.isSafeInteger(value["pid"]) || value["pid"] <= 0 || value["pid"] > 4_194_304 || value["uid"] !== ROLE_UID || value["sandboxName"] !== options.sandbox.name || value["sandboxId"] !== options.sandbox.id || value["bootId"] !== options.sandbox.bootId || value["argvDigest"] !== argvDigest(spec)) throw new SandboxPiProcessError("guest process allocation identity is malformed or substituted");
  assertSha256(value["argvDigest"], "Pi argv digest");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value["allocationId"]) || !/^\d{1,32}$/u.test(value["procStartTime"]) || !/^[^\u0000-\u001f\u007f:]{1,512}$/u.test(value["sandboxId"]) || !/^[^\u0000-\u001f\u007f:]{1,512}$/u.test(value["bootId"])) throw new SandboxPiProcessError("guest process allocation token is invalid");
  return deepFreeze({ sandboxName: value["sandboxName"], sandboxId: value["sandboxId"], bootId: value["bootId"], allocationId: value["allocationId"], generation: value["generation"], pid: value["pid"], procStartTime: value["procStartTime"], uid: value["uid"], argvDigest: value["argvDigest"] }) as SandboxProcessIdentity;
}

function parsePublicIdentity(value: string): SandboxProcessIdentity {
  if (typeof value !== "string" || !value.startsWith("sandbox-pi:")) throw new SandboxPiProcessError("process identity is not a sandbox identity");
  const parts = value.split(":");
  if (parts.length !== 10 || !parts[1] || !parts[2] || !parts[3] || !parts[4] || !/^\d+$/u.test(parts[5]!) || !/^\d+$/u.test(parts[6]!) || !parts[7] || !/^\d{1,32}$/u.test(parts[7]!) || !/^\d+$/u.test(parts[8]!) || !/^[0-9a-f]{64}$/u.test(parts[9]!) || parts.some((part, index) => index > 0 && index < 5 && part.length > 512) || parts[7]!.length > 32) throw new SandboxPiProcessError("sandbox process identity is malformed");
  const allocation = { sandboxName: parts[1]!, sandboxId: parts[2]!, bootId: parts[3]!, allocationId: parts[4]!, generation: Number(parts[5]), pid: Number(parts[6]), procStartTime: parts[7]!, uid: Number(parts[8]), argvDigest: parts[9]! };
  assertSandboxName(allocation.sandboxName); assertSha256(allocation.argvDigest, "sandbox process argv digest");
  if (!Number.isSafeInteger(allocation.generation) || allocation.generation < 1 || !Number.isSafeInteger(allocation.pid) || allocation.pid <= 0 || allocation.pid > 4_194_304 || allocation.uid !== ROLE_UID || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(allocation.allocationId) || !/^\d{1,32}$/u.test(allocation.procStartTime) || /[\u0000-\u001f\u007f\r\n:]/u.test(allocation.sandboxId) || /[\u0000-\u001f\u007f\r\n:]/u.test(allocation.bootId)) throw new SandboxPiProcessError("sandbox process identity fields are unsafe");
  return allocation;
}

function assertSandboxObservation(value: SbxObservedSandbox): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxPiProcessError("sandbox observation is malformed");
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.hasOwn(record, "bootId") ? ["bootId", "id", "name", "status", "templateDigest", "vmId"] : ["id", "name", "status", "templateDigest", "vmId"];
  if (Object.keys(record).sort().join("\0") !== keys.sort().join("\0") || !["created", "running", "stopped", "unknown"].includes(record["status"] as string) || typeof record["name"] !== "string" || typeof record["id"] !== "string" || typeof record["vmId"] !== "string" || !safeIdentity(record["name"]) || !safeIdentity(record["id"]) || !safeIdentity(record["vmId"]) || typeof record["templateDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["templateDigest"] as string) || Object.hasOwn(record, "bootId") && (record["status"] !== "running" || !safeIdentity(record["bootId"]))) throw new SandboxPiProcessError("sandbox observation is malformed");
}
function isCanonicalSessionFile(value: string, role: Role): boolean { return typeof value === "string" && value.length <= 1024 && value.startsWith(`/ticket/sessions/${role}/`) && !value.endsWith("/") && !value.includes("//") && !value.includes("\\") && !value.split("/").some(part => part === "." || part === "..") && /^[A-Za-z0-9._-]+$/.test(value.slice(`/ticket/sessions/${role}/`.length)); }
function argvDigest(spec: ProcessLaunch): string { return sha256Bytes(Buffer.from(canonicalJson({ command: spec.command, args: spec.args, cwd: spec.cwd, environment: spec.env }), "utf8")); }
function withSandboxEnvironment(spec: ProcessLaunch): ProcessLaunch { if (!spec || typeof spec !== "object" || Array.isArray(spec) || !spec.env || typeof spec.env !== "object" || Array.isArray(spec.env)) throw new SandboxPiProcessError("Pi launch is malformed"); if (Object.hasOwn(spec.env, "DOCKER_HOST") && spec.env["DOCKER_HOST"] !== "unix:///ticket/docker/run/docker.sock") throw new SandboxPiProcessError("Pi launch attempted to substitute the private Docker socket"); if (Object.hasOwn(spec.env, "TMPDIR") && spec.env["TMPDIR"] !== "/ticket/tmp") throw new SandboxPiProcessError("Pi launch attempted to substitute its temporary filesystem"); return { ...spec, env: { ...spec.env, TMPDIR: "/ticket/tmp", DOCKER_HOST: "unix:///ticket/docker/run/docker.sock" } }; }
function sameAllocation(value: Record<string, unknown>, expected: SandboxProcessIdentity): boolean { if (Object.keys(value).sort().join("\0") !== ["allocationId", "argvDigest", "bootId", "generation", "pid", "procStartTime", "sandboxId", "sandboxName", "uid"].sort().join("\0")) return false; return value["sandboxName"] === expected.sandboxName && value["sandboxId"] === expected.sandboxId && value["bootId"] === expected.bootId && value["allocationId"] === expected.allocationId && value["generation"] === expected.generation && value["pid"] === expected.pid && value["procStartTime"] === expected.procStartTime && value["uid"] === expected.uid && value["argvDigest"] === expected.argvDigest; }
function assertAllocationIdentity(value: SandboxProcessIdentity): void { if (!value || typeof value !== "object" || !safeIdentity(value.sandboxName) || !safeIdentity(value.sandboxId) || !safeIdentity(value.bootId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.allocationId) || !Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation > 2_147_483_647 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 4_194_304 || !/^\d{1,32}$/u.test(value.procStartTime) || value.uid !== ROLE_UID || !/^[0-9a-f]{64}$/u.test(value.argvDigest)) throw new SandboxPiProcessError("Pi process allocation identity is malformed"); }
function validateRpcRequest(value: unknown): asserts value is Record<string, unknown> { if (!isRecord(value) || typeof value["id"] !== "string" || value["id"].length === 0 || value["id"].length > 128 || /[\u0000-\u001f\u007f\r\n]/u.test(value["id"]) || typeof value["type"] !== "string" || !SUPPORTED_RPC_TYPES.has(value["type"])) throw new SandboxPiProcessError("Pi RPC request is not allowlisted"); const type = value["type"]; const expected: Record<string, readonly string[]> = { get_state: ["id", "type"], get_entries: ["id", "type"], prompt: ["id", "message", "type"], clear_queue: ["id", "type"], abort_retry: ["id", "type"], abort: ["id", "type"] }; const keys = Object.keys(value).sort(); const acceptedKeys = type === "get_entries" && Object.hasOwn(value, "since") ? ["id", "since", "type"].sort() : [...expected[type]!].sort(); if (keys.join("\0") !== acceptedKeys.join("\0") || Object.keys(value).some(key => /[\u0000-\u001f\u007f]/u.test(key)) || (type === "get_entries" && (typeof value["since"] !== "string" || value["since"].length === 0 || value["since"].length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(value["since"]))) || (type === "prompt" && (typeof value["message"] !== "string" || Buffer.byteLength(value["message"], "utf8") > MAX_RPC_LINE_BYTES || /[\u0000-\u001f\u007f\r\n]/u.test(value["message"])))) throw new SandboxPiProcessError("Pi RPC request is not closed or allowlisted"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\r\n:]/u.test(value); }
function assertDigestReferenceSafe(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new SandboxPiProcessError(`${label} must be positive`); return value; }
function bounded(value: number, maximum: number, label: string): number { const result = positive(value, label); if (result > maximum) throw new SandboxPiProcessError(`${label} exceeds its bound`); return result; }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

class PiStream extends EventEmitter {
  push(value: string): void { this.emit("data", value); }
  end(): void { this.emit("end"); }
}
