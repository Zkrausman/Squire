import { watch as fsWatch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { findRunState, StatusLookupError, validateStatusSelector } from "./status.js";
import {
  sortRunEvents,
  synthesizeCurrentRunEvents,
  type RunEvent,
} from "./run-events.js";
import type { PersonalRunState, RunStatePort } from "./types.js";

export interface RunEventConsumerOptions {
  readonly states: RunStatePort & { readonly directory?: string; readonly eventDirectory?: string };
  readonly selector: string;
  readonly onEvent?: (event: RunEvent) => void | Promise<void>;
  /** Duplicate OS notifications are coalesced for this interval. */
  readonly debounceMs?: number;
  /** Bounded non-LLM reconciliation fallback; it is not a busy polling loop. */
  readonly reconcileIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Windows must never install libuv directory watch handles. */
  readonly platform?: NodeJS.Platform;
  readonly watch?: typeof fsWatch;
}

export interface RunEventWatchResult {
  readonly state: PersonalRunState;
  readonly eventsDelivered: number;
}

const DEFAULT_DEBOUNCE_MS = 40;
const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;
const MAX_DEBOUNCE_MS = 5_000;
const MAX_RECONCILE_INTERVAL_MS = 60_000;

/**
 * Bounded, non-LLM run event consumer. Windows uses timer reconciliation only:
 * hosted Node 24 libuv directory handles can abort during atomic replacement.
 * Other platforms watch directories with the same timer as fallback. Neither
 * mechanism invokes a ticket, Docker, Git, Pi, or publication adapter.
 */
export class RunEventConsumer {
  readonly #states: RunEventConsumerOptions["states"];
  readonly #selector: string;
  readonly #onEvent: (event: RunEvent) => void | Promise<void>;
  readonly #debounceMs: number;
  readonly #reconcileIntervalMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #watch: typeof fsWatch;
  readonly #seen = new Set<string>();
  readonly #watchers: FSWatcher[] = [];
  readonly #waiters = new Set<() => void>();
  #wakeTimer: NodeJS.Timeout | undefined;
  #wakePending = false;
  #stopped = false;
  #eventsDelivered = 0;

  constructor(options: RunEventConsumerOptions) {
    validateStatusSelector(options.selector);
    this.#states = options.states;
    this.#selector = options.selector;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#debounceMs = bounded(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, 0, MAX_DEBOUNCE_MS, "debounce interval");
    this.#reconcileIntervalMs = bounded(options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS, 1, MAX_RECONCILE_INTERVAL_MS, "reconciliation interval");
    this.#signal = options.signal;
    this.#platform = options.platform ?? process.platform;
    this.#watch = options.watch ?? fsWatch;
  }

  get eventsDelivered(): number { return this.#eventsDelivered; }

  stop(): void {
    this.#stopped = true;
    this.#closeWatchers();
    this.#resolveWaiters();
  }

  async watch(): Promise<RunEventWatchResult> {
    this.#throwIfStoppedOrAborted();
    // Resolve before installing watchers, then once afterwards. The second
    // reconciliation closes the race where a writer replaces a file between
    // the first read and watcher registration.
    try {
      let state = await this.#reconcile();
      if (isTerminal(state)) return { state, eventsDelivered: this.#eventsDelivered };
      await this.#installWatchers();
      state = await this.#reconcile();
      if (isTerminal(state)) {
        return { state, eventsDelivered: this.#eventsDelivered };
      }

      while (!this.#stopped) {
        this.#throwIfStoppedOrAborted();
        await this.#waitForWakeOrTimeout();
        if (this.#stopped) break;
        state = await this.#reconcile();
        if (isTerminal(state)) break;
      }
      this.#throwIfStoppedOrAborted();
      return { state, eventsDelivered: this.#eventsDelivered };
    } finally {
      this.stop();
    }
  }

  async #reconcile(): Promise<PersonalRunState> {
    this.#throwIfStoppedOrAborted();
    const state = await resolveWatchedState(this.#states, this.#selector);
    const persisted = this.#states.readEvents ? await this.#states.readEvents(state.runId) : [];
    const ordered = sortRunEvents(persisted.filter(event => event.runId === state.runId && event.ticketId === state.ticketId && event.stateRevision <= state.version));
    for (const event of ordered) await this.#deliverOnce(event);

    // A state replacement is authoritative even when its outbox publication
    // was lost. Synthesis uses semantic event IDs, so a later outbox replay is
    // deduplicated without trusting a local cursor or a timestamp.
    for (const event of synthesizeCurrentRunEvents(state)) await this.#deliverOnce(event);
    return state;
  }

  async #deliverOnce(event: RunEvent): Promise<void> {
    if (this.#seen.has(event.eventId)) return;
    this.#seen.add(event.eventId);
    this.#eventsDelivered += 1;
    try {
      await this.#onEvent(event);
    } catch (error) {
      // Do not mark a failed callback as delivered. A caller such as the
      // notification worker can retry after the consumer is restarted.
      this.#seen.delete(event.eventId);
      this.#eventsDelivered -= 1;
      throw error;
    }
  }

  async #installWatchers(): Promise<void> {
    const stateDirectory = directoryOf(this.#states);
    const eventDirectory = eventDirectoryOf(this.#states, stateDirectory);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(eventDirectory, { recursive: true, mode: 0o700 });
    this.#throwIfStoppedOrAborted();
    if (this.#platform === "win32") return;
    this.#watchDirectory(stateDirectory);
    if (eventDirectory !== stateDirectory) this.#watchDirectory(eventDirectory);
  }

  #watchDirectory(directory: string): void {
    let watcher: FSWatcher;
    try {
      // Directory watches survive rename-based atomic replacement on POSIX.
      watcher = this.#watch(directory, { persistent: true }, () => this.#scheduleWake());
    } catch {
      // The bounded reconciliation timer remains the recovery path when an OS
      // watcher cannot be installed. This is still non-LLM and non-busy.
      return;
    }
    watcher.on("error", () => {
      const index = this.#watchers.indexOf(watcher);
      if (index === -1) return;
      this.#watchers.splice(index, 1);
      watcher.close();
      this.#scheduleWake();
    });
    this.#watchers.push(watcher);
  }

  #scheduleWake(): void {
    if (this.#stopped) return;
    this.#wakePending = true;
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined;
      this.#wakePending = false;
      this.#resolveWaiters();
    }, this.#debounceMs);
  }

  #waitForWakeOrTimeout(): Promise<void> {
    if (this.#wakePending) {
      this.#wakePending = false;
      if (this.#wakeTimer) {
        clearTimeout(this.#wakeTimer);
        this.#wakeTimer = undefined;
      }
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(), this.#reconcileIntervalMs);
      const abort = (): void => finish(this.#abortError(), true);
      const finish = (error?: Error, rejected = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#waiters.delete(onWake);
        this.#signal?.removeEventListener("abort", abort);
        if (rejected && error) reject(error);
        else resolve();
      };
      const onWake = (): void => finish();
      this.#waiters.add(onWake);
      if (this.#signal?.aborted) abort();
      else this.#signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #resolveWaiters(): void {
    const waiters = [...this.#waiters];
    for (const waiter of waiters) waiter();
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers.splice(0)) watcher.close();
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = undefined;
    this.#resolveWaiters();
  }

  #throwIfStoppedOrAborted(): void {
    if (this.#stopped) throw new Error("run event consumer stopped");
    if (this.#signal?.aborted) throw this.#abortError();
  }

  #abortError(): Error {
    return this.#signal?.reason instanceof Error ? this.#signal.reason : new Error("run event consumer interrupted");
  }
}

export async function watchRun(options: RunEventConsumerOptions): Promise<RunEventWatchResult> {
  return new RunEventConsumer(options).watch();
}

export const consumeRunEvents = watchRun;
export const RunEventWatcher = RunEventConsumer;

function directoryOf(states: RunEventConsumerOptions["states"]): string {
  const directory = states.directory;
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) throw new Error("run event consumer requires a state directory");
  return path.resolve(directory);
}

function eventDirectoryOf(states: RunEventConsumerOptions["states"], stateDirectory: string): string {
  const value = states.eventDirectory;
  if (value === undefined) return path.join(stateDirectory, "events");
  if (!value || value.includes("\0")) throw new Error("run event consumer event directory is invalid");
  return path.resolve(value);
}

async function resolveWatchedState(states: RunEventConsumerOptions["states"], selector: string): Promise<PersonalRunState> {
  try {
    return await findRunState(states, selector);
  } catch (error) {
    // A normal controller persists terminal state before releasing its ticket
    // reservation. There is a small window where the state is authoritative
    // but status's conservative reservation ambiguity check still sees the
    // terminal owner. A watcher may consume that terminal record directly;
    // it must not use this exception for a running or mismatched owner.
    if (!(error instanceof StatusLookupError) || error.code !== "ambiguous" || (!states.observeReservation && !states.reservationOwner) || !states.read) throw error;
    let ticketId = selector;
    if (/^[a-z]/u.test(selector)) {
      const exact = await states.read(selector);
      if (!exact) throw error;
      ticketId = exact.ticketId;
    }
    const observation = await states.observeReservation?.(ticketId);
    const owner = observation
      ? observation.kind === "owner" ? observation.runId : undefined
      : await states.reservationOwner!(ticketId).catch(() => undefined);
    if (!owner) throw error;
    const candidate = await states.read(owner);
    if (!candidate || !isTerminal(candidate)) throw error;
    if (selector !== candidate.runId && selector !== candidate.ticketId) throw error;
    if (observation) {
      const after = await states.observeReservation!(ticketId);
      const candidates = await states.findByTicket?.(ticketId);
      if (after.kind !== "owner" || observation.kind !== "owner" || after.snapshot !== observation.snapshot ||
          candidates?.some(state => state.status === "running")) throw error;
      const repeated = await states.read(owner);
      if (repeated?.version !== candidate.version) throw error;
    }
    return candidate;
  }
}

function isTerminal(state: PersonalRunState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "interrupted";
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}
