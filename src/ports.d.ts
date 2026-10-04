/** Versioned Squire-native contracts. Harness types/auth never enter the controller. */
export interface AgentJob {
  version: 1; id: string; role: 'plan' | 'implement' | 'review';
  workspace: string; directory: string; instructions: string;
  timeoutSeconds: number; backoffSeconds: number;
  /** Only the explicitly approved inline public goal; durable job.started records this digest. */
  publicContract?: { sha256: string; bytes: number };
  signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void;
}
export interface RuntimeEvent { version: 1; jobId: string; type: string; sessionRef?: string; usage?: Record<string, number>; requestedModel?: string | null; requestedReasoning?: string | null; reportedModel?: string | null; reportedReasoning?: string | null; }
export interface AgentResult {
  outcome: 'completed' | 'waiting_capacity'; sessionRef?: string; result?: unknown;
  usage?: Record<string, number>; retryAt?: number; detail?: string; receipt?: unknown;
  requestedModel?: string | null; requestedReasoning?: string | null;
  reportedModel?: string | null; reportedReasoning?: string | null;
}
export interface AgentRuntime {
  version: 1;
  capabilities: { roles: string[]; freshSession: boolean; subscription: boolean; artifacts: string; resume: boolean };
  preflight(signal?: AbortSignal): Promise<unknown>;
  /** Adapter owns provider start/stream/cancel. AbortSignal cancels its job. */
  execute(job: AgentJob): Promise<AgentResult>;
}
export interface DeliveryProvider {
  preflight(service: unknown): Promise<unknown>;
  publish(ticket: unknown, service: unknown, signal?: AbortSignal): Promise<unknown>;
  inspect(ticket: unknown, service: unknown): Promise<{ state: string; mergeSha?: string; treeSha?: string }>;
  merge(ticket: unknown, service: unknown, signal?: AbortSignal): Promise<{ state?: string; mergeSha?: string; treeSha?: string }>;
}
// WorkspaceProvider/VerificationRunner expose the structural methods of the
// corresponding built-in classes. Remote adapters materialize artifacts before
// execute resolves; the controller then checkpoints the actual Git tree.
// TicketSource uses version-1 project/ticket JSON through the control API.
// EventSink consumes ordered, cursor-addressed version-1 events from Store.
