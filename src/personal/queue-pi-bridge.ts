import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBoundPersonalMvpConfig } from "./config.js";
import { captureOwnerPiIdentity, requireOwnerModels } from "./runtime-parity.js";
import { NodeCommandRunner } from "./command.js";
import { LinearClient } from "./linear-client.js";
import { queueDigest } from "./simple-queue.js";
import { launchAttestedQueue, validateQueueAttestation, type QueueAttestation } from "./queue-attestation.js";

/** Install this module as a trusted Pi extension only after reviewing the release. */
export default function registerSquireQueue(pi: { registerCommand(name: string, options: { description: string; handler(args: string, ctx: {
  cwd: string; hasUI: boolean; modelRegistry: { getAvailable(): readonly { provider: string; id: string }[] };
  ui: { confirm(title: string, message: string): Promise<boolean>; notify(message: string, level: "info" | "error"): void };
}): Promise<void> }): void }): void {
  pi.registerCommand("squire-queue", {
    description: "Approve exact Linear contracts, then launch a detached sequential ticket-to-PR queue",
    async handler(args, ctx) {
      if (!ctx.hasUI) throw Error("Queue requires interactive owner approval");
      const words = args.trim().split(/\s+/u), flag = words.lastIndexOf("--config");
      const tickets = words.slice(0, flag), configPath = words.at(-1);
      if (flag < 1 || flag !== words.length - 2 || !path.isAbsolute(configPath ?? "") || tickets.length < 1 || tickets.length > 3 || tickets.some(id => !/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(id)) || new Set(tickets).size !== tickets.length) throw Error("usage: /squire-queue TICKET [TICKET ...] --config ABSOLUTE_PATH (1–3 unique tickets)");
      const loaded = await loadBoundPersonalMvpConfig(configPath!);
      const identity = await captureOwnerPiIdentity(process.argv[1], ctx.modelRegistry, loaded.config.modelPolicy);
      requireOwnerModels(identity, loaded.config.modelPolicy);
      const result = await new NodeCommandRunner().run({ command: "git", args: ["-C", loaded.config.repository.path, "rev-parse", "--verify", "--end-of-options", `${loaded.config.repository.sourceRef}^{commit}`], maxOutputBytes: 4096 });
      const source = result.stdout.trim();
      const manifestSha256 = queueDigest(tickets, loaded.digest, source);
      const apiKey = process.env[loaded.config.linear.apiKeyEnv];
      if (!apiKey) throw Error("Linear credential unavailable");
      const linear = new LinearClient({ apiKey, ...(loaded.config.linear.endpoint ? { endpoint: loaded.config.linear.endpoint } : {}) });
      const approved: QueueAttestation["approved"][number][] = [];
      for (const ticketId of tickets) {
        const contract = await linear.get(ticketId);
        const digest = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
        if (!await ctx.ui.confirm(`Approve ${ticketId} (${approved.length + 1}/${tickets.length})`, `Ticket: ${contract.id}\nTitle: ${contract.title}\nURL: ${contract.url ?? "none"}\nDescription:\n${contract.description}\n\nSHA-256: ${digest}\n\nApprove this exact Linear contract for one ticket-to-PR run?`)) throw Error(`Owner did not approve ${ticketId}; queue not started`);
        approved.push({ ticketId, contractSha256: digest, contract });
      }
      if (!await ctx.ui.confirm("Launch Squire ticket queue", `Order: ${tickets.join(" → ")}\nSource commit: ${source}\nConfig SHA-256: ${loaded.digest}\nApproval SHA-256: ${manifestSha256}\n\nRun sequentially to published PRs only; stop on failure. No merges or retries. Launch detached?`)) throw Error("Owner did not authorize queue launch");
      const attestation = validateQueueAttestation({ schema: 1, queueId: randomUUID(), nonce: randomUUID(), ownerPid: identity.pid, manifestSha256, approved }, manifestSha256, identity, tickets);
      const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
      const code = await launchAttestedQueue(process.execPath, [cli, "queue", "start", ...tickets, "--config", configPath!], ctx.cwd, identity, attestation);
      if (code !== 0) throw Error(`Queue launch not confirmed (exit ${code}); inspect ${attestation.queueId}, do not retry unchanged`);
      ctx.ui.notify(`Squire queue ${attestation.queueId} launched; inspect status before any delivery decision.`, "info");
    },
  });
}
