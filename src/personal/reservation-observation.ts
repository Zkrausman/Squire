/** Read-only diagnostic protocol, deliberately separate from mutation authority. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { windowsLaunch } from "./windows-launch.js";
import type { ReservationObservation } from "./types.js";

const MAX_BYTES = 8192;
export interface OwnerEvidence {
  version: 1;
  role: "reserver" | "controller";
  ticketId: string;
  runId: string;
  fence: string;
  pid: number;
  process: string;
  reservation: string;
  identity: string;
}
export function evidencePath(directory: string, ticket: string): string {
  return path.join(directory, "owner-observations", `${ticket.toLowerCase()}.owner`);
}
export async function fileIdentity(handle: FileHandle): Promise<string> {
  if (process.platform === "win32") return windowsLaunch().observationFileIdentity(handle.fd);
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error("nonregular evidence");
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

// Keep the opened process object until all files have been revalidated. Linux
// proc-directory references cannot be rebound to a reused PID. Boot ID + start
// ticks exclude process reuse across observations and reboots.
async function processReference(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid PID");
  if (process.platform === "win32") {
    const native = windowsLaunch();
    const lease = native.openObservationProcess(pid);
    return { read: async () => native.readObservationProcess(lease), close: async () => native.closeObservationProcess(lease) };
  }
  if (process.platform !== "linux") throw new Error("unsupported process observation");
  const handle = await open(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return {
    read: async () => {
      const raw = await readFile(`/proc/self/fd/${handle.fd}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (!fields[0] || ["Z", "X", "x"].includes(fields[0]) || !/^\d+$/u.test(fields[19] ?? "")) throw new Error("owner not live");
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!/^[a-f0-9-]{36}$/u.test(boot)) throw new Error("invalid boot identity");
      return `${boot}:${fields[19]}`;
    },
    close: async () => handle.close(),
  };
}
export async function currentProcessIdentity(): Promise<string> {
  const reference = await processReference(process.pid);
  try { return await reference.read(); } finally { await reference.close(); }
}

async function regularPath(file: string): Promise<void> {
  // Reject symlink/reparse ancestors as well as a nonregular leaf. Identity is
  // checked again through a new pathname open while the original stays pinned.
  let ancestor = path.dirname(path.resolve(file));
  for (;;) {
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("nonregular evidence ancestor");
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!(await lstat(file)).isFile()) throw new Error("nonregular evidence");
}
async function bytes(handle: FileHandle): Promise<string> {
  const stat = await handle.stat();
  if (stat.size < 1 || stat.size > MAX_BYTES) throw new Error("invalid evidence size");
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  const result = await handle.read(buffer, 0, buffer.length, 0);
  if (result.bytesRead !== stat.size) throw new Error("changed evidence size");
  return buffer.subarray(0, result.bytesRead).toString("utf8");
}
async function snapshot(file: string) {
  await regularPath(file);
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW) | (process.platform === "linux" ? constants.O_NONBLOCK : 0));
  try {
    const identity = await fileIdentity(handle);
    const raw = await bytes(handle);
    return { file, handle, identity, raw, close: () => handle.close(), check: async () => {
      const next = await snapshot(file);
      try {
        if (next.identity !== identity || next.raw !== raw || await fileIdentity(handle) !== identity || await bytes(handle) !== raw) throw new Error("evidence replaced or changed");
      } finally { await next.close(); }
    } };
  } catch (error) { await handle.close(); throw error; }
}
async function optionalSnapshot(file: string) {
  try { return await snapshot(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function parseOwner(raw: string): OwnerEvidence {
  const e = JSON.parse(raw) as OwnerEvidence;
  if ((raw !== JSON.stringify(e) && raw !== `${JSON.stringify(e)}\n`) || !e || Object.keys(e).sort().join(",") !== "fence,identity,pid,process,reservation,role,runId,ticketId,version" || e.version !== 1 || !["reserver", "controller"].includes(e.role) ||
      !/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(e.ticketId) || typeof e.runId !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(e.runId) ||
      !e.runId.startsWith(`${e.ticketId.toLowerCase()}-`) || !/^[a-f0-9-]{36}$/u.test(e.fence) || !Number.isSafeInteger(e.pid) || e.pid < 1 ||
      [e.process, e.reservation, e.identity].some(v => typeof v !== "string" || !/^[a-f0-9:-]{1,200}$/u.test(v))) throw new Error("malformed owner evidence");
  return e;
}

/** Owner-side publication only, within the existing ticket-operation boundary. */
export async function publishOwner(directory: string, ticketId: string, runId: string, reservationPath: string, role: OwnerEvidence["role"]): Promise<void> {
  const reservation = await snapshot(reservationPath);
  const target = evidencePath(directory, ticketId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    if (reservation.raw !== `${runId}\n`) throw new Error("observation reservation mismatch");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    handle = await open(temporary, "wx", 0o600);
    const evidence: OwnerEvidence = { version: 1, role, ticketId, runId, fence: randomUUID(), pid: process.pid,
      process: await currentProcessIdentity(), reservation: reservation.identity, identity: await fileIdentity(handle) };
    await handle.writeFile(`${JSON.stringify(evidence)}\n`);
    await handle.sync();
    await reservation.check();
    await handle.close(); handle = undefined;
    if (process.platform === "win32" && await lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
      // A shared observer may pin the old evidence during handoff. Use the
      // same exact native replacement primitive as state, not legacy rename.
      windowsLaunch().replaceState(path.resolve(temporary), path.resolve(target));
    } else {
      await rename(temporary, target);
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    await reservation.close();
  }
}
export async function removeOwner(directory: string, ticketId: string, runId: string): Promise<void> {
  const record = await optionalSnapshot(evidencePath(directory, ticketId));
  if (!record) return;
  try {
    const owner = parseOwner(record.raw);
    if (owner.ticketId !== ticketId || owner.runId !== runId || owner.identity !== record.identity) return;
    await record.check();
    await unlink(record.file);
  } finally { await record.close(); }
}

/** Bind an operation marker to current observation evidence, not authorization. */
export async function operationEvidence(directory: string, ticketId: string): Promise<OwnerEvidence | null> {
  try {
    const record = await snapshot(evidencePath(directory, ticketId));
    try {
      const owner = parseOwner(record.raw);
      return owner.identity === record.identity && owner.ticketId === ticketId ? owner : null;
    } finally { await record.close(); }
  } catch { return null; }
}

export interface ObservationOptions {
  /** Internal deterministic race seam, after references are retained. */
  afterSnapshot?: () => Promise<void>;
}
export async function observeReservation(directory: string, ticketId: string, options: ObservationOptions = {}): Promise<ReservationObservation> {
  const held: Awaited<ReturnType<typeof snapshot>>[] = [];
  let reference: Awaited<ReturnType<typeof processReference>> | undefined;
  let reason: "unreadable" | "inconsistent" | "owner-not-live" = "unreadable";
  try {
    const paths = [path.join(directory, "locks", `${ticketId.toLowerCase()}.lock`), evidencePath(directory, ticketId), path.join(directory, "ticket-operations", `${ticketId.toLowerCase()}.lock`)];
    const records = [];
    for (const file of paths) {
      const record = await optionalSnapshot(file);
      records.push(record);
      if (record) held.push(record);
    }
    const [reservation, record, operation] = records;
    reason = "inconsistent";
    if (!reservation && !record && !operation) {
      await options.afterSnapshot?.();
      for (const file of paths) { const next = await optionalSnapshot(file); if (next) { await next.close(); throw new Error("ownership appeared"); } }
      return { kind: "absent" };
    }
    if (!reservation || !record) throw new Error("incomplete owner evidence");
    const owner = parseOwner(record.raw);
    if (owner.ticketId !== ticketId || owner.identity !== record.identity || owner.reservation !== reservation.identity || reservation.raw !== `${owner.runId}\n`) throw new Error("contradictory owner evidence");
    if (operation) {
      const marker = JSON.parse(operation.raw);
      if ((operation.raw !== JSON.stringify(marker) && operation.raw !== `${JSON.stringify(marker)}\n`) || !marker || Object.keys(marker).sort().join(",") !== "identity,owner,pid,process,ticketId,token,version" || marker.version !== 1 || marker.ticketId !== ticketId || marker.pid !== owner.pid || marker.process !== owner.process ||
          marker.identity !== operation.identity || typeof marker.token !== "string" || !/^[a-f0-9-]{36}$/u.test(marker.token) ||
          JSON.stringify(marker.owner) !== JSON.stringify(owner)) throw new Error("contradictory operation marker");
    }
    reason = "owner-not-live";
    reference = await processReference(owner.pid);
    if (await reference.read() !== owner.process) throw new Error("process identity mismatch");
    await options.afterSnapshot?.();
    reason = "inconsistent";
    for (const record of held) await record.check();
    if (!operation) { const next = await optionalSnapshot(paths[2]!); if (next) { await next.close(); throw new Error("operation appeared"); } }
    reason = "owner-not-live";
    if (await reference.read() !== owner.process) throw new Error("process identity changed");
    return { kind: "owner", runId: owner.runId, pid: owner.pid, role: owner.role, generation: `${owner.fence}/${record.identity}/${operation?.identity ?? "absent"}/${operation?.raw ?? ""}` };
  } catch { return { kind: "ambiguous", reason }; }
  finally { await reference?.close(); await Promise.all(held.map(record => record.close())); }
}
