import { ACTIVE_STATES, TERMINAL_STATES, type RunSnapshot } from "../control/domain.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import { assertBinding, GuestOperationClient, sameBinding, validateBinding, type GuestBinding, type GuestOperationProcess, type GuestOperationRequest, type GuestProtocolLimits } from "./guest-protocol.js";
import { assertSandboxRunId, UUID_PATTERN } from "./identity.js";

export type WorkflowStoreRpcAuthority = Pick<WorkflowStore, "read" | "assertRunStartAllowed">;

export interface WorkflowStoreRpcMediator {
  readonly channel: GuestOperationClient;
  readonly server: WorkflowStoreRpcServer;
  readonly client: WorkflowStoreRpcClient;
  close(): void;
}

/** Build the one host/guest bridge that is allowed to answer reverse
 * workflow-store requests. The guest operation channel remains bound to the
 * exact boot and sandbox identity; no generic store object or callback is
 * placed in a guest payload. */
export function createWorkflowStoreRpcMediator(process: GuestOperationProcess, store: WorkflowStoreRpcAuthority, binding: GuestBinding, limits: GuestProtocolLimits = {}): WorkflowStoreRpcMediator {
  const server = new WorkflowStoreRpcServer(store, binding);
  const channel = new GuestOperationClient(process, binding, { ...limits, requestHandler: request => server.handle(request) });
  const client = new WorkflowStoreRpcClient(channel);
  return { channel, server, client, close: () => channel.close() };
}

const METHODS = ["read", "assertRunStartAllowed"] as const;
type WorkflowStoreRpcMethod = (typeof METHODS)[number];

export class WorkflowStoreRpcError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowStoreRpcError"; }
}

/** Controller-side dispatcher. It exposes no CAS callback, SQL, filesystem,
 * lease token minting, or generic method invocation to a guest. */
