import type { Writable, Readable } from "node:stream";
import { assertBinding, encodeGuestFrame, GuestFrameDecoder, GuestProtocolError, GUEST_OPERATIONS, MAX_GUEST_FRAME_BYTES, MAX_GUEST_OUTPUT_BYTES, sameBinding, type GuestBinding, type GuestOperationRequest, type GuestOperationResponse } from "./guest-protocol.js";
import { canonicalJson, sha256Bytes } from "./identity.js";

export type GuestOperationHandler = (request: GuestOperationRequest, signal?: AbortSignal) => unknown | Promise<unknown>;
export interface GuestWorkerOptions {
  readonly binding: GuestBinding;
  readonly handlers: Readonly<Partial<Record<GuestOperationRequest["operation"], GuestOperationHandler>>>;
  readonly maxFrameBytes?: number;
  readonly maxOutputBytes?: number;
  readonly operationTimeoutMs?: number;
}

/** The only guest worker entrypoint. It consumes length-prefixed requests over
 * stdio and never opens a listener or accepts ambient environment/config. */
export function serveGuestOperationChannel(input: Readable, output: Writable, options: GuestWorkerOptions): Promise<void> {
  if (!options || typeof options !== "object" || !input || !output || typeof input.on !== "function" || typeof input.once !== "function" || typeof input.destroy !== "function" || typeof output.write !== "function" || typeof output.once !== "function") throw new GuestProtocolError("guest worker channel is not a bounded stdio stream");
  assertBinding(options.binding);
  const maxFrameBytes = bounded(options.maxFrameBytes ?? MAX_GUEST_FRAME_BYTES, MAX_GUEST_FRAME_BYTES, "guest frame limit");
  const maxOutputBytes = bounded(options.maxOutputBytes ?? MAX_GUEST_OUTPUT_BYTES, MAX_GUEST_OUTPUT_BYTES, "guest output limit");
  const operationTimeoutMs = bounded(options.operationTimeoutMs ?? 30_000, 300_000, "guest operation timeout");
  if (!options.handlers || typeof options.handlers !== "object" || Array.isArray(options.handlers) || Object.keys(options.handlers).some(key => !GUEST_OPERATIONS.includes(key as GuestOperationRequest["operation"])) || Object.values(options.handlers).some(handler => handler !== undefined && typeof handler !== "function")) throw new GuestProtocolError("guest worker handlers are not closed");
  const workerOptions: GuestWorkerOptions = Object.freeze({ ...options, binding: Object.freeze({ ...options.binding }), handlers: Object.freeze({ ...options.handlers }) });
  const decoder = new GuestFrameDecoder({ maxFrameBytes, maxOutputBytes });
  let chain = Promise.resolve();
  let outputBytes = 0;
  const seenRequestIds = new Set<string>();
  let failed: Error | undefined;
  let ended = false;
  let settled = false;
  const activeControllers = new Set<AbortController>();
  const fail = (error: unknown): void => {
    if (!failed) failed = error instanceof Error ? error : new GuestProtocolError(String(error));
    for (const controller of activeControllers) controller.abort();
    input.destroy(failed);
    const destroyable = output as Writable & { destroy?: (error?: Error) => void };
    destroyable.destroy?.(failed);
  };
  input.on("data", chunk => {
    if (failed) return;
    try {
      const messages = decoder.push(chunk as Buffer);
      for (const message of messages) {
        if (message.kind !== "squire-guest-operation-request") throw new GuestProtocolError("guest worker received a response frame");
        if (seenRequestIds.has(message.requestId)) throw new GuestProtocolError("guest worker received a duplicate request ID");
        seenRequestIds.add(message.requestId);
        if (seenRequestIds.size > 1_024) throw new GuestProtocolError("guest worker request history exceeded its bound");
        chain = chain.then(async () => { if (failed) throw failed; outputBytes = await handleRequest(message, output, workerOptions, outputBytes, maxFrameBytes, maxOutputBytes, operationTimeoutMs, activeControllers); }).catch(error => { fail(error); });
      }
    } catch (error) { fail(error); }
  });
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => { if (settled) return; settled = true; if (error) reject(error); else if (failed) reject(failed); else resolve(); };
    input.once("end", () => {
      ended = true;
      try { decoder.end(); }
      catch (error) { finish(error); return; }
      void chain.then(() => finish(), finish);
    });
    input.once("error", finish);
    input.once("close", () => { if (!settled && !ended) { const error = failed ?? new GuestProtocolError("guest worker input closed before end"); fail(error); finish(error); } else if (!settled && failed) finish(failed); });
    output.once("error", finish);
  });
}

