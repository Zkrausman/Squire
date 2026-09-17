import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { NodeBackgroundLauncher } from "../../src/personal/background-launcher.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Every asynchronous rejection is observed even before its consumer awaits it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Bounded one-message-at-a-time protocol, not a stream of completion markers.
class Lines {
  private buffer = "";
  private queued: string[] = [];
  private pending: ReturnType<typeof deferred<string>> | undefined;
  private error: Error | undefined;
  private protocolError: Error | undefined;
  constructor(stream: Readable) {
    stream.setEncoding("utf8");
    stream.on("data", (data: string) => {
      if (this.error) return;
      this.buffer += data;
      if (this.buffer.length > 512) { this.fail(new Error("oversized fixture message")); return; }
      while (this.buffer.includes("\n")) {
        const index = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (this.pending) { this.pending.resolve(line); this.pending = undefined; }
        else if (this.queued.length === 0) this.queued.push(line);
        else { this.fail(new Error("unsolicited fixture messages")); return; }
      }
    });
    stream.on("error", error => this.fail(error));
    stream.on("close", () => this.fail(new Error("fixture channel closed"), false));
    stream.on("end", () => this.fail(new Error("fixture channel ended"), false));
  }
  assertIdle(requireOpen = true): void {
    if (this.protocolError) throw this.protocolError;
    if (requireOpen && this.error) throw this.error;
    assert.equal(this.queued.length, 0, "unsolicited fixture message");
    assert.equal(this.buffer, "", "unsolicited partial fixture message");
  }
  private fail(error: Error, protocolError = true): void {
    if (protocolError) this.protocolError = error;
    this.error = error;
    this.pending?.reject(error);
    this.pending = undefined;
  }
  next(): Promise<string> {
    const line = this.queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.error) return Promise.reject(this.error);
    assert.equal(this.pending, undefined);
    this.pending = deferred<string>();
    return this.pending.promise;
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
function own(child: ChildProcess) {
  const closed = deferred<Exit>();
  let error: Error | undefined;
  child.on("error", value => { error = value; });
  child.once("close", (code, signal) => closed.resolve({ code, signal, ...(error ? { error } : {}) }));
  child.stdin?.on("error", () => {}); // EPIPE during cooperative cancellation is expected.
  return { child, closed: closed.promise };
}
type Owned = ReturnType<typeof own>;
function successful(exit: Exit): void {
  assert.equal(exit.error, undefined);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
}

/** Owns coordination and actual exit evidence, never PID/socket liveness polling. */
export class DetachedProcessFixture {
  readonly token = randomBytes(32).toString("hex");
  readonly stdoutPath: string;
  readonly stderrPath: string;
  private readonly connected = deferred<{ socket: Socket; lines: Lines }>();
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer(socket => {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const lines = new Lines(socket);
    if (this.accepted || this.stopping) { socket.destroy(); return; }
    this.accepted = true;
    this.connected.resolve({ socket, lines });
  });
  private accepted = false;
  private stopping = false;
  private port = 0;
  private channel: { socket: Socket; lines: Lines } | undefined;
  private direct: Owned | undefined;
  private parent: Owned | undefined;
  private observer: Owned | undefined;
  private identityBound = false;
  private exitProven = false;
  private pid = 0;

