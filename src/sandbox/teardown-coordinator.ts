import { randomUUID } from "node:crypto";
import type { Clock, Lease, RunTerminalFence } from "../control/domain.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import type { SandboxLifecycleService } from "./lifecycle-service.js";
import type { GitDisposalAuthorization } from "../git/domain.js";
import { assertSandboxRunId } from "./identity.js";

export interface SandboxTeardownComponents {
  /** Abort and resolve every exact role allocation and host guest worker. */
  readonly reapRoleProcesses: (runId: string, signal?: AbortSignal) => Promise<void>;
  /** AIDEV-222 component disposal under the already-held global fence. */
  readonly disposeGit: (runId: string, fence: RunTerminalFence, authorization: GitDisposalAuthorization, signal?: AbortSignal) => Promise<void>;
  /** Reads the persisted AIDEV-222 retention authorization; the Git service
   * still validates it against its own trusted clock and record. */
  readonly getGitDisposalAuthorization: (runId: string, now: number, signal?: AbortSignal) => Promise<GitDisposalAuthorization> | GitDisposalAuthorization;
  /** AIDEV-228 component disposal under the already-held global fence. */
  readonly disposePiAgentDirectory: (runId: string, fence: RunTerminalFence, signal?: AbortSignal) => Promise<void>;
  /** Remove stale transfer temporaries only after no active transfer remains. */
  readonly cleanupTransfers: (runId: string, signal?: AbortSignal) => Promise<void>;
  /** Revoke and independently verify sandbox-scoped model credentials. */
  readonly revokeScopedSecrets: (runId: string, signal?: AbortSignal) => Promise<void>;
  /** Final host inventory proving no scoped secret or child remains. */
  readonly assertNoScopedResources: (runId: string, signal?: AbortSignal) => Promise<void>;
}
export interface TeardownCoordinatorOptions {
  readonly store: WorkflowStore;
  readonly sandbox: SandboxLifecycleService;
  readonly components: SandboxTeardownComponents;
  readonly clock: Clock;
  readonly reason?: "retention" | "terminal" | "operator";
  readonly ownerPrefix?: string;
  readonly isRemovalDue?: (runId: string, now: number) => Promise<boolean> | boolean;
  readonly operationLeaseMs?: number;
}

export class TeardownCoordinatorError extends Error {
  constructor(message: string) { super(message); this.name = "TeardownCoordinatorError"; }
}

/** Sole owner of the aggregate teardown. It creates the durable drain first,
 * uses AIDEV-216's terminal fence, and calls completion only after every
 * component and exact sandbox resource has been removed. */