async function handleRequest(request: GuestOperationRequest, output: Writable, options: GuestWorkerOptions, outputBytes: number, maxFrameBytes: number, maxOutputBytes: number, operationTimeoutMs: number, activeControllers: Set<AbortController>): Promise<number> {
  if (!sameBinding(request.binding, options.binding)) throw new GuestProtocolError("guest request binding does not match the immutable worker binding");
  const handler = Object.hasOwn(options.handlers, request.operation) ? options.handlers[request.operation] : undefined;
  if (!handler) throw new GuestProtocolError(`guest operation is not enabled: ${request.operation}`);
  const controller = new AbortController();
  activeControllers.add(controller);
  const handlerPromise = Promise.resolve().then(() => handler(request, controller.signal));
  void handlerPromise.then(() => activeControllers.delete(controller), () => activeControllers.delete(controller));
  let timer: NodeJS.Timeout | undefined;
  try {
    const data = await Promise.race([handlerPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GuestProtocolError("guest operation timed out")); }, operationTimeoutMs); timer.unref?.(); })]);
    if (controller.signal.aborted) throw new GuestProtocolError("guest operation was aborted");
    return writeResponse({ schemaVersion: 1, kind: "squire-guest-operation-response", requestId: request.requestId, binding: options.binding, operation: request.operation, success: true, ...(data === undefined ? {} : { data }) }, output, outputBytes, maxFrameBytes, maxOutputBytes);
  } catch (error) {
    controller.abort();
    if (error instanceof GuestProtocolError && error.message === "guest operation timed out") throw error;
    const response = workerErrorResponse(request, options.binding, error);
    return writeFrame(response, output, outputBytes, maxOutputBytes);
  } finally { if (timer) clearTimeout(timer); }
}

function writeResponse(response: GuestOperationResponse, output: Writable, outputBytes: number, maxFrameBytes: number, maxOutputBytes: number): number {
  return writeFrame(encodeGuestFrame(response, maxFrameBytes), output, outputBytes, maxOutputBytes);
}
function writeFrame(frame: Buffer, output: Writable, outputBytes: number, maxOutputBytes: number): number {
  if (frame.length > maxOutputBytes || outputBytes > maxOutputBytes - frame.length) throw new GuestProtocolError("guest operation response exceeds output bound");
  // Writable.write(false) is ordinary backpressure after accepting the bytes;
  // treating it as a protocol failure can kill a valid worker under concurrent
  // controller requests. The frame and total output are already bounded.
  output.write(frame);
  return outputBytes + frame.length;
}

export function workerErrorResponse(request: GuestOperationRequest, binding: GuestBinding, error: unknown): Buffer {
  if (!sameBinding(request.binding, binding)) throw new GuestProtocolError("guest worker error binding differs from request");
  const message = error instanceof Error ? error.message : String(error);
  if (message.length === 0 || message.length > 1_000 || /[\u0000-\u001f\u007f]/u.test(message)) throw new GuestProtocolError("guest worker error cannot be represented safely");
  const response: GuestOperationResponse = { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: request.requestId, binding, operation: request.operation, success: false, error: message };
  return encodeGuestFrame(response);
}

function bounded(value: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new GuestProtocolError(`${label} exceeds its bound`); return value; }

export function guestOperationPayloadDigest(request: GuestOperationRequest): string {
  return sha256Bytes(Buffer.from(canonicalJson(request.payload), "utf8"));
}
