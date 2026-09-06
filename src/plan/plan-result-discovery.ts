import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import { PHASE_RESULT_SCHEMA_ID } from "./domain.js";

export class PlanResultDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanResultDiscoveryError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertDirectoryChain(root: string, targetDirectory: string): Promise<void> {
  const relative = path.relative(root, targetDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new PlanResultDiscoveryError("Plan result path escaped ticket root");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PlanResultDiscoveryError("Plan result parent is not a real directory");
  }
}

export class PlanResultDiscovery {
  readonly #ticketRoot: string;
  constructor(ticketRoot = "/ticket") {
    if (!path.isAbsolute(ticketRoot) || ticketRoot.includes("\u0000")) throw new PlanResultDiscoveryError("Plan ticket root is unsafe");
    this.#ticketRoot = path.resolve(ticketRoot);
  }

  async discover(attempt: number): Promise<ContractReference | undefined> {
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new PlanResultDiscoveryError("Plan attempt is invalid");
    const relative = `artifacts/plan/${attempt}/result.json`;
    const target = path.resolve(this.#ticketRoot, ...relative.split("/"));
    try {
      await assertDirectoryChain(this.#ticketRoot, path.dirname(target));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
    let info;
    try { info = await lstat(target); } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
      throw new PlanResultDiscoveryError("Plan result cannot be inspected", { cause: error });
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new PlanResultDiscoveryError("Plan result is not a regular private file");
    const bytes = await readFile(target);
    return { path: relative, sha256: digest(bytes), schemaId: PHASE_RESULT_SCHEMA_ID };
  }
}

export async function discoverPlanResult(attempt: number, ticketRoot = "/ticket"): Promise<ContractReference | undefined> {
  return new PlanResultDiscovery(ticketRoot).discover(attempt);
}
