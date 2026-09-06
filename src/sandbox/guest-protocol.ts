import { randomUUID } from "node:crypto";
import type { HostProcessReadable, HostProcessWritable } from "./host-process-supervisor.js";
import { assertReleaseId, assertSandboxName, assertSandboxRunId, canonicalJson, deriveSandboxName, sha256Bytes, SHA256_PATTERN } from "./identity.js";

export const GUEST_PROTOCOL_VERSION = 1 as const;
export const MAX_GUEST_FRAME_BYTES = 256 * 1024;
export const MAX_GUEST_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_GUEST_PENDING_OPERATIONS = 1024;
export const MAX_GUEST_OPERATION_TIMEOUT_MS = 300_000;
export const GUEST_OPERATIONS = ["attest", "verify-paths", "import", "export", "canary", "spawn-process", "pi-rpc", "signal-process", "reap-process", "workflow-store"] as const;
export type GuestOperation = (typeof GUEST_OPERATIONS)[number];

export interface GuestBinding {
  readonly runId: string;
  readonly sandboxName: string;
  /** Physical sandbox identity is part of every request binding; a derived
   * name alone is never sufficient to authorize a guest operation. */
  readonly sandboxId: string;
  readonly bootId: string;
  readonly operationGeneration: number;
  readonly releaseId: string;
  readonly helperDigest: string;
}

export interface GuestOperationRequest {
  readonly schemaVersion: typeof GUEST_PROTOCOL_VERSION;
  readonly kind: "squire-guest-operation-request";
  readonly requestId: string;
  readonly binding: GuestBinding;
  readonly operation: GuestOperation;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface GuestOperationResponse {
  readonly schemaVersion: typeof GUEST_PROTOCOL_VERSION;
  readonly kind: "squire-guest-operation-response";
  readonly requestId: string;
  readonly binding: GuestBinding;
  readonly operation: GuestOperation;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/** A narrowly scoped reverse-direction request handler. The guest may issue
 * only the operation explicitly wired by the host composition; ordinary guest
 * operations remain host-request/guest-response only. */
export type GuestOperationRequestHandler = (request: GuestOperationRequest) => unknown | Promise<unknown>;

export interface GuestProtocolLimits {
  readonly maxFrameBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxPendingOperations?: number;
  readonly operationTimeoutMs?: number;
}

export interface GuestOperationProcess {
  readonly stdin: HostProcessWritable;
  readonly stdout: HostProcessReadable;
  readonly exitCode: number | null;
  readonly kill?: (signal: "SIGTERM" | "SIGKILL") => boolean;
  readonly on?: (event: "exit", listener: (code: number | null, signal: string | null) => void) => unknown;
}

export class GuestProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "GuestProtocolError"; }
}

