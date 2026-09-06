import type { SandboxRecord } from "./domain.js";
import type { SandboxLifecycleService } from "./lifecycle-service.js";
import type { SandboxDriver } from "./sbx-v039-driver.js";
import type { SbxObservedSandbox } from "./sbx-command.js";
import { assertSandboxName, assertSandboxRunId, assertDigestReference, deriveSandboxName } from "./identity.js";
import { assertSandboxRecordMutation } from "./sandbox-record-guard.js";

export type SandboxRecoveryDisposition = "retry-create" | "adopt-created" | "reattest-running" | "already-removed" | "blocked";
export interface SandboxRecoveryObservation {
  readonly runId: string;
  readonly record: SandboxRecord;
  readonly disposition: SandboxRecoveryDisposition;
  readonly observed?: { readonly id: string; readonly vmId: string; readonly status: string; readonly templateDigest: string; readonly bootId?: string };
}

export class SandboxRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxRecoveryError"; }
}

/** Bounded startup/restart classification. It never adopts a same-name
 * resource without matching immutable template identity and leaves unknown
 * resources for operator review. */
export class SandboxRecoveryService {
  readonly #driver: SandboxDriver;
  readonly #lifecycle: SandboxLifecycleService;
  constructor(driver: SandboxDriver, lifecycle: SandboxLifecycleService) { if (!driver || typeof driver.inspect !== "function" || !lifecycle || typeof lifecycle.reconcile !== "function") throw new SandboxRecoveryError("sandbox recovery requires its lifecycle and driver authorities"); this.#driver = driver; this.#lifecycle = lifecycle; }
  async inspect(runId: string, record: SandboxRecord, signal?: AbortSignal): Promise<SandboxRecoveryObservation> {
    assertSandboxRunId(runId); if (!record || typeof record !== "object" || Array.isArray(record)) throw new SandboxRecoveryError("sandbox recovery record is required");
    try { assertSandboxRecordMutation(record, record, runId); } catch (error) { throw new SandboxRecoveryError(error instanceof Error ? error.message : "sandbox recovery record is malformed"); }
    assertSandboxName(record.sandboxName);
    if (record.runId !== runId || record.sandboxName !== deriveSandboxName(runId)) throw new SandboxRecoveryError("sandbox recovery run identity changed");
    assertDigestReference(record.templateDigest, "sandbox recovery template digest");
    if (record.identity && record.identity.templateDigest !== record.templateDigest) throw new SandboxRecoveryError("sandbox recovery record template identity changed");
    if (record.lifecycle === "removed") return { runId, record, disposition: "already-removed" };
    if (record.lifecycle === "blocked") return { runId, record, disposition: "blocked" };
    // A transfer reservation owns private staging and a guest channel. After a
    // controller restart its completion cannot be inferred from sandbox
    // inspection; require the lifecycle owner to re-drive or fence it rather
    // than reattesting/reusing a possibly replayed generation.
    if (record.operation?.kind === "transfer") return { runId, record, disposition: "blocked" };
    if (signal?.aborted) throw new SandboxRecoveryError("sandbox recovery inspection was aborted");
    const observed = await this.#driver.inspect(record.sandboxName, signal);
    if (observed) assertObservedSandbox(observed);
    if (!observed) {
      if (record.lifecycle === "creating" && record.operation?.intent === "create") return { runId, record, disposition: "retry-create" };
      throw new SandboxRecoveryError("sandbox is absent without a retryable create intent");
    }
    if (!record.identity) throw new SandboxRecoveryError("same-name sandbox cannot be adopted without a persisted exact identity");
    if (observed.name !== record.sandboxName || observed.templateDigest !== record.templateDigest || observed.id !== record.identity.sandboxId || observed.vmId !== record.identity.vmId || !observed.id || !observed.vmId) throw new SandboxRecoveryError("same-name sandbox has a substituted immutable identity");
    if (observed.status === "running" && (record.bootId !== undefined && observed.bootId !== record.bootId || record.identity.bootId !== undefined && observed.bootId !== record.identity.bootId)) throw new SandboxRecoveryError("sandbox boot identity changed across recovery");
    if (observed.status === "unknown" || observed.status === "running" && !observed.bootId) throw new SandboxRecoveryError("sandbox observation is unknown");
    if (observed.status === "running") return { runId, record, disposition: "reattest-running", observed };
    return { runId, record, disposition: "adopt-created", observed };
  }
  async reconcile(runId: string, signal?: AbortSignal): Promise<SandboxRecoveryObservation | undefined> { const result = await this.#lifecycle.reconcile(runId, signal); return result ? this.inspect(runId, result.sandbox, signal) : undefined; }
}

function assertObservedSandbox(value: SbxObservedSandbox): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxRecoveryError("sandbox recovery observation is malformed");
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.hasOwn(record, "bootId") ? ["bootId", "id", "name", "status", "templateDigest", "vmId"] : ["id", "name", "status", "templateDigest", "vmId"];
  if (Object.keys(record).sort().join("\0") !== keys.sort().join("\0") || !["created", "running", "stopped", "unknown"].includes(record["status"] as string) || !safeText(record["name"]) || !safeText(record["id"]) || !safeText(record["vmId"]) || typeof record["templateDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["templateDigest"] as string) || Object.hasOwn(record, "bootId") && (record["status"] !== "running" || !safeText(record["bootId"]))) throw new SandboxRecoveryError("sandbox recovery observation is malformed");
}
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
