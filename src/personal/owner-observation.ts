import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { windowsLaunch } from "./windows-launch.js";

export interface OwnerFile { readonly bytes: string; readonly identity: string }
/** Bounded handle read. Never acquire the ticket mutation mutex. */
export async function observeOwnerFile(file: string): Promise<OwnerFile | undefined> {
  if (process.platform === "win32") return windowsLaunch().observeOwnerFile(path.resolve(file));
  let handle;
  try {
    // Reject symlink ancestors as well as the leaf.
    let ancestor = path.dirname(path.resolve(file));
    for (;;) {
      const metadata = await lstat(ancestor);
      if (!metadata.isDirectory()) throw new Error("owner ancestor is not a directory");
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 8192n) throw new Error("owner record is not bounded regular data");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (BigInt(bytesRead) !== before.size || after.size !== before.size || before.mtimeNs !== after.mtimeNs ||
        !current.isFile() || current.dev !== before.dev || current.ino !== before.ino) throw new Error("owner record changed");
    return { bytes: buffer.subarray(0, bytesRead).toString("utf8"), identity: `${before.dev}:${before.ino}:${before.birthtimeNs}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

export async function ownerProcessIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) throw new Error("invalid owner PID");
  if (process.platform === "win32") return windowsLaunch().ownerProcessIdentity(pid);
  if (process.platform !== "linux") throw new Error("native owner observation unsupported");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X" || !/^\d+$/u.test(fields[19] ?? "")) throw new Error("owner process not live");
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  return `${boot}:${fields[19]}`;
}

export interface OperationEvidence {
  readonly version: 1;
  readonly ticketId: string;
  readonly token: string;
  readonly operationReservationIdentity: string | null;
  readonly pid: number;
  readonly processIdentity: string;
}
export function parseOperation(bytes: string, ticketId: string): OperationEvidence {
  const value = JSON.parse(bytes) as OperationEvidence;
  if (!value || Object.keys(value).sort().join(",") !== "operationReservationIdentity,pid,processIdentity,ticketId,token,version" || value.version !== 1 ||
      (value.operationReservationIdentity !== null && (typeof value.operationReservationIdentity !== "string" || !/^[0-9:]{3,128}$/u.test(value.operationReservationIdentity))) ||
      value.ticketId !== ticketId || !/^[a-f0-9-]{36}$/u.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.processIdentity !== "string" || !/^[a-z0-9:-]{3,128}$/u.test(value.processIdentity)) throw new Error("invalid operation evidence");
  return value;
}
