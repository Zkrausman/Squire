import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { NodeBackgroundLauncher } from "../../src/personal/background-launcher.js";
import { launchTestRoot } from "./windows-launch.js";

const DEADLINE_MS = 5_000;

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, label: string, milliseconds = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture deadline: ${label}`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only ownership ledger. An ack proves log closure, NOT sandbox quiescence. */
export class BackgroundFixture {
  private readonly token = randomUUID();
  private readonly server = createServer(socket => this.accept(socket));
  private readonly sockets = new Set<Socket>();
  private readonly readyEvent = latch<number>();
  private readonly closedEvent = latch<void>();
  private readonly directExit = latch<number | null>();
  private readonly parentExit = latch<number | null>();
  readonly stdoutPath: string;
  readonly stderrPath: string;
  private port = 0;
  pid: number | undefined;
  logsClosed = false;
  released = false;
  protocolError: string | undefined;
  private socket: Socket | undefined;
  private child: ChildProcess | undefined;
  private parent: ChildProcess | undefined;
  private launchSettled: Promise<void> | undefined;
  private launched = false;

  private constructor(readonly root: string) {
    this.stdoutPath = path.join(root, "stdout.log");
    this.stderrPath = path.join(root, "stderr.log");
  }

  static async create(): Promise<BackgroundFixture> {
    const fixture = new BackgroundFixture(await launchTestRoot("squire-detached-descriptors-"));
    try {
      await new Promise<void>((resolve, reject) => {
        fixture.server.once("error", reject);
        fixture.server.listen(0, "127.0.0.1", resolve);
      });
      const address = fixture.server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture control port");
      fixture.port = address.port;
      return fixture;
    } catch (error) {
      fixture.server.close();
      await rm(fixture.root, { recursive: true, force: true });
      throw error;
    }
  }

  launchDirect(mode: "normal" | "stall" = "normal"): Promise<{ pid: number | undefined }> {
    this.beginLaunch();
    const trackedSpawn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      this.child = child; // register before any test assertion or spawn event
      child.once("close", code => this.directExit.resolve(code));
      return child;
    }) as typeof spawn;
    const launch = new NodeBackgroundLauncher({ spawn: trackedSpawn }).launch({
      executable: process.execPath,
      args: [path.resolve("fixtures/background-child.mjs"), String(this.port), this.token, mode],
      stdoutPath: this.stdoutPath,
      stderrPath: this.stderrPath,
    });
    this.launchSettled = launch.then(() => undefined, () => undefined);
    return launch;
  }

  launchParent(): Promise<number | null> {
    this.beginLaunch();
    this.parent = spawn(process.execPath, [
      path.resolve("fixtures/background-launch-parent.mjs"), String(this.port), this.token,
      this.stdoutPath, this.stderrPath,
    ], { stdio: "ignore", windowsHide: true, shell: false });
    this.parent.once("close", code => this.parentExit.resolve(code));
    this.parent.once("error", () => { this.protocolError = "launcher parent spawn error"; });
    this.launchSettled = this.parentExit.promise.then(() => undefined);
    return bounded(this.parentExit.promise, "launcher parent exit");
  }

  private beginLaunch(): void {
    if (this.launched) throw new Error("fixture already launched");
    this.launched = true;
  }

  ready(): Promise<number> { return bounded(this.readyEvent.promise, "ready"); }
  waitClosed(): Promise<void> { return bounded(this.closedEvent.promise, "logs-closed"); }
  waitDirectExit(): Promise<number | null> {
    this.child?.ref();
    return bounded(this.directExit.promise, "direct child exit");
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.sendRelease();
  }
  private sendRelease(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify({ token: this.token, type: "release" })}\n`);
    }
  }
  disconnect(): void { this.socket?.destroy(); }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => { this.protocolError = "control socket error"; });
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.length > 4096) { socket.destroy(); return; }
      let end: number;
      while ((end = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        let message: { token?: unknown; type?: unknown; pid?: unknown };
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || message.token !== this.token || !Number.isSafeInteger(message.pid) || (message.pid as number) <= 0) {
          socket.destroy(); return;
        }
        if (message.type === "ready" && !this.socket) {
          this.socket = socket;
          this.pid = message.pid as number;
          this.readyEvent.resolve(this.pid);
          if (this.released) this.sendRelease();
        } else if (socket === this.socket && message.type === "logs-closed" && message.pid === this.pid && this.released && !this.logsClosed) {
          this.logsClosed = true;
          this.closedEvent.resolve();
        } else {
          this.protocolError = "unexpected control message";
          socket.destroy();
        }
      }
    });
  }

  async cleanup(milliseconds = DEADLINE_MS): Promise<void> {
    this.release(); // assertion failures use exactly the normal closure path
    try {
      if (this.launchSettled) await bounded(this.launchSettled, "launch settlement", milliseconds);
      if (this.launched) {
        // A launcher parent's exit cannot stand in for the detached child's ack.
        const closure = this.child
          ? Promise.race([this.closedEvent.promise, this.directExit.promise])
          : this.closedEvent.promise;
        await bounded(closure, "owned log closure", milliseconds);
      }
      if (this.child) await this.waitDirectExit(); // reap directly owned handles
      if (this.protocolError) throw new Error(this.protocolError);
      await rm(this.root, { recursive: true, force: true }); // deliberately no retries
    } catch (error) {
      // No unverified PID kill, no blind recursive deletion, no raw path metadata.
      throw new Error(`fixture root retained; child PID=${this.pid ?? "unknown"}; direct handle=${Boolean(this.child)}; log closure=${this.logsClosed}; detached lifetime unverified`, { cause: error });
    } finally {
      for (const socket of this.sockets) socket.destroy();
      if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
      // Disconnect normally terminates the fixture. If it does not, only our
      // actual ChildProcess handles may be killed/reaped, never a reported PID.
      // A late termination does not retroactively authorize the failed cleanup.
      for (const [handle, exit] of [[this.child, this.directExit], [this.parent, this.parentExit]] as const) {
        if (!handle) continue;
        handle.ref();
        try { await bounded(exit.promise, "owned process termination"); }
        catch {
          handle.kill();
          await bounded(exit.promise, "killed owned process termination");
        }
      }
    }
  }
}
