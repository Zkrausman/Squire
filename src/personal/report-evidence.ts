import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { windowsLaunch } from "./windows-launch.js";

export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export interface ReportEvidence {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  /** Filesystem identity from exclusive creation, checked again by exact read. */
  readonly identity: string;
}
export interface ReportEvidencePort {
  write(content: string | Buffer): Promise<ReportEvidence>;
  preflight?(): Promise<void>;
  release?(): Promise<void>;
  read(ref: ReportEvidence): Promise<Buffer>;
}
export function reportHash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
export function validateEvidenceRef(ref: ReportEvidence): void {
  if (!ref || Object.keys(ref).sort().join() !== "byteLength,identity,path,sha256" || typeof ref.path !== "string" || ref.path.length > 1024 || !/^[a-f0-9]{64}$/u.test(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > MAX_REPORT_BYTES || typeof ref.identity !== "string" || !/^[0-9:]{1,200}$/u.test(ref.identity)) throw new Error("invalid report evidence reference");
}
/** Controller calls this even when an adapter claims its capture was verified. */
export async function verifyReportEvidence(port: ReportEvidencePort, ref: ReportEvidence, content?: string | Buffer): Promise<Buffer> {
  validateEvidenceRef(ref);
  const expected = content === undefined ? undefined : Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const actual = await port.read(structuredClone(ref));
  if (!Buffer.isBuffer(actual) || actual.length > MAX_REPORT_BYTES || actual.length !== ref.byteLength || reportHash(actual) !== ref.sha256 || (expected !== undefined && !actual.equals(expected))) throw new Error("report evidence bytes/content/length/digest mismatch");
  return actual;
}
function identity(s: BigIntStats): string { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }

/** Linux fd-relative evidence backend. */
export class FileReportEvidence implements ReportEvidencePort {
  readonly root: string;
  constructor(root: string, readonly options: { readonly afterRead?: () => Promise<void> } = {}) { this.root = path.resolve(root); }
  async #directory(create = false) {
    if (process.platform !== "linux") throw new Error("safe report evidence requires Linux fd-relative reads");
    if (await realpath(path.dirname(this.root)) !== path.dirname(this.root)) throw new Error("unsafe report evidence ancestor");
    for (let cursor = path.dirname(this.root); ; cursor = path.dirname(cursor)) {
      const ancestor = await lstat(cursor, { bigint: true });
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || (ancestor.uid !== 0n && ancestor.uid !== BigInt(process.getuid!())) || ((ancestor.mode & 0o022n) && !(ancestor.mode & 0o1000n))) throw new Error("unsafe report evidence ancestor");
      if (path.dirname(cursor) === cursor) break;
    }
    if (create) await mkdir(this.root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    if (await realpath(this.root) !== this.root) throw new Error("unsafe report evidence ancestor");
    const before = await lstat(this.root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077n) || before.uid !== BigInt(process.getuid!())) throw new Error("unsafe report evidence directory");
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinned = await handle.stat({ bigint: true });
    if (before.dev !== pinned.dev || before.ino !== pinned.ino) { await handle.close(); throw new Error("report evidence directory replaced"); }
    return handle;
  }
  async preflight(): Promise<void> {
    const directory = await this.#directory(true);
    try { await lstat(`/proc/self/fd/${directory.fd}/.`); } finally { await directory.close(); }
  }
  async write(content: string | Buffer): Promise<ReportEvidence> {
    const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
    if (bytes.length > MAX_REPORT_BYTES) throw new Error("report evidence exceeds size bound");
    const directory = await this.#directory(true);
    try {
      const name = `${randomUUID()}.json`;
      const handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      try {
        await handle.writeFile(bytes); await handle.sync();
        return { path: path.join(this.root, name), sha256: reportHash(bytes), byteLength: bytes.length, identity: identity(await handle.stat({ bigint: true })) };
      } finally { await handle.close(); }
    } finally { await directory.close(); }
  }
  async read(ref: ReportEvidence): Promise<Buffer> {
    validateEvidenceRef(ref);
    if (path.dirname(ref.path) !== this.root || !/^[a-f0-9-]{36}\.json$/u.test(path.basename(ref.path)) || path.resolve(ref.path) !== ref.path) throw new Error("unsafe report evidence path");
    const directory = await this.#directory();
    try {
      const pinnedPath = `/proc/self/fd/${directory.fd}/${path.basename(ref.path)}`;
      const handle = await open(pinnedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o377n) || before.size > BigInt(MAX_REPORT_BYTES) || identity(before) !== ref.identity) throw new Error("unsafe or replaced report evidence file");
        const bytes = Buffer.alloc(ref.byteLength + 1);
        let used = 0;
        while (used < bytes.length) {
          const read = await handle.read(bytes, used, bytes.length - used, used);
          if (!read.bytesRead) break;
          used += read.bytesRead;
        }
        await this.options.afterRead?.();
        const after = await handle.stat({ bigint: true });
        const named = await lstat(pinnedPath, { bigint: true });
        const root = await lstat(this.root, { bigint: true });
        const pinned = await directory.stat({ bigint: true });
        if (identity(before) !== identity(after) || identity(after) !== identity(named) || root.dev !== pinned.dev || root.ino !== pinned.ino || await realpath(this.root) !== this.root || used !== ref.byteLength) throw new Error("report evidence changed during exact read");
        return bytes.subarray(0, used);
      } finally { await handle.close(); }
    } finally { await directory.close(); }
  }
}

