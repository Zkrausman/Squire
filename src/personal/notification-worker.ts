import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type RunEvent, type RunEventType } from "./run-events.js";
import { RunEventConsumer, type RunEventConsumerOptions, type RunEventWatchResult } from "./run-watcher.js";
import { validateStatusSelector } from "./status.js";
import type { RunStatePort } from "./types.js";

export const HOST_NOTIFICATION_EVENT_TYPES = ["terminal_succeeded", "terminal_failed"] as const;
export type HostNotificationEventType = (typeof HOST_NOTIFICATION_EVENT_TYPES)[number];

export interface HostNotificationAdapter {
  notify(event: RunEvent, signal?: AbortSignal): Promise<void>;
}

export interface NotificationCheckpoint {
  readonly schemaVersion: 1;
  readonly consumerId: string;
  readonly runId: string;
  readonly deliveredEventIds: readonly string[];
  readonly lastStateRevision: number;
  readonly updatedAt: string;
}

export interface RunNotificationWorkerOptions {
  readonly states: RunStatePort & { readonly directory?: string; readonly eventDirectory?: string };
  readonly selector: string;
  readonly consumerId: string;
  readonly adapter: HostNotificationAdapter;
  readonly checkpointDirectory: string;
  readonly deliveryTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly consumer?: Omit<RunEventConsumerOptions, "states" | "selector" | "onEvent" | "signal">;
  readonly signal?: AbortSignal;
}

const MAX_CHECKPOINT_EVENT_IDS = 2_048;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * A provider-neutral host notification adapter. It never constructs prompts or
 * starts a model; delivery is attempted only for the fixed attention/terminal
 * allowlist and the checkpoint advances only after successful delivery.
 */
export class RunNotificationWorker {
  readonly #options: RunNotificationWorkerOptions;
  readonly #deliveryTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #checkpointPath: string;

  constructor(options: RunNotificationWorkerOptions) {
    validateStatusSelector(options.selector);
    this.#options = options;
    this.#deliveryTimeoutMs = bounded(options.deliveryTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 60_000, "notification timeout");
    this.#maxAttempts = bounded(options.maxAttempts ?? DEFAULT_ATTEMPTS, 1, 5, "notification attempts");
    this.#retryDelayMs = bounded(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, 0, 10_000, "notification retry delay");
    this.#checkpointPath = checkpointFilePath(options.checkpointDirectory, options.consumerId, options.selector);
  }

  get checkpointPath(): string { return this.#checkpointPath; }

  async run(): Promise<RunEventWatchResult> {
    const checkpoint = await readCheckpoint(this.#checkpointPath, this.#options.consumerId, this.#options.selector);
    const delivered = new Set(checkpoint?.deliveredEventIds ?? []);
    const callback = async (event: RunEvent): Promise<void> => {
      if (!isHostNotificationEvent(event.type)) return;
      if (delivered.has(event.eventId)) return;
      await deliverWithRetry(this.#options.adapter, event, this.#deliveryTimeoutMs, this.#maxAttempts, this.#retryDelayMs, this.#options.signal);
      delivered.add(event.eventId);
      while (delivered.size > MAX_CHECKPOINT_EVENT_IDS) {
        const first = delivered.values().next().value as string | undefined;
        if (first === undefined) break;
        delivered.delete(first);
      }
      await writeCheckpoint(this.#checkpointPath, {
        schemaVersion: 1,
        consumerId: this.#options.consumerId,
        runId: event.runId,
        deliveredEventIds: [...delivered],
        lastStateRevision: event.stateRevision,
        updatedAt: event.timestamp,
      });
    };
    const consumer = new RunEventConsumer({
      states: this.#options.states,
      selector: this.#options.selector,
      ...(this.#options.consumer ?? {}),
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      onEvent: callback,
    });
    return consumer.watch();
  }
}

export async function runNotificationWorker(options: RunNotificationWorkerOptions): Promise<RunEventWatchResult> {
  return new RunNotificationWorker(options).run();
}

export const HostNotificationWorker = RunNotificationWorker;

export function isHostNotificationEvent(type: RunEventType): type is HostNotificationEventType {
  return (HOST_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type);
}

export function checkpointFilePath(directory: string, consumerId: string, selector: string): string {
  validateStatusSelector(selector);
  if (!directory || directory.includes("\0") || !path.isAbsolute(directory)) throw new Error("checkpoint directory must be absolute");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(consumerId)) throw new Error("consumer ID is invalid");
  const identity = createHash("sha256").update(`${consumerId}|${selector}`, "utf8").digest("hex");
  return path.join(path.resolve(directory), `${identity}.json`);
}

async function readCheckpoint(file: string, consumerId: string, selector: string): Promise<NotificationCheckpoint | undefined> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > MAX_CHECKPOINT_BYTES) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    validateCheckpoint(value, consumerId, selector);
    return value;
  } catch {
    // A malformed checkpoint cannot authorize skipping delivery. Replaying the
    // fixed allowlist is the safe at-least-once recovery behavior.
    return undefined;
  }
}

async function writeCheckpoint(file: string, checkpoint: NotificationCheckpoint): Promise<void> {
  validateCheckpoint(checkpoint, checkpoint.consumerId, "");
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateCheckpoint(value: unknown, consumerId: string, _selector: string): asserts value is NotificationCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("notification checkpoint must be an object");
  const object = value as Record<string, unknown>;
  const keys = ["schemaVersion", "consumerId", "runId", "deliveredEventIds", "lastStateRevision", "updatedAt"];
  if (Object.keys(object).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error("notification checkpoint fields are invalid");
  if (object["schemaVersion"] !== 1 || object["consumerId"] !== consumerId || typeof object["runId"] !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(object["runId"])) throw new Error("notification checkpoint identity is invalid");
  if (!Array.isArray(object["deliveredEventIds"]) || object["deliveredEventIds"].length > MAX_CHECKPOINT_EVENT_IDS || object["deliveredEventIds"].some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id))) throw new Error("notification checkpoint event IDs are invalid");
  if (!Number.isSafeInteger(object["lastStateRevision"]) || (object["lastStateRevision"] as number) < 1) throw new Error("notification checkpoint revision is invalid");
  if (typeof object["updatedAt"] !== "string" || !validTimestamp(object["updatedAt"])) throw new Error("notification checkpoint timestamp is invalid");
}

async function deliverWithRetry(adapter: HostNotificationAdapter, event: RunEvent, timeoutMs: number, maxAttempts: number, retryDelayMs: number, parentSignal: AbortSignal | undefined): Promise<void> {
  let lastError: unknown = new Error("notification delivery failed");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (parentSignal?.aborted) throw abortError(parentSignal);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("notification delivery timed out")), timeoutMs);
    try {
      await Promise.race([
        adapter.notify(event, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("notification delivery timed out")), { once: true })),
      ]);
      return;
    } catch (error) {
      lastError = error;
      if (parentSignal?.aborted) throw abortError(parentSignal);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    }
    if (attempt < maxAttempts && retryDelayMs > 0) await delay(retryDelayMs, parentSignal);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(), milliseconds);
    const abort = (): void => finish(abortError(signal!), true);
    const finish = (error?: Error, rejected = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejected && error) reject(error);
      else resolve();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("notification delivery interrupted");
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR" && code !== "ENOTSUP") throw error;
  }
}

function validTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}
