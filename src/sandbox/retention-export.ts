import type { SandboxTransferManifestDocument } from "./domain.js";
import { MAX_TRANSFER_BYTES, type SandboxTransferContext, type SandboxTransferService, type TransferResult } from "./transfer-service.js";
import { assertCanonicalSandboxPath, assertSha256 } from "./identity.js";

export interface RetainedSandboxFile {
  readonly name: string;
  readonly sourcePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly expectedGit?: SandboxTransferManifestDocument["expectedGit"];
}
export interface RetentionExportResult { readonly files: readonly TransferResult[] }
export class RetentionExportError extends Error { constructor(message: string) { super(message); this.name = "RetentionExportError"; } }

/** Exports the immutable AIDEV-222/AIDEV-228 retention set through the
 * controller transfer service. It has no bridge or publication credential
 * input and rejects duplicate names before the first side effect. */
export class SandboxRetentionExporter {
  readonly #transfer: SandboxTransferService;
  readonly #maxAggregateBytes: number;
  constructor(transfer: SandboxTransferService, options: { readonly maxAggregateBytes?: number } = {}) { if (!transfer || typeof transfer.exportFile !== "function" || !options || typeof options !== "object" || Array.isArray(options)) throw new RetentionExportError("retention exporter requires its transfer authority"); this.#transfer = transfer; this.#maxAggregateBytes = options.maxAggregateBytes ?? MAX_TRANSFER_BYTES; if (!Number.isSafeInteger(this.#maxAggregateBytes) || this.#maxAggregateBytes <= 0 || this.#maxAggregateBytes > 4 * MAX_TRANSFER_BYTES) throw new RetentionExportError("retention aggregate byte limit is invalid"); }
  async export(context: SandboxTransferContext, files: readonly RetainedSandboxFile[], signal?: AbortSignal): Promise<RetentionExportResult> {
    if (signal?.aborted) throw new RetentionExportError("retention export was aborted");
    if (!this.#transfer.retentionConfigured) throw new RetentionExportError("durable retention acknowledgement is required before export");
    if (!Array.isArray(files) || files.length === 0 || files.length > 256 || files.some(file => !file || typeof file !== "object" || typeof file.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(file.name) || file.name === "." || file.name === "..") || new Set(files.map(file => file.name)).size !== files.length) throw new RetentionExportError("retention export set is empty, unsafe, or has duplicate names");
    let aggregate = 0;
    for (const file of files) {
      try { assertCanonicalSandboxPath(file.sourcePath, "retention source path"); assertSha256(file.sha256, "retention source digest"); }
      catch (error) { throw new RetentionExportError(error instanceof Error ? error.message : "retention source identity is invalid"); }
      if (!file.sourcePath.startsWith("/ticket/artifacts/") && !file.sourcePath.startsWith("/ticket/evidence/") && !file.sourcePath.startsWith("/ticket/sessions/")) throw new RetentionExportError("retention source is outside the closed roots");
      if (!Number.isSafeInteger(file.byteLength) || file.byteLength <= 0 || file.byteLength > MAX_TRANSFER_BYTES || file.byteLength > this.#maxAggregateBytes || aggregate > this.#maxAggregateBytes - file.byteLength) throw new RetentionExportError("retention source aggregate length exceeds its bound");
      assertRetentionExpectedGit(file.expectedGit, context.runId);
      aggregate += file.byteLength;
    }
    const results: TransferResult[] = [];
    for (const file of files) results.push(await this.#transfer.exportFile(context, file.sourcePath, file.name, { byteLength: file.byteLength, sha256: file.sha256, ...(file.expectedGit ? { expectedGit: file.expectedGit } : {}) }, signal));
    return { files: Object.freeze(results) };
  }
}

function assertRetentionExpectedGit(value: SandboxTransferManifestDocument["expectedGit"] | undefined, runId: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new RetentionExportError("retention Git binding is not closed");
  const keys = Object.keys(value).sort().join("\0");
  if (!["baseSha\0objectFormat", "baseSha\0bundle\0objectFormat", "baseSha\0objectFormat\0repository", "baseSha\0bundle\0objectFormat\0repository"].includes(keys)) throw new RetentionExportError("retention Git binding is not closed");
  if (value.objectFormat !== "sha1" && value.objectFormat !== "sha256") throw new RetentionExportError("retention Git object format is invalid");
  const length = value.objectFormat === "sha1" ? 40 : 64;
  if (typeof value.baseSha !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value.baseSha)) throw new RetentionExportError("retention Git base identity is invalid");
  if (value.repository !== undefined && value.repository !== "/ticket/git/repo.git") throw new RetentionExportError("retention Git repository identity is not fixed");
  if (value.bundle !== undefined && (!value.bundle.startsWith(`artifacts/git/${runId}/`) || !new RegExp(`^[0-9a-f]{${length}}\\.bundle$`, "u").test(value.bundle.slice(`artifacts/git/${runId}/`.length)))) throw new RetentionExportError("retention Git bundle path is not bound to the run");
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
