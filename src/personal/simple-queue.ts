import { createHash, randomUUID } from "node:crypto";
import { constants, watch as fsWatch } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createReportEvidence, type ReportEvidence, verifyReportEvidence } from "./report-evidence.js";
import { validateLaunchMaterial, type LaunchMaterial } from "./launch-material.js";
import { validateQueueAttestation, type QueueAttestation } from "./queue-attestation.js";
import { windowsLaunch } from "./windows-launch.js";
import { renameOverExistingWithRetry } from "./atomic-rename.js";
import type { PersonalRunState } from "./types.js";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const TICKET = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
export interface SimpleQueueSeal { readonly version: 1; readonly queueId: string; readonly configPath: string; readonly configSha256: string; readonly material: LaunchMaterial; readonly attestation: QueueAttestation }
export interface SimpleQueueState { readonly version: number; readonly queueId: string; readonly tickets: readonly string[]; readonly index: number; readonly status: "queued" | "running" | "completed" | "cancelled" | "blocked"; readonly runId: string | null; readonly prs: readonly string[]; readonly error: string | null }
export function queueDigest(tickets: readonly string[], configSha256: string, sourceSha: string): string {
  if (tickets.length < 1 || tickets.length > 3 || tickets.some(id => !TICKET.test(id)) || new Set(tickets).size !== tickets.length || !SHA.test(configSha256) || !/^[a-f0-9]{40}$/u.test(sourceSha)) throw Error("queue requires 1–3 unique approved ticket IDs and exact config/source");
  return createHash("sha256").update(JSON.stringify({ tickets, configSha256, sourceSha })).digest("hex");
}
export function validateSimpleSeal(value: unknown): SimpleQueueSeal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("queue seal missing");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "attestation,configPath,configSha256,material,queueId,version" || v["version"] !== 1 || !ID.test(String(v["queueId"])) || !path.isAbsolute(String(v["configPath"])) || !SHA.test(String(v["configSha256"]))) throw Error("queue seal identity invalid");
  const material = validateLaunchMaterial(v["material"]);
  if (!material.ownerPi || !/^[a-f0-9]{40}$/u.test(material.config.repository.sourceRef)) throw Error("queue requires pinned source and Pi capture");
  const attestation = validateQueueAttestation(v["attestation"], queueDigest((v["attestation"] as QueueAttestation).approved.map(entry => entry.ticketId), v["configSha256"] as string, material.config.repository.sourceRef), material.ownerPi, (v["attestation"] as QueueAttestation).approved.map(entry => entry.ticketId));
  if (attestation.queueId !== v["queueId"]) throw Error("queue owner approval ID mismatch");
  return { version: 1, queueId: v["queueId"] as string, configPath: v["configPath"] as string, configSha256: v["configSha256"] as string, material, attestation };
}
export async function writeSimpleSeal(root: string, seal: SimpleQueueSeal): Promise<ReportEvidence> {
  // Linux's fd-relative evidence backend requires its immediate parent to
  // exist before it opens the protected seal directory. The backend verifies
  // the resulting owner, mode and ancestor chain before writing any bytes.
  if (process.platform !== "win32") await mkdir(root, { recursive: true, mode: 0o700 });
  const port = createReportEvidence(path.join(root, "seal"));
  try { return await port.write(JSON.stringify(validateSimpleSeal(seal))); }
  finally { await port.release?.(); }
}
export async function readSimpleSeal(root: string, ref: ReportEvidence): Promise<SimpleQueueSeal> {
  if (path.dirname(ref.path) !== path.join(root, "seal")) throw Error("queue seal reference outside owner directory");
  const port = createReportEvidence(path.join(root, "seal"));
  try { return validateSimpleSeal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await verifyReportEvidence(port, ref)))); }
  finally { await port.release?.(); }
}
function checkState(value: unknown, id: string): SimpleQueueState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("queue state unavailable");
  const s = value as Record<string, unknown>;
  if (Object.keys(s).sort().join() !== "error,index,prs,queueId,runId,status,tickets,version" || s["queueId"] !== id || !Number.isSafeInteger(s["version"]) || (s["version"] as number) < 1
    || !Array.isArray(s["tickets"]) || s["tickets"].length < 1 || s["tickets"].length > 3 || s["tickets"].some(t => !TICKET.test(String(t)))
    || !Number.isSafeInteger(s["index"]) || (s["index"] as number) < 0 || (s["index"] as number) > s["tickets"].length
    || !["queued", "running", "completed", "cancelled", "blocked"].includes(String(s["status"])) || !Array.isArray(s["prs"]) || s["prs"].length > 3
    || (s["runId"] !== null && (typeof s["runId"] !== "string" || s["runId"].length > 128)) || (s["error"] !== null && (typeof s["error"] !== "string" || s["error"].length > 500))) throw Error("queue state invalid");
  return s as unknown as SimpleQueueState;
}
async function protectedWrite(file: string, bytes: Buffer): Promise<void> {
  if (process.platform === "win32") { const native = windowsLaunch(), held = native.openReport(file, bytes); native.closeReport(held.lease); return; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const h = await open(file, "wx", 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
}
async function protectedRead(file: string): Promise<Buffer> {
  if (process.platform === "win32") { const native = windowsLaunch(), held = native.openReport(file); try { return native.readReport(held.lease); } finally { native.closeReport(held.lease); } }
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await h.stat(); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid!() || (s.mode & 0o077) || s.size > 32_000) throw Error("queue state file unsafe"); return await h.readFile(); }
  finally { await h.close(); }
}
export class SimpleQueueStore {
  constructor(readonly root: string) { if (!path.isAbsolute(root) || !ID.test(path.basename(root))) throw Error("queue root requires UUID"); }
  async claim(): Promise<void> { await protectedWrite(path.join(this.root, "owner.lock"), Buffer.from(JSON.stringify({ pid: process.pid, queueId: path.basename(this.root) }))); }
  async read(): Promise<SimpleQueueState> { return checkState(JSON.parse((await protectedRead(path.join(this.root, "state.json"))).toString("utf8")), path.basename(this.root)); }
  async write(state: SimpleQueueState, first = false): Promise<void> {
    checkState(state, path.basename(this.root));
    if (!first) { const old = await this.read(); if (old.version + 1 !== state.version || old.queueId !== state.queueId || JSON.stringify(old.tickets) !== JSON.stringify(state.tickets) || ["completed", "blocked", "cancelled"].includes(old.status)) throw Error("queue state transition invalid"); }
    else if (state.version !== 1 || state.status !== "queued" || state.index !== 0) throw Error("queue initial state invalid");
    const file = path.join(this.root, "state.json"), bytes = Buffer.from(JSON.stringify(state));
    if (first) { await protectedWrite(file, bytes); return; }
    const temp = path.join(this.root, `${randomUUID()}.tmp`);
    await protectedWrite(temp, bytes);
    await renameOverExistingWithRetry(temp, file, process.platform === "win32" ? { rename: async (a, b) => { windowsLaunch().replaceState(a, b); } } : {});
  }
  async cancelled(): Promise<boolean> {
    try {
      const value: unknown = JSON.parse((await protectedRead(path.join(this.root, "cancel.json"))).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "nonce,queueId" || (value as { queueId?: unknown }).queueId !== path.basename(this.root) || !ID.test(String((value as { nonce?: unknown }).nonce))) throw Error("queue cancellation marker identity invalid");
      return true;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" || (process.platform === "win32" && e instanceof Error && /ENOENT: launch object missing \(Win32 2\)/u.test(e.message))) return false; throw e; }
  }
  async cancel(): Promise<void> { const state = await this.read(); if (["completed", "cancelled", "blocked"].includes(state.status)) throw Error("queue already terminal"); await protectedWrite(path.join(this.root, "cancel.json"), Buffer.from(JSON.stringify({ queueId: state.queueId, nonce: randomUUID() }))); }
}
/** No merge, CI, source advancement or retry: completion is one published PR. */
export async function runSimpleQueue(input: { readonly store: SimpleQueueStore; readonly seal: SimpleQueueSeal; readonly run: (ticketId: string, digest: string, signal: AbortSignal, onReserved: (runId: string) => Promise<void>) => Promise<PersonalRunState>; readonly onReady?: () => void; readonly requireInitial?: boolean; readonly preclaimed?: boolean }): Promise<SimpleQueueState> {
  const { store, seal } = input, tickets = seal.attestation.approved;
  if (!input.preclaimed) await store.claim();
  const initial: SimpleQueueState = { version: 1, queueId: seal.queueId, tickets: tickets.map(t => t.ticketId), index: 0, status: "queued", runId: null, prs: [], error: null };
  let state: SimpleQueueState;
  try {
    state = await store.read();
    if (JSON.stringify(state) !== JSON.stringify(initial)) throw Error("queue launch state differs from approved tickets");
  } catch (error) {
    if (input.requireInitial || ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(process.platform === "win32" && error instanceof Error && /ENOENT: launch object missing \(Win32 2\)/u.test(error.message)))) throw error;
    state = initial;
    await store.write(state, true);
  }
  input.onReady?.();
  const move = async (patch: Partial<SimpleQueueState>) => { state = { ...state, ...patch, version: state.version + 1 }; await store.write(state); };
  try {
    for (const [index, approved] of tickets.entries()) {
      if (await store.cancelled()) { await move({ status: "cancelled" }); return state; }
      // Persist which ticket is about to run before constructing its controller.
      await move({ status: "running", index, runId: null });
      const abort = new AbortController();
      const watcher = fsWatch(store.root);
      const onChange = () => { void store.cancelled().then(cancel => { if (cancel) abort.abort(Error("queue cancelled")); }).catch(error => abort.abort(error)); };
      watcher.on("change", onChange); watcher.on("error", error => abort.abort(error));
      try {
        if (await store.cancelled()) { await move({ status: "cancelled" }); return state; }
        const result = await input.run(approved.ticketId, approved.contractSha256, abort.signal, async runId => { await move({ runId }); });
        if (result.status !== "completed" || result.ticketId !== approved.ticketId || !result.prUrl || result.publicationState !== "published") throw Error("ticket did not publish a verified PR");
        // PR publication is a durable fact even when cancellation races with
        // the controller's successful return. Never dispatch the next ticket.
        await move({ status: "queued", index: index + 1, runId: result.runId, prs: [...state.prs, result.prUrl] });
        if (abort.signal.aborted) {
          if (await store.cancelled()) { await move({ status: "cancelled" }); return state; }
          throw abort.signal.reason;
        }
      } finally { watcher.close(); }
    }
    if (await store.cancelled()) { await move({ status: "cancelled", runId: null }); return state; }
    await move({ status: "completed", runId: null });
    return state;
  } catch (error) {
    // A cancellation request is not proof that a running Squire attempt
    // stopped safely; errors remain blocked for manual run/PR inspection.
    await move({ status: "blocked", error: error instanceof Error ? error.message.slice(0, 500) : "queue run failed" });
    return state;
  }
}