/** Decode only AFTER preserving and independently verifying the artifact. */
export function decodeReport(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Native Windows uses the very same reference/hash/length protocol as Linux. */
export class WindowsReportEvidence implements ReportEvidencePort {
  readonly root: string;
  readonly #leases = new Map<string, { lease: object; identity: string }>();
  constructor(root: string) { this.root = path.resolve(root); }
  #native() {
    const native = windowsLaunch();
    if (typeof native.openReport !== "function" || typeof native.readReport !== "function" || typeof native.closeReport !== "function")
      throw new Error("Windows report evidence native capability unavailable; rebuild with npm ci and npm run build (Visual Studio C++ tools required); no unsafe fallback");
    return native;
  }
  async preflight(): Promise<void> {
    this.#native();
    // Exercises filesystem, ACL, owner, containment and exact-read capability,
    // not merely addon availability. The probe is a distinct private artifact.
    const ref = await this.write(Buffer.alloc(0));
    try { await verifyReportEvidence(this, ref, Buffer.alloc(0)); }
    finally { this.#native().closeReport(this.#leases.get(ref.path)!.lease); this.#leases.delete(ref.path); }
  }
  async write(content: string | Buffer): Promise<ReportEvidence> {
    const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
    if (bytes.length > MAX_REPORT_BYTES) throw new Error("report evidence exceeds size bound");
    const file = path.join(this.root, `${randomUUID()}.json`);
    const held = this.#native().openReport(file, bytes);
    this.#leases.set(file, held);
    const ref = { path: file, identity: held.identity, byteLength: bytes.length, sha256: reportHash(bytes) };
    await verifyReportEvidence(this, ref, bytes);
    return ref;
  }
  async read(ref: ReportEvidence): Promise<Buffer> {
    validateEvidenceRef(ref);
    if (path.dirname(ref.path) !== this.root || path.resolve(ref.path) !== ref.path || !/^[a-f0-9-]{36}\.json$/u.test(path.basename(ref.path))) throw new Error("unsafe report evidence path");
    const native = this.#native();
    let held = this.#leases.get(ref.path);
    if (!held) { held = native.openReport(ref.path); this.#leases.set(ref.path, held); }
    if (held.identity !== ref.identity) throw new Error("report evidence identity mismatch");
    const bytes = native.readReport(held.lease);
    if (bytes.length !== ref.byteLength || reportHash(bytes) !== ref.sha256) throw new Error("report evidence length/digest mismatch");
    return bytes;
  }
  async release(): Promise<void> {
    if (!this.#leases.size) return;
    const native = this.#native();
    for (const held of this.#leases.values()) native.closeReport(held.lease);
    this.#leases.clear();
  }
}
export function createReportEvidence(root: string): ReportEvidencePort {
  if (process.platform === "win32") return new WindowsReportEvidence(root);
  if (process.platform === "linux") return new FileReportEvidence(root);
  throw new Error("Report evidence requires Linux fd-relative storage or Windows native NTFS security support; unsupported controller platform");
}