export class WorkflowStoreRpcServer {
  readonly #store: WorkflowStoreRpcAuthority;
  readonly #runId: string;
  readonly #binding: GuestBinding;
  constructor(store: WorkflowStoreRpcAuthority, binding: GuestBinding) { if (!store || typeof store.read !== "function" || typeof store.assertRunStartAllowed !== "function") throw new WorkflowStoreRpcError("workflow store RPC requires its read/start authority"); this.#store = store; assertBinding(binding); this.#binding = Object.freeze({ ...binding }); this.#runId = assertSandboxRunId(binding.runId); }
  async handle(request: GuestOperationRequest): Promise<unknown> {
    if (!isRecord(request) || Object.keys(request).sort().join("\0") !== ["binding", "kind", "operation", "payload", "requestId", "schemaVersion"].sort().join("\0") || request.schemaVersion !== 1 || request.kind !== "squire-guest-operation-request" || typeof request.requestId !== "string" || !UUID_PATTERN.test(request.requestId) || !isRecord(request.binding) || !isRecord(request.payload) || request.operation !== "workflow-store") throw new WorkflowStoreRpcError("workflow store RPC identity or operation binding mismatch");
    let requestBinding: GuestBinding;
    try { requestBinding = validateBinding(request.binding); }
    catch (error) { throw new WorkflowStoreRpcError(error instanceof Error ? error.message : "workflow store request binding is invalid"); }
    if (!sameBinding(requestBinding, this.#binding)) throw new WorkflowStoreRpcError("workflow store RPC identity or operation binding mismatch");
    const payload = request.payload;
    if (Object.keys(payload).some(key => key !== "method" && key !== "args") || typeof payload["method"] !== "string" || !METHODS.includes(payload["method"] as WorkflowStoreRpcMethod) || !isRecord(payload["args"])) throw new WorkflowStoreRpcError("workflow store RPC envelope is not closed");
    const method = payload["method"] as WorkflowStoreRpcMethod;
    const args = payload["args"];
    assertMethodArgs(method, args);
    switch (method) {
      case "read": return safeWorkflowSnapshot(await this.#store.read(this.#runId), this.#runId);
      case "assertRunStartAllowed": await this.#store.assertRunStartAllowed(this.#runId, numberArg(args, "now", Date.now())); return { ok: true };
    }
  }
}

/** Guest-side typed client. A guest never sees the underlying WorkflowStore;
 * all calls are bound to the worker's run/sandbox/boot generation. */
export interface WorkflowStoreRpcPort {
  read(): Promise<GuestWorkflowSnapshot | undefined>;
  assertRunStartAllowed(now?: number): Promise<void>;
}

export class WorkflowStoreRpcClient implements WorkflowStoreRpcPort {
  readonly #channel: GuestOperationClient;
  constructor(channel: GuestOperationClient) { if (!channel || typeof channel.invoke !== "function") throw new WorkflowStoreRpcError("workflow store RPC client requires a guest channel"); this.#channel = channel; }
  async read(): Promise<GuestWorkflowSnapshot | undefined> { return validateGuestWorkflowSnapshot(await this.#channel.invoke("workflow-store", { method: "read", args: {} })); }
  async assertRunStartAllowed(now?: number): Promise<void> { const result = await this.#call("assertRunStartAllowed", { ...(now !== undefined ? { now } : {}) }); if (!isRecord(result) || Object.keys(result).sort().join("\0") !== "ok" || result["ok"] !== true) throw new WorkflowStoreRpcError("workflow store start authorization response is malformed"); }
  async #call(method: WorkflowStoreRpcMethod, args: Readonly<Record<string, unknown>>): Promise<unknown> { return this.#channel.invoke("workflow-store", { method, args }); }
}

export interface GuestWorkflowSnapshot {
  readonly runId: string;
  readonly version: number;
  readonly state: RunSnapshot["state"];
  readonly currentHead: string;
  readonly implementGeneration: number;
}

function safeWorkflowSnapshot(snapshot: RunSnapshot | undefined, runId: string): GuestWorkflowSnapshot | undefined {
  if (!snapshot) return undefined;
  if (!isRecord(snapshot) || snapshot["runId"] !== runId || !Number.isSafeInteger(snapshot["version"]) || (snapshot["version"] as number) < 0 || (snapshot["version"] as number) > 9_007_199_254_740_991 || ![...ACTIVE_STATES, ...TERMINAL_STATES].includes(snapshot["state"] as RunSnapshot["state"]) || typeof snapshot["currentHead"] !== "string" || snapshot["currentHead"].length === 0 || snapshot["currentHead"].length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(snapshot["currentHead"]) || !Number.isSafeInteger(snapshot["implementGeneration"]) || (snapshot["implementGeneration"] as number) < 0 || (snapshot["implementGeneration"] as number) > 2_147_483_647) throw new WorkflowStoreRpcError("workflow store returned an invalid guest snapshot");
  return Object.freeze({ runId, version: snapshot["version"] as number, state: snapshot["state"] as RunSnapshot["state"], currentHead: snapshot["currentHead"] as string, implementGeneration: snapshot["implementGeneration"] as number });
}
function validateGuestWorkflowSnapshot(value: unknown): GuestWorkflowSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["currentHead", "implementGeneration", "runId", "state", "version"].sort().join("\0") || typeof value["runId"] !== "string" || typeof value["state"] !== "string" || typeof value["currentHead"] !== "string" || typeof value["version"] !== "number" || typeof value["implementGeneration"] !== "number") throw new WorkflowStoreRpcError("workflow store guest snapshot is malformed");
  return safeWorkflowSnapshot(value as unknown as RunSnapshot, value["runId"] as string)!;
}

function assertMethodArgs(method: WorkflowStoreRpcMethod, args: Record<string, unknown>): void {
  const allowed: Record<WorkflowStoreRpcMethod, readonly string[]> = { read: [], assertRunStartAllowed: ["now"] };
  if (Object.keys(args).some(key => !allowed[method].includes(key))) throw new WorkflowStoreRpcError(`workflow store RPC ${method} arguments are not closed`);
}
function stringArg(args: Record<string, unknown>, key: string): string { const value = args[key]; if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new WorkflowStoreRpcError(`workflow store RPC ${key} is invalid`); return value; }
function numberArg(args: Record<string, unknown>, key: string, fallback: number): number { const value = Object.hasOwn(args, key) ? args[key] : fallback; if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0 || value > 9_007_199_254_740_991) throw new WorkflowStoreRpcError(`workflow store RPC ${key} is invalid`); return value; }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
