import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ArtifactReference, ContractReference } from "./domain.js";

export type DigestReference = Pick<ArtifactReference, "path" | "sha256"> | Pick<ContractReference, "path" | "sha256">;
export class ArtifactReadError extends Error { constructor(message: string) { super(message); this.name = "ArtifactReadError"; } }

export interface ImmutableArtifactReader { readExact(reference: DigestReference): Promise<Buffer> }

export class SafeArtifactReader implements ImmutableArtifactReader {
  constructor(readonly ticketRoot = "/ticket", readonly maxBytes = 16 * 1024 * 1024) {}
  async readExact(reference: DigestReference): Promise<Buffer> {
    if (!/^(artifacts|evidence)\/(?!.*(?:^|\/)\.\.?\/)\S+$/.test(reference.path) || path.posix.normalize(reference.path) !== reference.path || path.isAbsolute(reference.path) || reference.path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(reference.path)) throw new ArtifactReadError("non-canonical artifact path");
    const rootName = reference.path.split("/", 1)[0];
    if (rootName !== "artifacts" && rootName !== "evidence") throw new ArtifactReadError("artifact root is not allowed");
    const root = path.join(this.ticketRoot, rootName);
    const target = path.join(this.ticketRoot, ...reference.path.split("/"));
    let canonicalRoot: string;
    try {
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ArtifactReadError("artifact root is not a trusted directory");
      canonicalRoot = await realpath(root);
      if (path.resolve(canonicalRoot) !== path.resolve(root)) throw new ArtifactReadError("artifact root has a symbolic-link ancestor");
    } catch (error) {
      if (error instanceof ArtifactReadError) throw error;
      throw new ArtifactReadError("artifact root is missing");
    }
    let component = root;
    for (const part of reference.path.split("/").slice(1, -1)) {
      component = path.join(component, part);
      const componentInfo = await lstat(component).catch(() => { throw new ArtifactReadError("artifact parent is missing"); });
      if (componentInfo.isSymbolicLink() || !componentInfo.isDirectory()) throw new ArtifactReadError("artifact parent is not a real directory");
    }
    if (constants.O_NOFOLLOW === undefined) throw new ArtifactReadError("secure no-follow artifact reads are unsupported on this platform");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new ArtifactReadError("artifact is missing or a symlink"); });
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ArtifactReadError("artifact is not a regular file");
      if (before.nlink !== 1) throw new ArtifactReadError("artifact is hardlinked");
      if (before.size > this.maxBytes) throw new ArtifactReadError("artifact exceeds size limit");
      const canonical = await realpath(target);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new ArtifactReadError("artifact escapes trusted root");
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < before.size) {
        const read = await handle.read(bytes, offset, before.size - offset, offset);
        if (read.bytesRead <= 0) throw new ArtifactReadError("artifact ended during bounded read");
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ArtifactReadError("artifact changed during read");
      const targetAfter = await lstat(target).catch(() => { throw new ArtifactReadError("artifact identity changed during read"); });
      if (targetAfter.dev !== after.dev || targetAfter.ino !== after.ino || targetAfter.mode !== after.mode || targetAfter.nlink !== after.nlink || targetAfter.size !== after.size || targetAfter.mtimeMs !== after.mtimeMs || targetAfter.ctimeMs !== after.ctimeMs || targetAfter.isSymbolicLink()) throw new ArtifactReadError("artifact identity changed during read");
      let currentAfter = root;
      for (const part of reference.path.split("/").slice(1, -1)) {
        currentAfter = path.join(currentAfter, part);
        const parentInfo = await lstat(currentAfter).catch(() => { throw new ArtifactReadError("artifact parent changed during read"); });
        if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new ArtifactReadError("artifact parent changed during read");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== reference.sha256) throw new ArtifactReadError("artifact digest mismatch");
      return bytes;
    } finally { await handle.close(); }
  }
}
