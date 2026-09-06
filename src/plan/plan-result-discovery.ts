import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import { PHASE_RESULT_SCHEMA_ID } from "./domain.js";

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export class PlanResultDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanResultDiscoveryError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

async function assertDirectoryChain(root: string, targetDirectory: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PlanResultDiscoveryError("Plan ticket root is not a real directory");
  const relative = path.relative(root, targetDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new PlanResultDiscoveryError("Plan result path escaped ticket root");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (!part || part === "." || part === ".." || CONTROL_CHARACTER.test(part)) throw new PlanResultDiscoveryError("Plan result parent path is unsafe");
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new PlanResultDiscoveryError("Plan result parent is not a private real directory");
  }
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = await realpath(targetDirectory);
  if (canonicalDirectory !== canonicalRoot && !canonicalDirectory.startsWith(`${canonicalRoot}${path.sep}`)) throw new PlanResultDiscoveryError("Plan result parent escaped ticket root");
}

function sameStat(left: Awaited<ReturnType<import("node:fs/promises").FileHandle["stat"]>>, right: Awaited<ReturnType<import("node:fs/promises").FileHandle["stat"]>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export class PlanResultDiscovery {
  readonly #ticketRoot: string;
  constructor(ticketRoot = "/ticket") {
    if (!path.isAbsolute(ticketRoot) || ticketRoot.includes("\u0000") || CONTROL_CHARACTER.test(ticketRoot)) throw new PlanResultDiscoveryError("Plan ticket root is unsafe");
    this.#ticketRoot = path.resolve(ticketRoot);
  }

  async discover(attempt: number): Promise<ContractReference | undefined> {
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new PlanResultDiscoveryError("Plan attempt is invalid");
    const relative = `artifacts/plan/${attempt}/result.json`;
    const target = path.resolve(this.#ticketRoot, ...relative.split("/"));
    try {
      await assertDirectoryChain(this.#ticketRoot, path.dirname(target));
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (constants.O_NOFOLLOW === undefined) throw new PlanResultDiscoveryError("secure Plan result reads are unsupported on this platform");
    let handle;
    try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw new PlanResultDiscoveryError("Plan result cannot be opened safely", { cause: error });
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > MAX_RESULT_BYTES) throw new PlanResultDiscoveryError("Plan result is not a bounded regular private file");
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead <= 0) throw new PlanResultDiscoveryError("Plan result ended during read");
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (!sameStat(before, after)) throw new PlanResultDiscoveryError("Plan result changed during read");
      const canonicalRoot = await realpath(this.#ticketRoot);
      const canonicalTarget = await realpath(target);
      if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) throw new PlanResultDiscoveryError("Plan result escaped ticket root");
      const targetAfter = await lstat(target);
      if (!sameStat(after, targetAfter)) throw new PlanResultDiscoveryError("Plan result identity changed during discovery");
      await assertDirectoryChain(this.#ticketRoot, path.dirname(target));
      return { path: relative, sha256: digest(bytes), schemaId: PHASE_RESULT_SCHEMA_ID };
    } finally { await handle.close(); }
  }
}

export async function discoverPlanResult(attempt: number, ticketRoot = "/ticket"): Promise<ContractReference | undefined> {
  return new PlanResultDiscovery(ticketRoot).discover(attempt);
}