  constructor(readonly root: string) {
    this.stdoutPath = path.join(root, "stdout.log");
    this.stderrPath = path.join(root, "stderr.log");
    this.server.on("error", error => this.connected.reject(error));
  }
  async listen(): Promise<void> {
    await bounded(new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(); });
    }), "coordination listen");
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.port = address.port;
  }
  async launchDirect(): Promise<number | undefined> {
    const capturingSpawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      this.direct = own(child); // Attach close/error before returning to the launcher.
      return child;
    }) as typeof spawn;
    const launched = await bounded(new NodeBackgroundLauncher({ spawn: capturingSpawn }).launch({
      executable: process.execPath,
      args: [path.resolve("fixtures/background-child.mjs"), String(this.port), this.token],
      stdoutPath: this.stdoutPath, stderrPath: this.stderrPath,
    }), "direct launch");
    // Production unrefs; the test retains ownership until actual close.
    this.direct?.child.ref();
    return launched.pid;
  }
  launchParent(): void {
    this.parent = own(spawn(process.execPath, [
      path.resolve("fixtures/background-launch-parent.mjs"), String(this.port), this.token,
      this.stdoutPath, this.stderrPath,
    ], { stdio: "ignore", windowsHide: true }));
  }
  async ready(): Promise<number> {
    this.channel = await bounded(this.connected.promise, "child connection");
    const line = await bounded(this.channel.lines.next(), "authenticated readiness");
    const match = new RegExp(`^ready ${this.token} ([1-9][0-9]{0,9})$`).exec(line);
    assert.ok(match, "invalid child readiness");
    this.channel.lines.assertIdle();
    this.pid = Number(match[1]);
    assert.ok(this.pid <= 2147483647);
    return this.pid;
  }
  async challenge(): Promise<void> {
    assert.ok(this.channel);
    const nonce = randomBytes(32).toString("hex");
    this.channel.socket.write(`challenge ${nonce}\n`);
    assert.equal(await bounded(this.channel.lines.next(), "held child challenge"), `answer ${nonce}`);
    this.channel.lines.assertIdle();
  }
  async parentClosed(): Promise<void> {
    assert.ok(this.parent);
    successful(await bounded(this.parent.closed, "launcher close"));
    // A fresh response after parent close preserves the outliving assertion.
    await this.challenge();
  }
  async acquireObserver(): Promise<void> {
    assert.ok(this.pid);
    this.observer = own(spawn(path.resolve("build/Release", `process_exit_observer${process.platform === "win32" ? ".exe" : ""}`), [String(this.pid)], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }));
    const lines = new Lines(this.observer.child.stdout!);
    let diagnostic = "";
    this.observer.child.stderr!.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(0, 1024); });
    try {
      assert.equal(await bounded(lines.next(), "native observer acquisition"), "acquired");
      lines.assertIdle();
      // The same authenticated child is alive after handle acquisition. Its PID
      // cannot have been reused during acquisition; the handle stays owned.
      await this.challenge();
      this.identityBound = true;
    } catch (error) {
      throw new Error(`observer acquisition/identity failed: ${diagnostic}`, { cause: error });
    }
  }
  async assertLogs(): Promise<void> {
    assert.match(await readFile(this.stdoutPath, "utf8"), /detached stdout inherited/);
    assert.match(await readFile(this.stderrPath, "utf8"), /detached stderr inherited/);
  }
  async releaseAndWait(): Promise<void> {
    assert.ok(this.channel);
    assert.ok(this.direct || this.identityBound);
    this.channel.lines.assertIdle();
    assert.equal(this.channel.socket.destroyed, false, "child lost before release");
    this.channel.socket.write("release\n");
    if (this.direct) {
      const exit = await bounded(this.direct.closed, "direct child close");
      this.exitProven = true; // Even a failed child has actually closed.
      successful(exit);
    } else {
      assert.ok(this.observer);
      successful(await bounded(this.observer.closed, "native intended-child exit"));
      this.exitProven = true;
    }
    this.channel.lines.assertIdle(false);
  }
  async dispose(): Promise<void> {
    this.stopping = true;
    const errors: unknown[] = [];
    const reap = async (action: () => Promise<void>) => { try { await action(); } catch (error) { errors.push(error); } };
    // Destroying coordination requests graceful child shutdown, but is NOT proof.
    for (const socket of this.sockets) socket.destroy();
    await reap(async () => {
      await bounded(new Promise<void>(resolve => this.server.close(() => resolve())), "server close");
    });
    if (this.direct) await reap(async () => {
      await bounded(this.direct!.closed, "teardown child close", 22000);
      this.exitProven = true;
    });
    if (this.parent) await reap(async () => { await bounded(this.parent!.closed, "teardown launcher close", 22000); });
    if (this.observer) {
      if (!this.identityBound) this.observer.child.stdin?.end();
      await reap(async () => {
        const exit = await bounded(this.observer!.closed, "teardown observer close", 22000);
        if (this.identityBound) { successful(exit); this.exitProven = true; }
      });
      this.observer.child.stdin?.destroy();
      this.observer.child.stdout?.destroy();
      this.observer.child.stderr?.destroy();
    }
    if (!this.exitProven) errors.push(new Error(`intended-child exit unproven; fixture retained: ${this.root}`));
    else {
      // One attempt per log, then one root removal. Never retry a failed unlink
      // indirectly through recursive rm; preserve the root on cleanup failure.
      await reap(async () => {
        const results = await Promise.allSettled([unlink(this.stdoutPath), unlink(this.stderrPath)]);
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length) throw new Error(`single-attempt log cleanup failed; fixture retained: ${this.root}`, { cause: failures });
        await rm(this.root, { recursive: true });
      });
    }
    if (errors.length) throw new AggregateError(errors, `detached fixture teardown: ${this.root}`);
  }
}