export function makeGuestRequest(binding: GuestBinding, operation: GuestOperation, payload: Readonly<Record<string, unknown>> = {}): GuestOperationRequest {
  assertBinding(binding);
  if (!GUEST_OPERATIONS.includes(operation)) throw new GuestProtocolError("guest operation is not allowlisted");
  if (!isRecord(payload) || Object.keys(payload).some(key => /[\u0000-\u001f\u007f]/u.test(key))) throw new GuestProtocolError("guest operation payload is not a bounded object");
  assertBoundedJson(payload);
  let payloadCopy: Record<string, unknown>;
  try {
    const serialized = canonicalJson(payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_GUEST_FRAME_BYTES) throw new GuestProtocolError("guest operation payload exceeds its frame bound");
    payloadCopy = JSON.parse(serialized) as Record<string, unknown>;
  } catch (error) { throw error instanceof GuestProtocolError ? error : new GuestProtocolError(`guest operation payload is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return Object.freeze({ schemaVersion: 1, kind: "squire-guest-operation-request", requestId: randomUUID(), binding: Object.freeze({ ...binding }), operation, payload: deepFreeze(payloadCopy) });
}

export function encodeGuestFrame(value: GuestOperationRequest | GuestOperationResponse, maxFrameBytes = MAX_GUEST_FRAME_BYTES): Buffer {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 || maxFrameBytes > MAX_GUEST_FRAME_BYTES) throw new GuestProtocolError("guest frame limit is invalid");
  assertGuestMessageValue(value);
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length === 0 || bytes.length > maxFrameBytes || bytes.length > 0xffffffff) throw new GuestProtocolError("guest protocol frame exceeds its bound");
  const frame = Buffer.allocUnsafe(4 + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}

export class GuestFrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #maxOutputBytes: number;
  #buffer = Buffer.alloc(0);
  #seenBytes = 0;
  constructor(limits: GuestProtocolLimits = {}) {
    this.#maxFrameBytes = boundedPositiveInteger(limits.maxFrameBytes ?? MAX_GUEST_FRAME_BYTES, MAX_GUEST_FRAME_BYTES, "guest frame limit");
    this.#maxOutputBytes = boundedPositiveInteger(limits.maxOutputBytes ?? MAX_GUEST_OUTPUT_BYTES, MAX_GUEST_OUTPUT_BYTES, "guest output limit");
  }
  push(chunk: Buffer | Uint8Array | string): readonly (GuestOperationRequest | GuestOperationResponse)[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#seenBytes += bytes.length;
    if (this.#seenBytes > this.#maxOutputBytes) throw new GuestProtocolError("guest protocol stream exceeds its output bound");
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    const result: Array<GuestOperationRequest | GuestOperationResponse> = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > this.#maxFrameBytes) throw new GuestProtocolError("guest frame length is invalid");
      if (this.#buffer.length < length + 4) break;
      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      result.push(parseGuestMessage(payload));
    }
    return result;
  }
  end(): void { if (this.#buffer.length !== 0) throw new GuestProtocolError("guest protocol ended with a truncated frame"); }
}

export function parseGuestMessage(bytes: Uint8Array): GuestOperationRequest | GuestOperationResponse {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_GUEST_FRAME_BYTES) throw new GuestProtocolError("guest message exceeds its frame bound");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new GuestProtocolError(`guest frame is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!isRecord(value) || typeof value["kind"] !== "string") throw new GuestProtocolError("guest message is not an object");
  if (!Buffer.from(canonicalJson(value), "utf8").equals(Buffer.from(bytes))) throw new GuestProtocolError("guest message is not canonically serialized");
  if (value["kind"] === "squire-guest-operation-request") return validateRequest(value);
  if (value["kind"] === "squire-guest-operation-response") return validateResponse(value);
  throw new GuestProtocolError("guest message kind is not supported");
}

export class GuestOperationClient {
  readonly #stdin: HostProcessWritable;
  readonly #decoder: GuestFrameDecoder;
  readonly #binding: GuestBinding;
  readonly #process: { readonly kill?: (signal: "SIGTERM" | "SIGKILL") => boolean };
  readonly #pending = new Map<string, { operation: GuestOperation; resolve: (response: GuestOperationResponse) => void; reject: (error: Error) => void; cleanup: () => void }>();
  readonly #incoming = new Set<string>();
  readonly #requestHandler: GuestOperationRequestHandler | undefined;
  #closed = false;
  #failure: Error | undefined;
  readonly #maxPending: number;
  readonly #operationTimeoutMs: number;
  constructor(process: GuestOperationProcess, binding: GuestBinding, limits: GuestProtocolLimits & { readonly requestHandler?: GuestOperationRequestHandler } = {}) {
    assertBinding(binding);
    if (!process || !process.stdin || typeof process.stdin.write !== "function" || !process.stdout || typeof process.stdout.on !== "function" || (process.on !== undefined && typeof process.on !== "function") || (process.exitCode !== null && !Number.isSafeInteger(process.exitCode))) throw new GuestProtocolError("guest worker process does not expose the required bounded stdio");
    this.#process = process; this.#stdin = process.stdin; this.#binding = Object.freeze({ ...binding }); this.#requestHandler = limits.requestHandler; this.#decoder = new GuestFrameDecoder(limits); this.#maxPending = boundedPositiveInteger(limits.maxPendingOperations ?? 64, MAX_GUEST_PENDING_OPERATIONS, "guest pending operation limit"); this.#operationTimeoutMs = boundedPositiveInteger(limits.operationTimeoutMs ?? 30_000, MAX_GUEST_OPERATION_TIMEOUT_MS, "guest operation timeout");
    if (this.#requestHandler !== undefined && typeof this.#requestHandler !== "function") throw new GuestProtocolError("guest reverse request handler is invalid");
    process.stdout.on("data", chunk => this.#consume(chunk));
    process.stdout.on("end", () => { try { this.#decoder.end(); this.#fail(new GuestProtocolError("guest worker ended")); } catch (error) { this.#fail(asError(error)); } });
    process.on?.("exit", () => this.#fail(new GuestProtocolError("guest worker exited before operation completion")));
    if (process.exitCode !== null) this.#fail(new GuestProtocolError("guest worker was already exited"));
  }

  get binding(): GuestBinding { return this.#binding; }

  invoke(operation: GuestOperation, payload: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed || this.#failure) return Promise.reject(this.#failure ?? new GuestProtocolError("guest operation channel is closed"));
    if (signal?.aborted) return Promise.reject(new GuestProtocolError("guest operation was aborted"));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new GuestProtocolError("guest pending operation limit exceeded"));
    const request = makeGuestRequest(this.#binding, operation, payload);
    const frame = encodeGuestFrame(request);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        const error = new GuestProtocolError("guest operation response timed out");
        this.#fail(error);
      }, this.#operationTimeoutMs); timer.unref?.();
      const onAbort = (): void => this.#fail(new GuestProtocolError("guest operation was aborted"));
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const complete = (callback: () => void): void => { if (settled) return; settled = true; cleanup(); callback(); };
      this.#pending.set(request.requestId, { operation, cleanup, resolve: response => complete(() => resolve(response.data)), reject: error => complete(() => reject(error)) });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try {
        // Writable.write(false) means backpressure, not rejection: the frame
        // has already been accepted by the pipe. The pending-operation bound
        // keeps memory finite while the worker drains it.
        this.#stdin.write(frame);
      } catch (error) { this.#fail(asError(error)); }
    });
  }

  close(): void { this.#closed = true; this.#fail(new GuestProtocolError("guest operation channel closed")); }

  #consume(chunk: Buffer | string): void {
    if (this.#closed) return;
    try { for (const message of this.#decoder.push(chunk)) this.#message(message); }
    catch (error) { this.#fail(asError(error)); }
  }

  #message(message: GuestOperationRequest | GuestOperationResponse): void {
    if (message.kind === "squire-guest-operation-request") {
      if (!this.#requestHandler || message.operation !== "workflow-store" || !sameBinding(message.binding, this.#binding) || this.#pending.has(message.requestId) || this.#incoming.has(message.requestId)) { this.#fail(new GuestProtocolError("guest reverse request is not allowlisted or bound")); return; }
      if (this.#incoming.size >= this.#maxPending) { this.#fail(new GuestProtocolError("guest reverse request limit exceeded")); return; }
      this.#incoming.add(message.requestId);
      void this.#handleReverseRequest(message);
      return;
    }
    if (!sameBinding(message.binding, this.#binding)) { this.#fail(new GuestProtocolError("guest response binding changed")); return; }
    const pending = this.#pending.get(message.requestId);
    if (!pending || pending.operation !== message.operation) { this.#fail(new GuestProtocolError("guest response is uncorrelated or has a mismatched operation")); return; }
    this.#pending.delete(message.requestId);
    if (message.success) pending.resolve(message);
    else pending.reject(new GuestProtocolError(message.error ?? "guest operation failed"));
  }

  async #handleReverseRequest(request: GuestOperationRequest): Promise<void> {
    try {
      const data = await this.#requestHandler!(request);
      if (this.#closed) return;
      const response: GuestOperationResponse = { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: request.requestId, binding: this.#binding, operation: request.operation, success: true, ...(data === undefined ? {} : { data }) };
      this.#send(encodeGuestFrame(response));
    } catch (error) {
      if (this.#closed) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.length === 0 || message.length > 1_000 || /[\u0000-\u001f\u007f\r\n]/u.test(message)) { this.#fail(new GuestProtocolError("guest reverse request failed with an unsafe error")); return; }
      const response: GuestOperationResponse = { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: request.requestId, binding: this.#binding, operation: request.operation, success: false, error: message };
      this.#send(encodeGuestFrame(response));
    } finally { this.#incoming.delete(request.requestId); }
  }

  #send(frame: Buffer): void {
    if (this.#closed) return;
    try { this.#stdin.write(frame); }
    catch (error) { this.#fail(asError(error)); }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error; this.#closed = true;
    try { this.#process.kill?.("SIGTERM"); } catch { /* failure remains latched */ }
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function validateBinding(value: unknown): GuestBinding {
  if (!isRecord(value)) throw new GuestProtocolError("guest binding is not an object");
  const expected = ["bootId", "helperDigest", "operationGeneration", "releaseId", "runId", "sandboxId", "sandboxName"].sort();
  if (Object.keys(value).sort().join("\0") !== expected.join("\0") || typeof value["runId"] !== "string" || typeof value["sandboxName"] !== "string" || typeof value["sandboxId"] !== "string" || typeof value["bootId"] !== "string" || typeof value["releaseId"] !== "string" || typeof value["helperDigest"] !== "string" || typeof value["operationGeneration"] !== "number") throw new GuestProtocolError("guest binding fields are not closed");
  const binding: GuestBinding = { runId: value["runId"], sandboxName: value["sandboxName"], sandboxId: value["sandboxId"], bootId: value["bootId"], operationGeneration: value["operationGeneration"], releaseId: value["releaseId"], helperDigest: value["helperDigest"] };
  assertBinding(binding);
  return binding;
}

export function sameBinding(left: GuestBinding, right: GuestBinding): boolean {
  return left.runId === right.runId && left.sandboxName === right.sandboxName && left.sandboxId === right.sandboxId && left.bootId === right.bootId && left.operationGeneration === right.operationGeneration && left.releaseId === right.releaseId && left.helperDigest === right.helperDigest;
}

function validateRequest(value: Record<string, unknown>): GuestOperationRequest {
  const expected = ["binding", "kind", "operation", "payload", "requestId", "schemaVersion"].sort();
  if (Object.keys(value).sort().join("\0") !== expected.join("\0") || value["schemaVersion"] !== 1 || typeof value["requestId"] !== "string" || typeof value["operation"] !== "string" || !GUEST_OPERATIONS.includes(value["operation"] as GuestOperation) || !isRecord(value["payload"])) throw new GuestProtocolError("guest operation request is malformed");
  validateRequestId(value["requestId"]);
  assertBoundedJson(value["payload"]);
  return { schemaVersion: 1, kind: "squire-guest-operation-request", requestId: value["requestId"], binding: validateBinding(value["binding"]), operation: value["operation"] as GuestOperation, payload: value["payload"] };
}

function validateResponse(value: Record<string, unknown>): GuestOperationResponse {
  const hasData = Object.hasOwn(value, "data"); const hasError = Object.hasOwn(value, "error");
  const expected = ["binding", "kind", "operation", "requestId", "schemaVersion", "success", ...(hasData ? ["data"] : []), ...(hasError ? ["error"] : [])].sort();
  if (Object.keys(value).sort().join("\0") !== expected.join("\0") || value["schemaVersion"] !== 1 || typeof value["requestId"] !== "string" || typeof value["operation"] !== "string" || !GUEST_OPERATIONS.includes(value["operation"] as GuestOperation) || typeof value["success"] !== "boolean" || (value["success"] && hasError) || (!value["success"] && (!hasError || typeof value["error"] !== "string" || hasData))) throw new GuestProtocolError("guest operation response is malformed");
  validateRequestId(value["requestId"]);
  if (hasError && (String(value["error"]).length === 0 || String(value["error"]).length > 1_000 || /[\u0000-\u001f\u007f]/u.test(String(value["error"])))) throw new GuestProtocolError("guest operation error is invalid");
  if (hasData) assertBoundedJson(value["data"]);
  return { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: value["requestId"], binding: validateBinding(value["binding"]), operation: value["operation"] as GuestOperation, success: value["success"], ...(hasData ? { data: value["data"] } : {}), ...(hasError ? { error: value["error"] as string } : {}) };
}

export function assertBinding(binding: GuestBinding): void {
  if (!binding || typeof binding.runId !== "string" || typeof binding.sandboxName !== "string" || typeof binding.sandboxId !== "string" || typeof binding.bootId !== "string" || typeof binding.releaseId !== "string" || typeof binding.helperDigest !== "string" || !Number.isSafeInteger(binding.operationGeneration) || binding.operationGeneration < 1 || [binding.runId, binding.sandboxName, binding.sandboxId, binding.bootId, binding.releaseId].some(value => value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f\r\n:]/u.test(value)) || !SHA256_PATTERN.test(binding.helperDigest)) throw new GuestProtocolError("guest binding is invalid");
  try { assertSandboxRunId(binding.runId); assertSandboxName(binding.sandboxName); assertReleaseId(binding.releaseId); }
  catch (error) { throw new GuestProtocolError(error instanceof Error ? error.message : "guest binding identity is invalid"); }
  if (binding.sandboxName !== deriveSandboxName(binding.runId)) throw new GuestProtocolError("guest binding sandbox name is not derived from the run");
  if (binding.operationGeneration > 2_147_483_647) throw new GuestProtocolError("guest operation generation exceeds its bound");
}

function validateRequestId(value: unknown): void { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new GuestProtocolError("guest request ID is invalid"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new GuestProtocolError(`${label} must be positive`); return value; }
function boundedPositiveInteger(value: number, maximum: number, label: string): number { const result = positiveInteger(value, label); if (result > maximum) throw new GuestProtocolError(`${label} exceeds its bound`); return result; }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
function assertGuestMessageValue(value: unknown): void {
  if (!isRecord(value)) throw new GuestProtocolError("guest message is not an object");
  if (value["kind"] === "squire-guest-operation-request") validateRequest(value);
  else if (value["kind"] === "squire-guest-operation-response") validateResponse(value);
  else throw new GuestProtocolError("guest message kind is not supported");
  assertBoundedJson(value);
}

function assertBoundedJson(value: unknown, depth = 0, seen = new WeakSet<object>(), nodes = { count: 0 }): void {
  if (depth > 32 || ++nodes.count > 10_000) throw new GuestProtocolError("guest JSON payload exceeds its structural bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") { if (typeof value === "string" && value.length > 64 * 1024) throw new GuestProtocolError("guest JSON string exceeds its bound"); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new GuestProtocolError("guest JSON number is not finite"); return; }
  if (typeof value !== "object") throw new GuestProtocolError("guest JSON contains an unsupported value");
  if (seen.has(value)) throw new GuestProtocolError("guest JSON contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) { if (value.length > 4_096) throw new GuestProtocolError("guest JSON array exceeds its bound"); for (const child of value) assertBoundedJson(child, depth + 1, seen, nodes); }
  else { const keys = Object.keys(value); if (keys.length > 512) throw new GuestProtocolError("guest JSON object exceeds its bound"); for (const key of keys) { if (key.length > 256 || /[\u0000-\u001f\u007f]/u.test(key)) throw new GuestProtocolError("guest JSON key is invalid"); assertBoundedJson((value as Record<string, unknown>)[key], depth + 1, seen, nodes); } }
  seen.delete(value);
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
export function guestOperationPayloadDigest(request: GuestOperationRequest): string { assertBoundedJson(request.payload); return sha256Bytes(Buffer.from(canonicalJson(request.payload), "utf8")); }