export class SandboxTeardownCoordinator {
  readonly #store: WorkflowStore;
  readonly #sandbox: SandboxLifecycleService;
  readonly #components: SandboxTeardownComponents;
  readonly #clock: Clock;
  readonly #reason: "retention" | "terminal" | "operator";
  readonly #ownerPrefix: string;
  readonly #isRemovalDue: ((runId: string, now: number) => Promise<boolean> | boolean) | undefined;
  readonly #operationLeaseMs: number;
  constructor(options: TeardownCoordinatorOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new TeardownCoordinatorError("aggregate teardown options are required");
    if (!options.store || typeof options.store.beginRunTeardown !== "function" || typeof options.store.acquireRunTerminalFence !== "function" || typeof options.store.assertRunTeardownQuiescent !== "function" || typeof options.store.completeRunTeardown !== "function" || !options.sandbox || typeof options.sandbox.remove !== "function" || !options.clock || typeof options.clock.now !== "function" || !options.components || typeof options.components.reapRoleProcesses !== "function" || typeof options.components.disposeGit !== "function" || typeof options.components.getGitDisposalAuthorization !== "function" || typeof options.components.disposePiAgentDirectory !== "function" || typeof options.components.cleanupTransfers !== "function" || typeof options.components.revokeScopedSecrets !== "function" || typeof options.components.assertNoScopedResources !== "function") throw new TeardownCoordinatorError("aggregate teardown requires every exact component cleanup authority");
    if (typeof options.store.acquireRunTeardownLease !== "function" || typeof options.store.releaseRunTeardownLease !== "function" || typeof options.store.blockRunTeardown !== "function" || typeof options.store.renewRunTeardownLease !== "function") throw new TeardownCoordinatorError("aggregate teardown requires the durable teardown lease/block authority");
    if (options.isRemovalDue !== undefined && typeof options.isRemovalDue !== "function") throw new TeardownCoordinatorError("teardown deadline authority is invalid");
    this.#store = options.store; this.#sandbox = options.sandbox; this.#components = options.components; this.#clock = options.clock; this.#reason = options.reason ?? "retention"; this.#ownerPrefix = options.ownerPrefix ?? "sandbox-teardown"; this.#isRemovalDue = options.isRemovalDue; this.#operationLeaseMs = positiveBounded(options.operationLeaseMs ?? 30_000, 300_000, "teardown operation lease");
    if (!["retention", "terminal", "operator"].includes(this.#reason) || this.#reason === "retention" && !this.#isRemovalDue) throw new TeardownCoordinatorError("retention teardown requires a trusted deadline authority");
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(this.#ownerPrefix)) throw new TeardownCoordinatorError("teardown owner prefix is invalid");
  }

  async teardown(runId: string, signal?: AbortSignal): Promise<RunTerminalFence> {
    assertSandboxRunId(runId);
    const now = this.#clock.now();
    if (this.#isRemovalDue && !await this.#isRemovalDue(runId, now)) throw new TeardownCoordinatorError("sandbox retention deadline has not expired");
    const requestedOwner = `${this.#ownerPrefix}-${randomUUID()}`;
    if (signal?.aborted) throw new TeardownCoordinatorError("aggregate teardown was aborted");
    let drain: import("./domain.js").RunTeardownRecord | undefined;
    let teardownLease: Lease | undefined;
    let ownsTeardownLease = false;
    const activeOperations = new Set<Promise<unknown>>();
    const waitForActiveOperations = async (): Promise<void> => {
      while (activeOperations.size > 0) await Promise.allSettled([...activeOperations]);
    };
    try {
      drain = await this.#store.beginRunTeardown(runId, requestedOwner, this.#reason, now);
      if (drain.runId !== runId || drain.reason !== this.#reason || (drain.state !== "draining" && drain.state !== "fenced" && drain.state !== "blocked" && drain.state !== "completed")) throw new TeardownCoordinatorError("aggregate teardown returned an invalid durable drain");
      if (drain.state === "blocked" || drain.state === "completed") throw new TeardownCoordinatorError("aggregate teardown is durably blocked");
      const acquireLease = this.#store.acquireRunTeardownLease;
      const renewLease = this.#store.renewRunTeardownLease;
      const releaseLease = this.#store.releaseRunTeardownLease;
      if (!acquireLease || !renewLease || !releaseLease || !this.#store.blockRunTeardown) throw new TeardownCoordinatorError("aggregate teardown requires the durable teardown lease/block authority");
      // The durable drain owner identifies the original intent. The
      // short-lived lease owner is fresh on every controller attempt, so a
      // second controller cannot accidentally reuse an active owner's token.
      const owner = requestedOwner;
      teardownLease = await acquireLease.call(this.#store, runId, owner, this.#clock.now(), this.#operationLeaseMs);
      if (!teardownLease || teardownLease.key !== "teardown" || teardownLease.owner !== owner || !Number.isSafeInteger(teardownLease.fencingToken) || teardownLease.fencingToken <= 0 || !Number.isSafeInteger(teardownLease.expiresAt) || teardownLease.expiresAt <= this.#clock.now()) throw new TeardownCoordinatorError("aggregate teardown is already owned or its durable drain cannot be leased");
      ownsTeardownLease = true;

      // Keep the short-lived aggregate lease alive while a component is doing
      // bounded cleanup. A permanent drain/fence prevents new work, while
      // this lease prevents two controllers from concurrently disposing the
      // same component. A failed renewal aborts the component signal and
      // leaves the durable drain blocked for exact operator recovery.
      let leaseFailure: Error | undefined;
      let currentLease = teardownLease;
      let renewChain = Promise.resolve();
      const renew = async (): Promise<void> => {
        const operation = renewChain.then(async () => {
          if (leaseFailure) throw leaseFailure;
          const renewed = await renewLease.call(this.#store, runId, currentLease.owner, currentLease.fencingToken, this.#clock.now(), this.#operationLeaseMs);
          if (!renewed) throw new TeardownCoordinatorError("aggregate teardown lease was fenced or expired");
          currentLease = renewed;
          teardownLease = renewed;
        });
        renewChain = operation.then(() => undefined, () => undefined);
        try { await operation; }
        catch (error) {
          const failure = error instanceof Error ? error : new TeardownCoordinatorError(String(error));
          leaseFailure ??= failure;
          throw failure;
        }
      };
      const abortController = new AbortController();
      const onAbort = (): void => abortController.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const heartbeat = setInterval(() => {
        void renew().catch(() => abortController.abort());
      }, Math.max(25, Math.min(1_000, Math.floor(this.#operationLeaseMs / 3))));
      heartbeat.unref?.();
      const step = async <T>(operation: (stepSignal: AbortSignal) => Promise<T>): Promise<T> => {
        if (signal?.aborted || abortController.signal.aborted) throw new TeardownCoordinatorError("aggregate teardown was aborted or its lease was lost");
        await renew();
        let operationPromise: Promise<T>;
        try { operationPromise = Promise.resolve(operation(abortController.signal)); }
        catch (error) { operationPromise = Promise.reject(error); }
        let tracked!: Promise<unknown>;
        tracked = operationPromise.then(
          value => { activeOperations.delete(tracked); return value; },
          error => { activeOperations.delete(tracked); throw error; },
        );
        activeOperations.add(tracked);
        void tracked.catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        let abortStep!: () => void;
        const aborted = new Promise<never>((_, reject) => { abortStep = () => reject(new TeardownCoordinatorError("aggregate teardown was aborted or its lease was lost")); abortController.signal.addEventListener("abort", abortStep, { once: true }); });
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { abortController.abort(); reject(new TeardownCoordinatorError("aggregate teardown component exceeded its bounded deadline")); }, this.#operationLeaseMs); timer.unref?.(); });
        let result: T;
        try { result = await Promise.race([operationPromise, aborted, deadline]); }
        finally { if (timer) clearTimeout(timer); abortController.signal.removeEventListener("abort", abortStep); }
        await renew();
        if (leaseFailure || signal?.aborted || abortController.signal.aborted) throw new TeardownCoordinatorError("aggregate teardown lease was lost during component cleanup");
        return result;
      };
      try {
        // Drain is durable before any process/child cleanup. The fresh
        // short-lived owner also owns a newly acquired terminal fence; a
        // resumed fence is adopted only when the store returns its exact
        // existing identity. A role launched after this line must be rejected
        // by the shared authority.
        await step(stepSignal => this.#components.reapRoleProcesses(runId, stepSignal));
        let fence: RunTerminalFence;
        try { fence = await step(stepSignal => this.#store.acquireRunTerminalFence(runId, owner, this.#clock.now())); }
        catch (error) { throw new TeardownCoordinatorError(`terminal fence could not be acquired after drain: ${error instanceof Error ? error.message : String(error)}`); }
        await step(() => this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()));
        await step(stepSignal => this.#components.cleanupTransfers(runId, stepSignal));
        await step(() => this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()));
        const gitAuthorization = await step(stepSignal => Promise.resolve(this.#components.getGitDisposalAuthorization(runId, this.#clock.now(), stepSignal)).then(authorization => { assertGitDisposalAuthorization(authorization); return authorization; }));
        await step(stepSignal => this.#components.disposeGit(runId, fence, gitAuthorization, stepSignal));
        await step(() => this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()));
        await step(stepSignal => this.#components.disposePiAgentDirectory(runId, fence, stepSignal));
        await step(() => this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()));
        await step(stepSignal => this.#components.revokeScopedSecrets(runId, stepSignal));
        await step(() => this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()));
        await step(stepSignal => this.#sandbox.remove(runId, { fence, writersStopped: true, ...(stepSignal ? { signal: stepSignal } : {}) }));
        await step(stepSignal => this.#components.assertNoScopedResources(runId, stepSignal));
        await step(() => this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()));
        // Completion transitions the durable drain to `completed`, which
        // intentionally invalidates the short-lived operation lease. Renew
        // once before this final commit and never renew after it.
        await renew();
        if (leaseFailure || signal?.aborted || abortController.signal.aborted) throw new TeardownCoordinatorError("aggregate teardown lease was lost before completion");
        await this.#store.completeRunTeardown(runId, fence, this.#clock.now());
        return fence;
      } finally {
        clearInterval(heartbeat);
        await renewChain;
        signal?.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      const failure = error instanceof TeardownCoordinatorError ? error : new TeardownCoordinatorError(error instanceof Error ? error.message : String(error));
      if (ownsTeardownLease && drain && this.#store.blockRunTeardown) await this.#store.blockRunTeardown(runId, drain.owner, { code: "teardown", message: failure.message }, this.#clock.now()).catch(() => undefined);
      throw failure;
    } finally {
      if (teardownLease && this.#store.releaseRunTeardownLease) {
        const lease = teardownLease;
        const release = async (): Promise<void> => { await this.#store.releaseRunTeardownLease!(runId, lease.owner, lease.fencingToken).catch(() => undefined); };
        if (activeOperations.size === 0) await release();
        else void waitForActiveOperations().then(release, () => undefined).catch(() => undefined);
      }
    }
  }
}

function positiveBounded(value: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new TeardownCoordinatorError(`${label} is outside its bound`); return value; }
function assertGitDisposalAuthorization(value: unknown): asserts value is GitDisposalAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["bundleRetainUntil", "disposeBundle", "disposeWorkspace", "now", "workspaceRetainUntil"].includes(key))) throw new TeardownCoordinatorError("Git disposal authorization is not a closed object");
  const authorization = value as Record<string, unknown>;
  for (const key of ["workspaceRetainUntil", "bundleRetainUntil"]) if (authorization[key] !== undefined && (typeof authorization[key] !== "string" || authorization[key].length === 0 || authorization[key].length > 64 || /[\u0000-\u001f\u007f\r\n]/u.test(authorization[key]))) throw new TeardownCoordinatorError("Git disposal retention authorization is invalid");
  if (authorization["now"] !== undefined && typeof authorization["now"] !== "number" && typeof authorization["now"] !== "string") throw new TeardownCoordinatorError("Git disposal authorization clock value is invalid");
  for (const key of ["disposeWorkspace", "disposeBundle"]) if (authorization[key] !== undefined && typeof authorization[key] !== "boolean") throw new TeardownCoordinatorError("Git disposal authorization option is invalid");
}

export type SandboxTeardownPort = Pick<SandboxTeardownCoordinator, "teardown">;
