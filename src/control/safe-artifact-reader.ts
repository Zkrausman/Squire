import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ArtifactReference, ContractReference } from "./domain.js";

export type DigestReference = Pick<ArtifactReference, "path" | "sha256"> | Pick<ContractReference, "path" | "sha256">;
export class ArtifactReadError extends Error { constructor(message: string) { super(message); this.name = "ArtifactReadError"; } }

export interface ImmutableArtifactReader { readExact(reference: DigestReference): Promise<Buffer> }

export class SafeArtifactReader implements ImmutableArtifactReader {
  constructor(readonly ticketRoot = "/ticket", readonly maxBytes = 16 * 1024 * 1024) {}
  async readExact(reference: DigestReference): Promise<Buffer> {
    if (!/^(artifacts|evidence)\/(?!.*(?:^|\/)\.\.?\/)\S+$/.test(reference.path) || path.posix.normalize(reference.path) !== reference.path || path.isAbsolute(reference.path)) throw new ArtifactReadError("non-canonical artifact path");
    const rootName = reference.path.split("/", 1)[0];
    if (rootName !== "artifacts" && rootName !== "evidence") throw new ArtifactReadError("artifact root is not allowed");
    const root = path.join(this.ticketRoot, rootName);
    const target = path.join(this.ticketRoot, ...reference.path.split("/"));
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(root); } catch { throw new ArtifactReadError("artifact root is missing"); }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw new ArtifactReadError("artifact is missing or a symlink"); });
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ArtifactReadError("artifact is not a regular file");
      if (before.size > this.maxBytes) throw new ArtifactReadError("artifact exceeds size limit");
      const canonical = await realpath(target);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new ArtifactReadError("artifact escapes trusted root");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ArtifactReadError("artifact changed during read");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== reference.sha256) throw new ArtifactReadError("artifact digest mismatch");
      return bytes;
    } finally { await handle.close(); }
  }
}
