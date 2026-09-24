import { createHash } from "node:crypto";
import { createReadStream, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCommandRunner } from "./command.js";
import { loadBoundPersonalMvpConfig, loadPersonalMvpConfig } from "./config.js";
import { captureLaunchMaterial, canonical } from "./launch-material.js";
import { receiveOwnerPiIdentity, requireOwnerModels, verifyDetachedPiRuntime } from "./runtime-parity.js";
import { receiveQueueAttestation } from "./queue-attestation.js";
import { queueDigest, validateSimpleSeal, writeSimpleSeal, readSimpleSeal, SimpleQueueStore, runSimpleQueue } from "./simple-queue.js";
import { validateEvidenceRef, type ReportEvidence } from "./report-evidence.js";
import { launchQueueWorker } from "./queue-background.js";
import { LinearClient } from "./linear-client.js";
import { createController, requestFromConfig } from "./cli-main.js";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const TICKET = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const SHA = /^[a-f0-9]{40}$/u;
export function parseSimpleQueueArgs(args: readonly string[]): { action: "start" | "status" | "cancel"; tickets: string[]; queueId?: string; config?: string; root?: string } | undefined {
  if (args[0] !== "queue") return undefined;
  const flag = args.length - 2;
  if (!path.isAbsolute(args.at(-1) ?? "")) return undefined;
  if (args[flag] === "--root" && args.length === 5 && args[1] === "status" && ID.test(args[2] ?? "") && path.basename(path.resolve(args[4]!)) === args[2]) return { action: "status", tickets: [], queueId: args[2]!, root: path.resolve(args[4]!) };
  if (args[flag] !== "--config") return undefined;
  const config = path.resolve(args.at(-1)!);
  if (args[1] === "start") {
    const tickets = args.slice(2, flag);
    if (tickets.length < 1 || tickets.length > 3 || tickets.some(id => !TICKET.test(id)) || new Set(tickets).size !== tickets.length) return undefined;
    return { action: "start", tickets, config };
  }
  if ((args[1] === "status" || args[1] === "cancel") && flag === 3 && ID.test(args[2] ?? "")) return { action: args[1], tickets: [], queueId: args[2]!, config };
  return undefined;
}
export async function simpleQueueCommand(args: readonly string[], cliPath = fileURLToPath(new URL("./cli.js", import.meta.url))): Promise<number> {
  const parsed = parseSimpleQueueArgs(args);
  if (!parsed) { process.stderr.write("usage: squire queue start TICKET [TICKET ...] --config ABS-PATH | queue status|cancel ID --config ABS-PATH | queue status ID --root ABS-QUEUE-ROOT\n"); return 2; }
  try {
    if (parsed.action !== "start") {
      const root = parsed.root ?? path.join((await loadPersonalMvpConfig(parsed.config!)).dataDirectory, "queues", parsed.queueId!);
      const store = new SimpleQueueStore(root);
      if (parsed.action === "cancel") { await store.cancel(); process.stdout.write(`Cancellation requested for ${parsed.queueId}; inspect status for the outcome.\n`); return 0; }
      process.stdout.write(`${JSON.stringify(await store.read())}\n`); return 0;
    }
    const loaded = await loadBoundPersonalMvpConfig(parsed.config!);
    const identity = await receiveOwnerPiIdentity();
    requireOwnerModels(identity, loaded.config.modelPolicy);
    const source = await resolvedSource(loaded.config.repository.path, loaded.config.repository.sourceRef);
    const approved = await receiveQueueAttestation(queueDigest(parsed.tickets, loaded.digest, source), identity, parsed.tickets);
    const root = path.join(loaded.config.dataDirectory, "queues", approved.queueId);
    const relative = path.relative(loaded.config.repository.path, root);
    if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw Error("queue state must be outside repository");
    // One private derived config pins the initial commit for every independent
    // ticket. No merge, checkout mutation or implicit source advancement.
    const raw = JSON.parse(Buffer.from(loaded.rawConfig, "base64").toString("utf8"));
    raw.repository.sourceRef = source;
    const derivedBytes = Buffer.from(JSON.stringify(raw));
    const material = await captureLaunchMaterial({
      ...loaded,
      rawConfig: derivedBytes.toString("base64"),
      digest: createHash("sha256").update(derivedBytes).digest("hex"),
      config: { ...loaded.config, repository: { ...loaded.config.repository, sourceRef: source } },
    }, identity);
    const seal = validateSimpleSeal({ version: 1, queueId: approved.queueId, configPath: parsed.config!, configSha256: loaded.digest, material, attestation: approved });
    const ref = await writeSimpleSeal(root, seal);
    await new SimpleQueueStore(root).write({ version: 1, queueId: approved.queueId, tickets: [...parsed.tickets], index: 0, status: "queued", runId: null, prs: [], error: null }, true);
    try { await launchQueueWorker({ executable: process.execPath, cliPath, queueId: approved.queueId, configPath: parsed.config!, root, ref }); }
    catch (error) { throw Error(`queue ${approved.queueId} launch unconfirmed, do not retry: ${error instanceof Error ? error.message : String(error)}`); }
    process.stdout.write(`${approved.queueId}\n`); return 0;
  } catch (error) { process.stderr.write(`Queue stopped: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
export async function simpleQueueWorker(args: readonly string[]): Promise<number> {
  const id = args[1], configPath = args[3];
  if (args.length !== 4 || !ID.test(id ?? "") || args[2] !== "--config" || !path.isAbsolute(configPath ?? "") || process.env["SQUIRE_QUEUE_WORKER_CHANNEL"] !== "fd3-v1") return 2;
  let claimedStore: SimpleQueueStore | undefined;
  try {
    const ref = await readPrivateRef();
    if (path.basename(path.dirname(ref.path)) !== "seal") throw Error("queue seal handoff path invalid");
    const root = path.dirname(path.dirname(ref.path));
    if (path.basename(root) !== id) throw Error("queue worker ID/handoff mismatch");
    const store = new SimpleQueueStore(root);
    await store.claim();
    claimedStore = store;
    const initial = await store.read();
    if (initial.version !== 1 || initial.status !== "queued" || initial.index !== 0 || initial.runId !== null || initial.prs.length !== 0 || initial.error !== null) throw Error("queue worker launch state invalid");
    const loaded = await loadBoundPersonalMvpConfig(configPath!);
    if (root !== path.join(loaded.config.dataDirectory, "queues", id!)) throw Error("queue runtime root changed");
    const seal = await readSimpleSeal(root, ref);
    if (seal.queueId !== id || seal.configPath !== path.resolve(configPath!) || seal.configSha256 !== loaded.digest) throw Error("queue config/seal changed");
    const pinned = seal.material.config;
    if (canonical({ ...pinned, repository: { ...pinned.repository, sourceRef: loaded.config.repository.sourceRef } }) !== canonical(loaded.config)) throw Error("queue config policy changed");
    const result = await runSimpleQueue({ store, seal, requireInitial: true, preclaimed: true, onReady() { try { writeSync(4, `READY ${id}\n`); closeSync(4); } catch { /* launcher exited; worker continues */ } },
      async run(ticketId, digest, signal, onReserved) {
        if ((await loadBoundPersonalMvpConfig(configPath!)).digest !== seal.configSha256) throw Error("queue config changed before next ticket");
        if (await resolvedSource(loaded.config.repository.path, loaded.config.repository.sourceRef) !== pinned.repository.sourceRef) throw Error("queue starting source changed");
        await verifyDetachedPiRuntime(seal.material.ownerPi!);
        const apiKey = process.env[loaded.config.linear.apiKeyEnv];
        if (!apiKey) throw Error("queue Linear credential unavailable");
        const linear = new LinearClient({ apiKey, ...(loaded.config.linear.endpoint ? { endpoint: loaded.config.linear.endpoint } : {}) });
        await checkContract(linear, ticketId, digest, signal);
        const controller = createController(pinned, seal.material, pinned.paths.state, digest);
        return controller.run(requestFromConfig(pinned, ticketId), signal, onReserved);
      },
    });
    return result.status === "completed" || result.status === "cancelled" ? 0 : 1;
  } catch (error) {
    if (claimedStore) {
      try { await blockClaimedQueue(claimedStore, error); }
      catch (failure) { process.stderr.write(`Queue ${id} launch failure could not be persisted: ${failure instanceof Error ? failure.message : String(failure)}\n`); }
    }
    process.stderr.write(`Queue ${id} blocked: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
/** Only after this worker has exclusively claimed owner.lock. Never rewrite a started run. */
export async function blockClaimedQueue(store: SimpleQueueStore, error: unknown): Promise<void> {
  const initial = await store.read();
  if (initial.version !== 1 || initial.status !== "queued" || initial.index !== 0 || initial.runId !== null || initial.prs.length !== 0 || initial.error !== null) return;
  await store.write({ ...initial, version: 2, status: "blocked", error: error instanceof Error ? error.message.slice(0, 500) : "queue launch failed" });
}
export async function checkContract(linear: Pick<LinearClient, "get">, id: string, digest: string, signal?: AbortSignal): Promise<void> {
  const contract = await linear.get(id, signal);
  if (createHash("sha256").update(JSON.stringify(contract)).digest("hex") !== digest) throw Error(`queue approved contract changed: ${id}`);
}
async function resolvedSource(repo: string, ref: string): Promise<string> {
  const result = await new NodeCommandRunner().run({ command: "git", args: ["-C", repo, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], maxOutputBytes: 4096 });
  const sha = result.stdout.trim(); if (!SHA.test(sha)) throw Error("queue source ref is not one commit"); return sha;
}
async function readPrivateRef(): Promise<ReportEvidence> {
  const stream = createReadStream("", { fd: 3, autoClose: false });
  const timer = setTimeout(() => stream.destroy(Error("queue private handoff timed out")), 5000);
  const chunks: Buffer[] = []; let size = 0;
  try { for await (const chunk of stream) { size += chunk.length; if (size > 2048) throw Error("queue private handoff unbounded"); chunks.push(chunk); } }
  finally { clearTimeout(timer); stream.destroy(); }
  const ref = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as ReportEvidence;
  validateEvidenceRef(ref);
  return ref;
}
