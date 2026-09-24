import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openLog } from "./background-launcher.js";
import type { ReportEvidence } from "./report-evidence.js";

/** A private one-shot fd3 handoff, fd4 startup acknowledgement. No PID authority. */
export async function launchQueueWorker(input: { readonly executable: string; readonly cliPath: string; readonly queueId: string; readonly configPath: string; readonly root: string; readonly ref: ReportEvidence; readonly env?: NodeJS.ProcessEnv }): Promise<void> {
  if (![input.executable, input.cliPath, input.configPath, input.root].every(path.isAbsolute) || !/^[a-f0-9-]{36}$/u.test(input.queueId) || path.basename(input.root) !== input.queueId) throw Error("queue detached launch identity invalid");
  if (process.platform !== "win32") await mkdir(path.join(input.root, "logs"), { recursive: true, mode: 0o700 });
  const out = await openLog(path.join(input.root, "logs", "worker.stdout.log"));
  let err;
  try {
    err = await openLog(path.join(input.root, "logs", "worker.stderr.log"));
    const payload = JSON.stringify(input.ref);
    if (Buffer.byteLength(payload) > 2048) throw Error("queue private launch reference unbounded");
    const child = spawn(input.executable, [input.cliPath, "__queue_worker", input.queueId, "--config", input.configPath], {
      cwd: path.dirname(input.root), shell: false, detached: true, windowsHide: true,
      env: { ...(input.env ?? process.env), SQUIRE_QUEUE_WORKER_CHANNEL: "fd3-v1" }, stdio: ["ignore", out.fd, err.fd, "pipe", "pipe"],
    });
    // Once spawn is attempted, failure to acknowledge is ambiguous: do not
    // kill or launch a second worker; report the ID for read-only triage.
    try {
      const channel = child.stdio[3];
      const ack = child.stdio[4];
      if (!channel || !ack) throw Error("queue private worker channels unavailable");
      const ready = new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(Error("queue worker acknowledgement timed out")), 30_000);
        ack.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          if (text.length > 128 || text.includes("\n")) {
            clearTimeout(timer);
            text.length > 128 ? reject(Error("queue worker acknowledgement unbounded")) : resolve(text);
          }
        });
        ack.once("end", () => { clearTimeout(timer); if (!text.includes("\n")) reject(Error("queue worker exited before acknowledgement")); });
        ack.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { if (!text.includes("\n")) { clearTimeout(timer); reject(Error("queue worker exited before acknowledgement")); } });
      });
      (channel as Writable).end(payload);
      const message = await ready;
      if (message !== `READY ${input.queueId}\n`) throw Error("queue worker acknowledgement identity mismatch");
    } finally {
      child.stdio[3]?.destroy(); child.stdio[4]?.destroy(); child.unref();
    }
  } finally { await err?.close(); await out.close(); }
}
